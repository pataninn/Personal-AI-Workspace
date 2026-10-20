import { randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';

import { projectFactVerificationStatus } from '@/modules/memory/domain/project-fact';
import { WORKSPACE_EXPORT_LIMITS } from '@/modules/workspace-exports/domain/workspace-export';
import type {
  BeginWorkspaceExportResult,
  IWorkspaceExportRepository,
  WorkspaceExportRecord
} from '@/modules/workspace-exports/repositories/workspace-export-repository';
import type {
  WorkspaceExportBuilderIdentity,
  WorkspaceExportDescriptor,
  WorkspaceExportFact,
  WorkspaceExportSchedule,
  WorkspaceExportSkill,
  WorkspaceExportSnapshot,
  WorkspaceExportTask,
  WorkspaceExportConversation
} from '@/modules/workspace-exports/domain/workspace-export';
import { AppError } from '@/shared/errors/app-error';

const MAX_SNAPSHOT_ROWS = 12_000;
const MAX_SNAPSHOT_SOURCE_BYTES = WORKSPACE_EXPORT_LIMITS.maxStructuredBytes;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface WorkspaceRow { readonly id: string; readonly name: string; readonly objective: string | null; readonly file_backed: boolean; }
interface TaskRow {
  readonly id: string; readonly title: string; readonly details: string | null; readonly status: string;
  readonly importance: string; readonly deadline: Date | string | null; readonly subtasks: unknown; readonly position: number;
  readonly version: number; readonly source_kind: 'user' | 'assistant_suggestion'; readonly source_accepted_at: Date | string | null;
  readonly created_at: Date | string; readonly updated_at: Date | string; readonly completed_at: Date | string | null;
}
interface FactRow {
  readonly id: string; readonly fact_key: string; readonly title: string; readonly content: string; readonly version: number;
  readonly verified_at: Date | string | null; readonly created_at: Date | string; readonly updated_at: Date | string;
}
interface ContextRow { readonly relative_paths: unknown; readonly fact_ids: unknown; readonly include_project_conversations: boolean; readonly excluded_paths: unknown; }
interface ConversationRow { readonly id: string; readonly title: string; readonly created_at: Date | string; readonly updated_at: Date | string; }
interface ProjectMessageRow {
  readonly conversation_id: string; readonly id: string; readonly sequence: number; readonly role: 'user' | 'assistant';
  readonly content: string; readonly created_at: Date | string;
}
interface HomeMessageRow extends ProjectMessageRow { readonly turn_id: string; }
interface SkillRow {
  readonly id: string; readonly title: string; readonly instructions: string; readonly declared_tools: unknown; readonly enabled: boolean;
  readonly version: number; readonly created_at: Date | string; readonly updated_at: Date | string;
}
interface ScheduleRow {
  readonly id: string; readonly conversation_id: string; readonly skill_id: string; readonly skill_version: number;
  readonly local_time: string; readonly time_zone: string; readonly enabled: boolean; readonly revision: number;
  readonly created_at: Date | string; readonly updated_at: Date | string;
}
interface SourceBoundsRow { readonly row_count: string | number; readonly content_bytes: string | number; }
interface ExportDbRow {
  readonly id: string; readonly owner_id: string; readonly workspace_id: string; readonly state: WorkspaceExportRecord['state'];
  readonly request_fingerprint: string; readonly demo_cleanup_generation: string | null; readonly builder_process_id: number | null;
  readonly builder_start_ticks: string | null; readonly created_at: Date | string; readonly expires_at: Date | string | null;
  readonly byte_count: number | string | null;
}
interface ExistingExportDbRow extends ExportDbRow { readonly database_now: Date | string; }

/** Owner-scoped repeatable-read projection plus the bounded artifact state machine. */
export class TypeOrmWorkspaceExportRepository implements IWorkspaceExportRepository {
  public constructor(private readonly dataSource: DataSource) {}

  public async begin(input: {
    readonly ownerId: string; readonly workspaceId: string; readonly keyDigest: string;
    readonly requestFingerprint: string; readonly builder: WorkspaceExportBuilderIdentity;
  }): Promise<BeginWorkspaceExportResult> {
    if (!UUID_PATTERN.test(input.ownerId) || !UUID_PATTERN.test(input.workspaceId)
      || !/^\d{1,20}$/u.test(input.builder.startTicks) || !Number.isSafeInteger(input.builder.processId)) throw workspaceUnavailable();
    return this.dataSource.transaction(async (manager) => {
      const workspace = await lockExportableWorkspace(manager, input.ownerId, input.workspaceId);
      const owner = await lockExportableOwner(manager, input.ownerId);
      const generation = await currentDemoCleanupGeneration(manager, input.ownerId);
      if (generation !== null) throw workspaceUnavailable();
      const removal = rows<{ readonly id: string }>(await manager.query(
        'SELECT "project_id" AS "id" FROM "project_removal_jobs" WHERE "owner_id"=$1 AND "project_id"=$2', [input.ownerId, input.workspaceId]
      ));
      if (removal.length > 0) throw workspaceUnavailable();
      const existing = rows<ExistingExportDbRow>(await manager.query(`SELECT *,clock_timestamp() AS "database_now" FROM "workspace_exports"
        WHERE "owner_id"=$1 AND "idempotency_key_digest"=$2 FOR UPDATE`, [input.ownerId, input.keyDigest]))[0];
      if (existing) return existingKeyResult(existing, input.requestFingerprint, input.workspaceId, new Date(existing.database_now));
      const count = rows<{ readonly active_count: string | number }>(await manager.query(`SELECT count(*) AS "active_count"
        FROM "workspace_exports" WHERE "owner_id"=$1 AND ("state"='building'
          OR ("state"='ready' AND "expires_at">clock_timestamp()))`, [input.ownerId]))[0];
      if (Number(count?.active_count ?? 0) >= WORKSPACE_EXPORT_LIMITS.maxActivePerOwner) throw limitReached();
      return this.insertBuilder(manager, input, workspace, owner, generation);
    });
  }

  public async captureSnapshot(ownerId: string, workspaceId: string): Promise<WorkspaceExportSnapshot> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction('REPEATABLE READ');
    let committed = false;
    try {
      await runner.query('SET TRANSACTION READ ONLY');
      const capturedAt = rows<{ readonly snapshot_at: Date | string }>(await runner.query(
        'SELECT transaction_timestamp() AS "snapshot_at"'))[0];
      const workspace = rows<WorkspaceRow>(await runner.query(`SELECT p."id",p."name",p."objective",
        (p."relative_root_key" IS NOT NULL) AS "file_backed"
        FROM "projects" p JOIN "users" u ON u."id"=p."owner_id"
        WHERE p."owner_id"=$1 AND p."id"=$2 AND p."status"='active' AND u."is_active"=true
          AND (u."expires_at" IS NULL OR u."expires_at">clock_timestamp())
          AND NOT EXISTS (SELECT 1 FROM "project_removal_jobs" j WHERE j."owner_id"=p."owner_id" AND j."project_id"=p."id")
          AND NOT EXISTS (SELECT 1 FROM "demo_expiry_cleanups" c JOIN "demo_admissions" a ON a."id"=c."admission_id" WHERE a."owner_id"=u."id")`,
      [ownerId, workspaceId]))[0];
      if (!workspace || !capturedAt) throw workspaceUnavailable();
      const bounds = rows<SourceBoundsRow>(await runner.query(snapshotBoundsSql(), [ownerId, workspaceId]))[0];
      if (!bounds || Number(bounds.row_count) > MAX_SNAPSHOT_ROWS || Number(bounds.content_bytes) > MAX_SNAPSHOT_SOURCE_BYTES) throw tooLarge();
      const snapshot = await this.readSnapshot(runner.manager, workspace, ownerId, workspaceId, dateTime(capturedAt.snapshot_at));
      await runner.commitTransaction();
      committed = true;
      return snapshot;
    } catch (error: unknown) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    } finally {
      if (!committed && runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }
  }

  public async publish(
    id: string, ownerId: string, workspaceId: string, generation: string | null, sizeBytes: number, deadlineAt: number
  ): Promise<WorkspaceExportDescriptor | null> {
    return this.dataSource.transaction(async (manager) => {
      const rowsChanged = rows<{ readonly expires_at: Date | string }>(await manager.query(`UPDATE "workspace_exports" e SET
        "state"='ready',"expires_at"=clock_timestamp()+interval '15 minutes',"byte_count"=$5,
        "builder_process_id"=NULL,"builder_start_ticks"=NULL
        WHERE e."id"=$1 AND e."owner_id"=$2 AND e."workspace_id"=$3 AND e."state"='building'
          AND e."demo_cleanup_generation" IS NOT DISTINCT FROM $4
          AND clock_timestamp() < to_timestamp($6::double precision / 1000.0)
          AND EXISTS (SELECT 1 FROM "users" u WHERE u."id"=e."owner_id" AND u."is_active"=true
            AND (u."expires_at" IS NULL OR u."expires_at">clock_timestamp()))
          AND EXISTS (SELECT 1 FROM "projects" p WHERE p."owner_id"=e."owner_id" AND p."id"=e."workspace_id" AND p."status"='active')
          AND NOT EXISTS (SELECT 1 FROM "project_removal_jobs" j WHERE j."owner_id"=e."owner_id" AND j."project_id"=e."workspace_id")
          AND NOT EXISTS (SELECT 1 FROM "demo_expiry_cleanups" c JOIN "demo_admissions" a ON a."id"=c."admission_id" WHERE a."owner_id"=e."owner_id")
        RETURNING e."expires_at"`, [id, ownerId, workspaceId, generation, sizeBytes, deadlineAt]));
      const published = rowsChanged[0];
      return published ? { id, workspaceId, sizeBytes, expiresAt: dateTime(published.expires_at) } : null;
    });
  }

  public async markFailed(id: string): Promise<void> {
    await this.dataSource.query(`UPDATE "workspace_exports" SET "state"='failed',"builder_process_id"=NULL,"builder_start_ticks"=NULL
      WHERE "id"=$1 AND "state"='building'`, [id]);
  }

  public async getDownload(ownerId: string, id: string): Promise<WorkspaceExportDescriptor | null> {
    const row = rows<ExportDbRow>(await this.dataSource.query(`SELECT e.* FROM "workspace_exports" e
      JOIN "projects" p ON p."owner_id"=e."owner_id" AND p."id"=e."workspace_id"
      JOIN "users" u ON u."id"=e."owner_id"
      WHERE e."id"=$1 AND e."owner_id"=$2 AND e."state"='ready' AND e."expires_at">clock_timestamp()
        AND e."demo_cleanup_generation" IS NULL AND p."status"='active' AND u."is_active"=true
        AND (u."expires_at" IS NULL OR u."expires_at">clock_timestamp())
        AND NOT EXISTS (SELECT 1 FROM "project_removal_jobs" j WHERE j."owner_id"=e."owner_id" AND j."project_id"=e."workspace_id")
        AND NOT EXISTS (SELECT 1 FROM "demo_expiry_cleanups" c JOIN "demo_admissions" a ON a."id"=c."admission_id" WHERE a."owner_id"=e."owner_id")`,
    [id, ownerId]))[0];
    return row ? descriptor(row) : null;
  }

  public async markUnavailable(id: string): Promise<void> {
    await this.dataSource.query(`UPDATE "workspace_exports" SET "state"='unavailable' WHERE "id"=$1 AND "state"='ready'`, [id]);
  }

  public async listForStartup(): Promise<readonly WorkspaceExportRecord[]> {
    return rows<ExportDbRow>(await this.dataSource.query('SELECT * FROM "workspace_exports" ORDER BY "created_at","id"')).map(toRecord);
  }

  public async markFailedIfBuilderMatches(id: string, builder: WorkspaceExportBuilderIdentity): Promise<boolean> {
    const result = rows<{ readonly id: string }>(await this.dataSource.query(`UPDATE "workspace_exports" SET
      "state"='failed',"builder_process_id"=NULL,"builder_start_ticks"=NULL
      WHERE "id"=$1 AND "state"='building' AND "builder_process_id"=$2 AND "builder_start_ticks"=$3
      RETURNING "id"`, [id, builder.processId, builder.startTicks]));
    return result.length === 1;
  }

  public async markExpired(id: string): Promise<boolean> {
    const result = rows<{ readonly id: string }>(await this.dataSource.query(`UPDATE "workspace_exports" SET "state"='expired'
      WHERE "id"=$1 AND "state"='ready' AND "expires_at"<=clock_timestamp() RETURNING "id"`, [id]));
    return result.length === 1;
  }

  public async deleteOldTombstones(before: Date): Promise<void> {
    await this.dataSource.query(`DELETE FROM "workspace_exports" WHERE "state"<>'building'
      AND COALESCE("expires_at","created_at")<$1`, [before]);
  }

  public async listByIds(ids: readonly string[]): Promise<readonly WorkspaceExportRecord[]> {
    if (ids.length === 0) return [];
    return rows<ExportDbRow>(await this.dataSource.query('SELECT * FROM "workspace_exports" WHERE "id"=ANY($1::uuid[])', [ids])).map(toRecord);
  }

  public async deleteTerminal(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const active = rows<{ readonly id: string }>(await this.dataSource.query(`SELECT "id" FROM "workspace_exports"
      WHERE "id"=ANY($1::uuid[]) AND "state"='building'`, [ids]));
    if (active.length > 0) throw new AppError('EXPORT_CLEANUP_PENDING', 503, 'Workspace export cleanup is still in progress.');
    await this.dataSource.query('DELETE FROM "workspace_exports" WHERE "id"=ANY($1::uuid[]) AND "state"<>\'building\'', [ids]);
  }

  private async insertBuilder(
    manager: EntityManager,
    input: { readonly ownerId: string; readonly workspaceId: string; readonly keyDigest: string; readonly requestFingerprint: string; readonly builder: WorkspaceExportBuilderIdentity },
    _workspace: { readonly id: string; readonly name: string; readonly objective: string | null },
    _owner: { readonly id: string },
    generation: string | null
  ): Promise<BeginWorkspaceExportResult> {
    const id = randomUUID();
    const row = rows<ExportDbRow>(await manager.query(`INSERT INTO "workspace_exports"
      ("id","owner_id","workspace_id","state","idempotency_key_digest","request_fingerprint","demo_cleanup_generation","builder_process_id","builder_start_ticks")
      VALUES ($1,$2,$3,'building',$4,$5,$6,$7,$8) RETURNING *`,
    [id, input.ownerId, input.workspaceId, input.keyDigest, input.requestFingerprint, generation, input.builder.processId, input.builder.startTicks]))[0];
    if (!row) throw workspaceUnavailable();
    return { kind: 'started', record: toRecord(row) };
  }

  private async readSnapshot(
    manager: EntityManager, workspace: WorkspaceRow, ownerId: string, workspaceId: string, capturedAt: string
  ): Promise<WorkspaceExportSnapshot> {
    const tasks = await this.readTasks(manager, ownerId, workspaceId);
    const facts = await this.readFacts(manager, ownerId, workspaceId);
    const context = await this.readContext(manager, ownerId, workspaceId);
    const projectConversations = await this.readProjectConversations(manager, ownerId, workspaceId);
    const homeConversations = await this.readHomeConversations(manager, ownerId, workspaceId);
    const skills = await this.readSkills(manager, ownerId, workspaceId);
    const schedules = await this.readSchedules(manager, ownerId, workspaceId);
    const snapshot: WorkspaceExportSnapshot = {
      workspace: { id: workspace.id, name: workspace.name, objective: workspace.objective },
      fileBacked: workspace.file_backed,
      databaseSnapshotAt: capturedAt,
      tasks, facts, context, projectConversations, homeConversations, skills, schedules
    };
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_SNAPSHOT_SOURCE_BYTES) throw tooLarge();
    return snapshot;
  }

  private async readTasks(manager: EntityManager, ownerId: string, workspaceId: string): Promise<readonly WorkspaceExportTask[]> {
    const taskRows = rows<TaskRow>(await manager.query(`SELECT "id","title","details","status","importance","deadline","subtasks","position","version","source_kind","source_accepted_at","created_at","updated_at","completed_at"
      FROM "project_tasks" WHERE "owner_id"=$1 AND "project_id"=$2 ORDER BY "position","id" LIMIT $3`,
    [ownerId, workspaceId, MAX_SNAPSHOT_ROWS + 1]));
    if (taskRows.length > MAX_SNAPSHOT_ROWS) throw tooLarge();
    return taskRows.map((row) => ({
      id: row.id, title: row.title, details: row.details, status: row.status, importance: row.importance,
      deadline: row.deadline === null ? null : dateOnly(row.deadline), subtasks: parseSubtasks(row.subtasks),
      position: row.position, version: row.version,
      source: { kind: row.source_kind, label: row.source_kind === 'user' ? 'Added by you' : 'Added from an assistant suggestion · accepted by you',
        acceptedAt: row.source_accepted_at === null ? null : dateTime(row.source_accepted_at) },
      createdAt: dateTime(row.created_at), updatedAt: dateTime(row.updated_at),
      completedAt: row.completed_at === null ? null : dateTime(row.completed_at)
    }));
  }

  private async readFacts(manager: EntityManager, ownerId: string, workspaceId: string): Promise<readonly WorkspaceExportFact[]> {
    const factRows = rows<FactRow>(await manager.query(`SELECT "id","fact_key","title","content","version","verified_at","created_at","updated_at"
      FROM "project_facts" WHERE "owner_id"=$1 AND "project_id"=$2 AND "deleted_at" IS NULL ORDER BY "updated_at" DESC,"id" LIMIT $3`,
    [ownerId, workspaceId, MAX_SNAPSHOT_ROWS + 1]));
    if (factRows.length > MAX_SNAPSHOT_ROWS) throw tooLarge();
    return factRows.map((row) => {
      const verifiedAt = row.verified_at === null ? null : new Date(row.verified_at);
      return { id: row.id, key: row.fact_key, title: row.title, content: row.content, version: row.version,
        verificationStatus: projectFactVerificationStatus(verifiedAt) === 'verified' ? 'verified' : 'needs_review',
        verifiedAt: verifiedAt?.toISOString() ?? null, createdAt: dateTime(row.created_at), updatedAt: dateTime(row.updated_at) };
    });
  }

  private async readContext(manager: EntityManager, ownerId: string, workspaceId: string): Promise<WorkspaceExportSnapshot['context']> {
    const row = rows<ContextRow>(await manager.query(`SELECT "relative_paths","fact_ids","include_project_conversations","excluded_paths"
      FROM "project_chat_context" WHERE "owner_id"=$1 AND "project_id"=$2`, [ownerId, workspaceId]))[0];
    return row ? { relativePaths: stringArray(row.relative_paths), factIds: stringArray(row.fact_ids),
      includeProjectConversations: row.include_project_conversations, excludedPaths: stringArray(row.excluded_paths) }
      : { relativePaths: [], factIds: [], includeProjectConversations: true, excludedPaths: [] };
  }

  private async readProjectConversations(manager: EntityManager, ownerId: string, workspaceId: string): Promise<readonly WorkspaceExportConversation[]> {
    const conversations = rows<ConversationRow>(await manager.query(`SELECT "id","title","created_at","updated_at" FROM "conversations"
      WHERE "owner_id"=$1 AND "project_id"=$2 ORDER BY "created_at","id" LIMIT $3`, [ownerId, workspaceId, MAX_SNAPSHOT_ROWS + 1]));
    const ids = conversations.map((conversation) => conversation.id);
    const messages = ids.length === 0 ? [] : rows<ProjectMessageRow>(await manager.query(`SELECT m."conversation_id",m."id",m."sequence",m."role",m."content",m."created_at"
      FROM "messages" m JOIN "conversations" c ON c."id"=m."conversation_id"
      WHERE c."owner_id"=$1 AND c."project_id"=$2 AND m."role" IN ('user','assistant') ORDER BY m."conversation_id",m."sequence","m"."id" LIMIT $3`,
    [ownerId, workspaceId, MAX_SNAPSHOT_ROWS + 1]));
    if (conversations.length > MAX_SNAPSHOT_ROWS || messages.length > MAX_SNAPSHOT_ROWS) throw tooLarge();
    return conversations.map((conversation) => projectConversation(conversation, messages.filter((message) => message.conversation_id === conversation.id)));
  }

  private async readHomeConversations(manager: EntityManager, ownerId: string, workspaceId: string): Promise<readonly WorkspaceExportConversation[]> {
    const conversations = rows<ConversationRow>(await manager.query(`SELECT "id","title","created_at","updated_at" FROM "home_conversations"
      WHERE "owner_id"=$1 AND "scope"='workspace' AND "workspace_id"=$2 ORDER BY "created_at","id" LIMIT $3`,
    [ownerId, workspaceId, MAX_SNAPSHOT_ROWS + 1]));
    const messages = rows<HomeMessageRow>(await manager.query(`SELECT m."conversation_id",m."id",m."turn_id",m."sequence",m."role",m."content",m."created_at"
      FROM "home_messages" m JOIN "home_conversations" h ON h."owner_id"=m."owner_id" AND h."id"=m."conversation_id"
      WHERE m."owner_id"=$1 AND h."scope"='workspace' AND h."workspace_id"=$2 AND m."role" IN ('user','assistant')
      ORDER BY m."conversation_id",m."sequence",m."id" LIMIT $3`, [ownerId, workspaceId, MAX_SNAPSHOT_ROWS + 1]));
    if (conversations.length > MAX_SNAPSHOT_ROWS || messages.length > MAX_SNAPSHOT_ROWS) throw tooLarge();
    return conversations.map((conversation) => projectConversation(conversation, messages.filter((message) => message.conversation_id === conversation.id)));
  }

  private async readSkills(manager: EntityManager, ownerId: string, workspaceId: string): Promise<readonly WorkspaceExportSkill[]> {
    const skills = rows<SkillRow>(await manager.query(`SELECT s."id",r."title",r."instructions",r."declared_tools",r."enabled",r."version",r."created_at",s."updated_at"
      FROM "skills" s JOIN "skill_revisions" r ON r."owner_id"=s."owner_id" AND r."skill_id"=s."id" AND r."version"=s."current_version"
      WHERE s."owner_id"=$1 AND s."workspace_id"=$2 AND s."deleted_at" IS NULL ORDER BY s."created_at","s"."id" LIMIT $3`,
    [ownerId, workspaceId, MAX_SNAPSHOT_ROWS + 1]));
    if (skills.length > MAX_SNAPSHOT_ROWS) throw tooLarge();
    return skills.map((row) => ({ id: row.id, title: row.title, instructions: row.instructions,
      declaredTools: stringArray(row.declared_tools), enabled: row.enabled, version: row.version,
      createdAt: dateTime(row.created_at), updatedAt: dateTime(row.updated_at) }));
  }

  private async readSchedules(manager: EntityManager, ownerId: string, workspaceId: string): Promise<readonly WorkspaceExportSchedule[]> {
    const schedules = rows<ScheduleRow>(await manager.query(`SELECT "id","conversation_id","skill_id","skill_version","local_time","time_zone","enabled","revision","created_at","updated_at"
      FROM "automation_schedules" WHERE "owner_id"=$1 AND "workspace_id"=$2 ORDER BY "created_at","id" LIMIT $3`,
    [ownerId, workspaceId, MAX_SNAPSHOT_ROWS + 1]));
    if (schedules.length > MAX_SNAPSHOT_ROWS) throw tooLarge();
    return schedules.map((row) => ({ id: row.id, conversationId: row.conversation_id, skillId: row.skill_id,
      skillVersion: row.skill_version, localTime: row.local_time, timeZone: row.time_zone, enabled: row.enabled,
      revision: row.revision, createdAt: dateTime(row.created_at), updatedAt: dateTime(row.updated_at) }));
  }
}

async function lockExportableWorkspace(manager: EntityManager, ownerId: string, workspaceId: string): Promise<WorkspaceRow> {
  const project = rows<WorkspaceRow>(await manager.query(`SELECT "id","name","objective",("relative_root_key" IS NOT NULL) AS "file_backed"
    FROM "projects" WHERE "owner_id"=$1 AND "id"=$2 AND "status"='active' FOR SHARE`, [ownerId, workspaceId]))[0];
  if (!project) throw workspaceUnavailable();
  return project;
}

async function lockExportableOwner(manager: EntityManager, ownerId: string): Promise<{ readonly id: string }> {
  const owner = rows<{ readonly id: string }>(await manager.query(`SELECT "id" FROM "users" WHERE "id"=$1 AND "is_active"=true
    AND ("expires_at" IS NULL OR "expires_at">clock_timestamp()) FOR UPDATE`, [ownerId]))[0];
  if (!owner) throw workspaceUnavailable();
  return owner;
}

async function currentDemoCleanupGeneration(manager: EntityManager, ownerId: string): Promise<string | null> {
  const cleanup = rows<{ readonly generation: string }>(await manager.query(`SELECT c."generation" FROM "demo_expiry_cleanups" c
    JOIN "demo_admissions" a ON a."id"=c."admission_id" WHERE a."owner_id"=$1 LIMIT 1`, [ownerId]))[0];
  return cleanup?.generation ?? null;
}

function existingKeyResult(row: ExistingExportDbRow, fingerprint: string, workspaceId: string, databaseNow: Date): BeginWorkspaceExportResult {
  if (row.request_fingerprint !== fingerprint || row.workspace_id !== workspaceId) {
    throw new AppError('IDEMPOTENCY_KEY_REUSED', 409, 'This export key was already used for a different request.');
  }
  if (row.state === 'building') return { kind: 'in_progress' };
  if (row.state === 'ready' && row.expires_at && new Date(row.expires_at).getTime() > databaseNow.getTime()) {
    return { kind: 'replay', descriptor: descriptor(row) };
  }
  return { kind: 'expired_key' };
}

function descriptor(row: ExportDbRow): WorkspaceExportDescriptor {
  return { id: row.id, workspaceId: row.workspace_id, sizeBytes: Number(row.byte_count), expiresAt: dateTime(row.expires_at) };
}

function toRecord(row: ExportDbRow): WorkspaceExportRecord {
  return {
    id: row.id, ownerId: row.owner_id, workspaceId: row.workspace_id, state: row.state,
    requestFingerprint: row.request_fingerprint, demoCleanupGeneration: row.demo_cleanup_generation,
    builder: row.builder_process_id === null || row.builder_start_ticks === null ? null
      : { processId: row.builder_process_id, startTicks: row.builder_start_ticks },
    createdAt: new Date(row.created_at), expiresAt: row.expires_at === null ? null : new Date(row.expires_at),
    sizeBytes: row.byte_count === null ? null : Number(row.byte_count)
  };
}

function projectConversation(
  row: ConversationRow,
  messages: readonly (ProjectMessageRow | HomeMessageRow)[]
): WorkspaceExportConversation {
  return {
    id: row.id, title: row.title, createdAt: dateTime(row.created_at), updatedAt: dateTime(row.updated_at),
    messages: messages.map((message) => ({ id: message.id,
      turnId: 'turn_id' in message ? message.turn_id : null,
      sequence: message.sequence, role: message.role, content: message.content, createdAt: dateTime(message.created_at) }))
  };
}

function parseSubtasks(value: unknown): WorkspaceExportTask['subtasks'] {
  const array = jsonArray(value);
  return array.map((item) => {
    if (!isObject(item) || typeof item.id !== 'string' || typeof item.title !== 'string' || typeof item.completed !== 'boolean') throw exportFailed();
    return { id: item.id, title: item.title, completed: item.completed };
  });
}

function stringArray(value: unknown): readonly string[] {
  const array = jsonArray(value);
  if (!array.every((item): item is string => typeof item === 'string')) throw exportFailed();
  return array;
}

function jsonArray(value: unknown): readonly unknown[] {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed)) throw exportFailed();
  return parsed;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dateTime(value: Date | string | null): string {
  if (value === null) throw exportFailed();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw exportFailed();
  return date.toISOString();
}

function dateOnly(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

function rows<T>(value: unknown): readonly T[] {
  if (!Array.isArray(value)) throw exportFailed();
  if (value.length === 2 && Array.isArray(value[0]) && typeof value[1] === 'number') return value[0] as readonly T[];
  return value as readonly T[];
}

function snapshotBoundsSql(): string {
  const rowLimit = MAX_SNAPSHOT_ROWS + 1;
  const sourceByteLimit = MAX_SNAPSHOT_SOURCE_BYTES + 1;
  return `WITH content_rows AS (
    SELECT "bytes" FROM (
      SELECT LEAST(octet_length("title")+coalesce(octet_length("details"),0)+octet_length("subtasks"::text), ${sourceByteLimit}) AS "bytes"
      FROM "project_tasks" WHERE "owner_id"=$1 AND "project_id"=$2 LIMIT ${rowLimit}
    ) AS bounded_tasks
    UNION ALL SELECT "bytes" FROM (
      SELECT LEAST(octet_length("fact_key")+octet_length("title")+octet_length("content"), ${sourceByteLimit}) AS "bytes"
      FROM "project_facts" WHERE "owner_id"=$1 AND "project_id"=$2 AND "deleted_at" IS NULL LIMIT ${rowLimit}
    ) AS bounded_facts
    UNION ALL SELECT "bytes" FROM (
      SELECT LEAST(octet_length("title"), ${sourceByteLimit}) AS "bytes"
      FROM "conversations" WHERE "owner_id"=$1 AND "project_id"=$2 LIMIT ${rowLimit}
    ) AS bounded_project_conversations
    UNION ALL SELECT "bytes" FROM (
      SELECT LEAST(octet_length(m."content"), ${sourceByteLimit}) AS "bytes"
      FROM "messages" m JOIN "conversations" c ON c."id"=m."conversation_id"
      WHERE c."owner_id"=$1 AND c."project_id"=$2 AND m."role" IN ('user','assistant') LIMIT ${rowLimit}
    ) AS bounded_project_messages
    UNION ALL SELECT "bytes" FROM (
      SELECT LEAST(octet_length("title"), ${sourceByteLimit}) AS "bytes"
      FROM "home_conversations" WHERE "owner_id"=$1 AND "scope"='workspace' AND "workspace_id"=$2 LIMIT ${rowLimit}
    ) AS bounded_home_conversations
    UNION ALL SELECT "bytes" FROM (
      SELECT LEAST(octet_length(m."content"), ${sourceByteLimit}) AS "bytes"
      FROM "home_messages" m JOIN "home_conversations" h ON h."owner_id"=m."owner_id" AND h."id"=m."conversation_id"
      WHERE m."owner_id"=$1 AND h."scope"='workspace' AND h."workspace_id"=$2 AND m."role" IN ('user','assistant') LIMIT ${rowLimit}
    ) AS bounded_home_messages
    UNION ALL SELECT "bytes" FROM (
      SELECT LEAST(octet_length(r."title")+octet_length(r."instructions")+octet_length(r."declared_tools"::text), ${sourceByteLimit}) AS "bytes"
      FROM "skills" s JOIN "skill_revisions" r ON r."owner_id"=s."owner_id" AND r."skill_id"=s."id" AND r."version"=s."current_version"
      WHERE s."owner_id"=$1 AND s."workspace_id"=$2 AND s."deleted_at" IS NULL LIMIT ${rowLimit}
    ) AS bounded_skills
    UNION ALL SELECT "bytes" FROM (
      SELECT LEAST(octet_length("time_zone")+octet_length("local_time"::text), ${sourceByteLimit}) AS "bytes"
      FROM "automation_schedules" WHERE "owner_id"=$1 AND "workspace_id"=$2 LIMIT ${rowLimit}
    ) AS bounded_schedules
    UNION ALL SELECT "bytes" FROM (
      SELECT LEAST(octet_length("relative_paths"::text)+octet_length("fact_ids"::text)+octet_length("excluded_paths"::text), ${sourceByteLimit}) AS "bytes"
      FROM "project_chat_context" WHERE "owner_id"=$1 AND "project_id"=$2 LIMIT ${rowLimit}
    ) AS bounded_context
  ) SELECT count(*) AS "row_count",coalesce(sum("bytes"),0) AS "content_bytes" FROM content_rows`;
}

function workspaceUnavailable(): AppError { return new AppError('WORKSPACE_UNAVAILABLE', 404, 'The workspace is unavailable.'); }
function limitReached(): AppError { return new AppError('EXPORT_LIMIT_REACHED', 429, 'Too many workspace exports are active. Try again after one expires.'); }
function tooLarge(): AppError { return new AppError('EXPORT_TOO_LARGE', 413, 'The workspace export exceeds its safe limits.'); }
function exportFailed(): AppError { return new AppError('EXPORT_FAILED', 500, 'The workspace export could not be prepared.'); }
