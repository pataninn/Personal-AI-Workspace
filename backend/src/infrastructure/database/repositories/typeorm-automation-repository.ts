import { createHash } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';

import type { AutomationLeaseFence, AutomationOccurrence, AutomationOccurrenceStatus, AutomationSchedule, AutomationTaskSourceProjection, AutomationTaskSourceRevision } from '@/modules/automations/domain/automation-types';
import { AutomationBusyError, AutomationIdempotencyConflictError, AutomationNotFoundError, AutomationRevisionConflictError, AutomationSkillNotReadOnlyError, AutomationSkillUnavailableError, AutomationWorkspaceUnavailableError } from '@/modules/automations/domain/automation-errors';
import { planDailyCatchUp } from '@/modules/automations/domain/schedule-time';
import type { AutomationOccurrencePage, ClaimedAutomationOccurrence, CreateAutomationOccurrenceRecord, CreateAutomationScheduleRecord, IAutomationRepository, UpdateAutomationScheduleRecord, UpdateAutomationScheduleResult } from '@/modules/automations/repositories/automation-repository';
import type { IHomeAutomationSourceRecorder } from '@/modules/home-assistant/repositories/home-automation-source-recorder';

interface ScheduleRow {
  readonly id: string;
  readonly owner_id: string;
  readonly workspace_id: string;
  readonly conversation_id: string;
  readonly skill_id: string;
  readonly skill_revision_id: string;
  readonly skill_version: number;
  readonly local_time: string;
  readonly time_zone: string;
  readonly enabled: boolean;
  readonly revision: number;
  readonly next_due_at: Date | string | null;
  readonly last_run_status: AutomationOccurrenceStatus | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly create_key_digest?: string;
  readonly request_fingerprint?: string;
}

interface OccurrenceRow {
  readonly id: string;
  readonly owner_id: string;
  readonly schedule_id: string;
  readonly kind: 'scheduled' | 'manual';
  readonly intended_for_utc: Date | string;
  readonly local_date: Date | string;
  readonly status: AutomationOccurrenceStatus;
  readonly schedule_revision: number;
  readonly skill_version: number;
  readonly skill_revision_id: string | null;
  readonly home_turn_id: string | null;
  readonly attempt_count: number;
  readonly failure_code: string | null;
  readonly lease_expires_at: Date | string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly lease_token?: string;
  readonly claim_generation?: string | number;
  readonly workspace_id?: string;
  readonly conversation_id?: string;
  readonly skill_id?: string;
  readonly task_source_revisions?: unknown;
}

interface TaskSourceProjectionRow {
  readonly occurrence_id: string;
  readonly task_id: string;
  readonly revision: number;
  readonly available: boolean;
  readonly title: string | null;
}

interface CursorRow { readonly intended_for_utc: string; readonly id: string; }
interface SkillRow {
  readonly id: string;
  readonly workspace_id: string | null;
  readonly current_version: number;
  readonly deleted_at: Date | string | null;
  readonly revision_id: string;
  readonly enabled: boolean;
  readonly declared_tools: unknown;
}
interface ActiveTurnRow {
  readonly owner_id: string;
  readonly conversation_id: string;
  readonly turn_id: string | null;
  readonly occurrence_id: string;
}

const READ_CAPABILITIES = new Set(['home_task_read', 'home_workspace_read']);
const TERMINAL_OCCURRENCE_STATUSES = new Set<AutomationOccurrenceStatus>(['succeeded', 'failed', 'cancelled', 'skipped']);
const ACTIVE_OCCURRENCE_STATUSES = ['claimed', 'dispatching', 'running', 'cancel_requested', 'interrupted_unknown'];
const MAX_CATCH_UP_OCCURRENCES = 1;

function rows<T>(value: unknown): readonly T[] {
  if (!Array.isArray(value)) throw new Error('The automation repository returned an unexpected query result.');
  if (value.length === 2 && Array.isArray(value[0]) && typeof value[1] === 'number') return value[0] as readonly T[];
  return value as readonly T[];
}

function date(value: Date | string): Date { return value instanceof Date ? value : new Date(value); }
function nullableDate(value: Date | string | null): Date | null { return value === null ? null : date(value); }

function parseTaskSources(value: unknown): readonly AutomationTaskSourceRevision[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 256) throw new Error('The automation task-source record is invalid.');
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('The automation task-source record is invalid.');
    const row = entry as Record<string, unknown>;
    if (Object.keys(row).length !== 2 || typeof row.id !== 'string'
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(row.id)
      || !Number.isSafeInteger(row.revision) || (row.revision as number) < 1 || (row.revision as number) > 999999999) {
      throw new Error('The automation task-source record is invalid.');
    }
    const key = `${row.id}:${row.revision}`;
    if (seen.has(key)) throw new Error('The automation task-source record is invalid.');
    seen.add(key);
    return { taskId: row.id, revision: row.revision as number };
  });
}

function normalizeIncomingTaskSources(value: readonly AutomationTaskSourceRevision[]): readonly AutomationTaskSourceRevision[] {
  if (!Array.isArray(value) || value.length > 256) throw new TypeError('The automation task-source request is invalid.');
  const seen = new Set<string>();
  const result: AutomationTaskSourceRevision[] = [];
  for (const source of value) {
    if (!source || typeof source.taskId !== 'string'
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(source.taskId)
      || !Number.isSafeInteger(source.revision) || source.revision < 1 || source.revision > 999999999) {
      throw new TypeError('The automation task-source request is invalid.');
    }
    const key = `${source.taskId}:${source.revision}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ taskId: source.taskId, revision: source.revision });
    }
  }
  return result;
}

function toSchedule(row: ScheduleRow): AutomationSchedule {
  return {
    id: row.id,
    ownerId: row.owner_id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    skillId: row.skill_id,
    skillRevisionId: row.skill_revision_id,
    skillVersion: Number(row.skill_version),
    localTime: String(row.local_time).slice(0, 5),
    timeZone: row.time_zone,
    enabled: row.enabled,
    revision: Number(row.revision),
    nextDueAt: nullableDate(row.next_due_at),
    lastRunStatus: row.last_run_status,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at)
  };
}

function toOccurrence(row: OccurrenceRow): AutomationOccurrence {
  const localDate = row.local_date instanceof Date
    ? row.local_date.toISOString().slice(0, 10)
    : String(row.local_date).slice(0, 10);
  return {
    id: row.id,
    ownerId: row.owner_id,
    scheduleId: row.schedule_id,
    kind: row.kind,
    intendedFor: date(row.intended_for_utc),
    localDate,
    status: row.status,
    scheduleRevision: Number(row.schedule_revision),
    skillVersion: Number(row.skill_version),
    skillRevisionId: row.skill_revision_id,
    homeTurnId: row.home_turn_id,
    attemptCount: Number(row.attempt_count),
    failureCode: row.failure_code,
    claimedUntil: nullableDate(row.lease_expires_at),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
    taskSourceRevisions: parseTaskSources(row.task_source_revisions)
  };
}

function cursorEncode(cursor: CursorRow): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function cursorDecode(value: string): CursorRow {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<CursorRow>;
    if (typeof parsed.id !== 'string' || typeof parsed.intended_for_utc !== 'string' || !Number.isFinite(Date.parse(parsed.intended_for_utc))) throw new Error();
    return { id: parsed.id, intended_for_utc: parsed.intended_for_utc };
  } catch { throw new TypeError('The automation cursor is invalid.'); }
}

function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

async function lockActiveOwner(manager: EntityManager, ownerId: string): Promise<void> {
  const owner = rows<{ readonly id: string }>(await manager.query(`
    SELECT "id" FROM "users" WHERE "id"=$1 AND "is_active"=true
      AND ("expires_at" IS NULL OR "expires_at">clock_timestamp()) FOR UPDATE
  `, [ownerId]))[0];
  if (!owner) throw new AutomationNotFoundError();
  const cleanup = rows<{ readonly id: string }>(await manager.query(`
    SELECT dc."admission_id" AS "id" FROM "demo_expiry_cleanups" dc
    JOIN "demo_admissions" da ON da."id"=dc."admission_id" WHERE da."owner_id"=$1 LIMIT 1
  `, [ownerId]))[0];
  if (cleanup) throw new AutomationNotFoundError();
}

async function assertWorkspace(manager: EntityManager, ownerId: string, workspaceId: string): Promise<void> {
  const rowsForProject = rows<{ readonly id: string }>(await manager.query(
    `SELECT "id" FROM "projects" p WHERE p."owner_id"=$1 AND p."id"=$2 AND p."status"='active'
      AND NOT EXISTS(SELECT 1 FROM "project_removal_jobs" j WHERE j."project_id"=p."id") FOR SHARE`, [ownerId, workspaceId]
  ));
  if (!rowsForProject[0]) throw new AutomationWorkspaceUnavailableError();
}

async function findCurrentSkill(manager: EntityManager, ownerId: string, skillId: string): Promise<SkillRow | null> {
  const result = rows<SkillRow>(await manager.query(`
    SELECT s."id",s."workspace_id",s."current_version",s."deleted_at",r."id" AS "revision_id",r."enabled",r."declared_tools"
    FROM "skills" s JOIN "skill_revisions" r ON r."owner_id"=s."owner_id" AND r."skill_id"=s."id" AND r."version"=s."current_version"
    WHERE s."owner_id"=$1 AND s."id"=$2 AND s."deleted_at" IS NULL
  `, [ownerId, skillId]));
  return result[0] ?? null;
}

function assertReadOnlySkill(skill: SkillRow | null, workspaceId: string, skillVersion: number, revisionId?: string): asserts skill is SkillRow {
  if (!skill || !skill.enabled || skill.workspace_id !== null && skill.workspace_id !== workspaceId
    || skill.current_version !== skillVersion || revisionId !== undefined && skill.revision_id !== revisionId) {
    throw new AutomationSkillUnavailableError();
  }
  let tools: unknown = skill.declared_tools;
  if (typeof tools === 'string') {
    try { tools = JSON.parse(tools) as unknown; } catch { throw new AutomationSkillNotReadOnlyError(); }
  }
  if (!Array.isArray(tools) || !tools.every((tool) => typeof tool === 'string' && READ_CAPABILITIES.has(tool))) {
    throw new AutomationSkillNotReadOnlyError();
  }
}

const SCHEDULE_SELECT = `
  SELECT s."id",s."owner_id",s."workspace_id",s."conversation_id",s."skill_id",s."skill_revision_id",s."skill_version",
         to_char(s."local_time",'HH24:MI') AS "local_time",s."time_zone",s."enabled",s."revision",s."next_due_at",
          (SELECT o."status" FROM "automation_occurrences" o WHERE o."owner_id"=s."owner_id" AND o."schedule_id"=s."id"
           ORDER BY o."intended_for_utc" DESC,o."id" DESC LIMIT 1) AS "last_run_status",s."created_at",s."updated_at",
          s."create_key_digest",s."request_fingerprint"
  FROM "automation_schedules" s
`;

const OCCURRENCE_SELECT = `
  SELECT "id","owner_id","schedule_id","kind","intended_for_utc","local_date","status","schedule_revision",
          "skill_version","skill_revision_id","home_turn_id","attempt_count","failure_code","lease_expires_at","created_at","updated_at","request_fingerprint",
          "task_source_revisions"
  FROM "automation_occurrences"
`;

/** Owner-scoped scheduler persistence. No DB transaction remains open across Home/provider work. */
export class TypeOrmAutomationRepository implements IAutomationRepository, IHomeAutomationSourceRecorder {
  public constructor(private readonly dataSource: DataSource) {}

  public async createSchedule(input: CreateAutomationScheduleRecord): Promise<{ readonly schedule: AutomationSchedule; readonly replayed: boolean }> {
    return await this.dataSource.transaction(async (manager) => {
      await lockActiveOwner(manager, input.ownerId);
      const existing = rows<ScheduleRow & { readonly create_key_digest: string; readonly request_fingerprint: string }>(await manager.query(
        `${SCHEDULE_SELECT} WHERE s."owner_id"=$1 AND s."create_key_digest"=$2`, [input.ownerId, input.createKeyDigest]
      ))[0];
      if (existing) {
        if (existing.request_fingerprint !== input.requestFingerprint) throw new AutomationIdempotencyConflictError();
        return { schedule: toSchedule(existing), replayed: true };
      }
      await assertWorkspace(manager, input.ownerId, input.workspaceId);
      const skill = await findCurrentSkill(manager, input.ownerId, input.skillId);
      assertReadOnlySkill(skill, input.workspaceId, input.skillVersion, input.skillRevisionId);
      const conversation = rows<{ readonly id: string }>(await manager.query(`
        SELECT "id" FROM "home_conversations" WHERE "owner_id"=$1 AND "id"=$2 AND "scope"='workspace' AND "workspace_id"=$3
      `, [input.ownerId, input.conversationId, input.workspaceId]))[0];
      if (!conversation) throw new AutomationWorkspaceUnavailableError();
      const inserted = rows<{ readonly id: string }>(await manager.query(`
        INSERT INTO "automation_schedules" ("owner_id","workspace_id","conversation_id","skill_id","skill_revision_id","skill_version",
          "local_time","time_zone","enabled","revision","next_due_at","create_key_digest","request_fingerprint")
        VALUES ($1,$2,$3,$4,$5,$6,$7::time,$8,true,1,$9,$10,$11) RETURNING "id"
      `, [input.ownerId, input.workspaceId, input.conversationId, input.skillId, input.skillRevisionId, input.skillVersion,
        `${input.localTime}:00`, input.timeZone, input.nextDueAt, input.createKeyDigest, input.requestFingerprint]))[0];
      if (!inserted) throw new Error('The automation schedule could not be created.');
      const schedule = rows<ScheduleRow>(await manager.query(`${SCHEDULE_SELECT} WHERE s."id"=$1`, [inserted.id]))[0];
      if (!schedule) throw new Error('The created automation schedule could not be loaded.');
      return { schedule: toSchedule(schedule), replayed: false };
    });
  }

  public async listSchedules(ownerId: string): Promise<readonly AutomationSchedule[]> {
    const schedules = rows<ScheduleRow>(await this.dataSource.query(`${SCHEDULE_SELECT} WHERE s."owner_id"=$1 ORDER BY s."updated_at" DESC,s."id"`, [ownerId]));
    return schedules.map(toSchedule);
  }

  public async findCreatedSchedule(ownerId: string, createKeyDigest: string, requestFingerprint: string): Promise<AutomationSchedule | null> {
    const schedule = rows<ScheduleRow & { readonly request_fingerprint: string }>(await this.dataSource.query(
      `${SCHEDULE_SELECT} WHERE s."owner_id"=$1 AND s."create_key_digest"=$2`, [ownerId, createKeyDigest]
    ))[0];
    if (!schedule) return null;
    if (schedule.request_fingerprint !== requestFingerprint) throw new AutomationIdempotencyConflictError();
    return toSchedule(schedule);
  }

  public async findSchedule(ownerId: string, scheduleId: string): Promise<AutomationSchedule | null> {
    const schedule = rows<ScheduleRow>(await this.dataSource.query(`${SCHEDULE_SELECT} WHERE s."owner_id"=$1 AND s."id"=$2`, [ownerId, scheduleId]))[0];
    return schedule ? toSchedule(schedule) : null;
  }

  public async updateSchedule(input: UpdateAutomationScheduleRecord): Promise<UpdateAutomationScheduleResult> {
    return await this.dataSource.transaction(async (manager) => {
      await lockActiveOwner(manager, input.ownerId);
      const current = rows<ScheduleRow>(await manager.query(`${SCHEDULE_SELECT} WHERE s."owner_id"=$1 AND s."id"=$2 FOR UPDATE OF s`, [input.ownerId, input.scheduleId]))[0];
      if (!current) throw new AutomationNotFoundError();
      if (Number(current.revision) !== input.expectedRevision) throw new AutomationRevisionConflictError();
      await assertWorkspace(manager, input.ownerId, current.workspace_id);
      if (input.enabled) {
        const skill = await findCurrentSkill(manager, input.ownerId, input.skillId);
        assertReadOnlySkill(skill, current.workspace_id, input.skillVersion, input.skillRevisionId);
      }
      const updated = rows<ScheduleRow>(await manager.query(`
        UPDATE "automation_schedules" SET "skill_id"=$3,"skill_revision_id"=$4,"skill_version"=$5,"local_time"=$6::time,
          "time_zone"=$7,"enabled"=$8,"revision"="revision"+1,"next_due_at"=$9,"updated_at"=clock_timestamp()
        WHERE "owner_id"=$1 AND "id"=$2 AND "revision"=$10 RETURNING "id"
      `, [input.ownerId, input.scheduleId, input.skillId, input.skillRevisionId, input.skillVersion, `${input.localTime}:00`, input.timeZone,
        input.enabled, input.nextDueAt, input.expectedRevision]))[0];
      if (!updated) throw new AutomationRevisionConflictError();

      await manager.query(`UPDATE "automation_occurrences" SET "status"='cancelled',"lease_token"=NULL,"lease_expires_at"=NULL,
        "failure_code"='SCHEDULE_CHANGED',"updated_at"=clock_timestamp()
        WHERE "owner_id"=$1 AND "schedule_id"=$2 AND "status"='queued'`, [input.ownerId, input.scheduleId]);
      const active = rows<ActiveTurnRow>(await manager.query(`
        UPDATE "automation_occurrences" o SET
          "status"=CASE WHEN o."home_turn_id" IS NULL THEN 'cancelled' ELSE 'cancel_requested' END,
          "failure_code"='SCHEDULE_CHANGED',"lease_token"=NULL,"lease_expires_at"=NULL,"updated_at"=clock_timestamp()
        FROM "automation_schedules" s
        WHERE o."owner_id"=$1 AND o."schedule_id"=$2 AND o."status" IN ('claimed','dispatching','running','cancel_requested','interrupted_unknown')
          AND s."owner_id"=o."owner_id" AND s."id"=o."schedule_id"
        RETURNING o."owner_id",o."home_turn_id" AS "turn_id",s."conversation_id",o."id" AS "occurrence_id"
      `, [input.ownerId, input.scheduleId]));
      const schedule = rows<ScheduleRow>(await manager.query(`${SCHEDULE_SELECT} WHERE s."owner_id"=$1 AND s."id"=$2`, [input.ownerId, input.scheduleId]))[0];
      if (!schedule) throw new AutomationNotFoundError();
      return {
        schedule: toSchedule(schedule),
        activeTurns: active.flatMap((row) => row.turn_id === null ? [] : [{
          ownerId: row.owner_id, conversationId: row.conversation_id, turnId: row.turn_id, occurrenceId: row.occurrence_id
        }])
      };
    });
  }

  public async createManualOccurrence(input: CreateAutomationOccurrenceRecord): Promise<{ readonly occurrence: AutomationOccurrence; readonly replayed: boolean }> {
    return await this.dataSource.transaction(async (manager) => {
      await lockActiveOwner(manager, input.ownerId);
      const schedule = rows<ScheduleRow>(await manager.query(`${SCHEDULE_SELECT} WHERE s."owner_id"=$1 AND s."id"=$2 FOR UPDATE OF s`, [input.ownerId, input.scheduleId]))[0];
      if (!schedule) throw new AutomationNotFoundError();
      const existing = rows<OccurrenceRow & { readonly request_fingerprint: string }>(await manager.query(
        `${OCCURRENCE_SELECT} WHERE "owner_id"=$1 AND "schedule_id"=$2 AND "request_key_digest"=$3`,
        [input.ownerId, input.scheduleId, input.requestKeyDigest]
      ))[0];
      if (existing) {
        if (existing.request_fingerprint !== input.requestFingerprint) throw new AutomationIdempotencyConflictError();
        return { occurrence: toOccurrence(existing), replayed: true };
      }
      if (Number(schedule.revision) !== input.expectedRevision) throw new AutomationRevisionConflictError();
      await assertWorkspace(manager, input.ownerId, schedule.workspace_id);
      const skill = await findCurrentSkill(manager, input.ownerId, schedule.skill_id);
      assertReadOnlySkill(skill, schedule.workspace_id, Number(schedule.skill_version), schedule.skill_revision_id);
      const active = rows<{ readonly id: string }>(await manager.query(`
        SELECT "id" FROM "automation_occurrences" WHERE "owner_id"=$1 AND "schedule_id"=$2 AND "status"=ANY($3::text[]) LIMIT 1
      `, [input.ownerId, input.scheduleId, ACTIVE_OCCURRENCE_STATUSES]));
      if (active[0]) throw new AutomationBusyError();
      const inserted = rows<{ readonly id: string }>(await manager.query(`
        INSERT INTO "automation_occurrences" ("owner_id","schedule_id","conversation_id","kind","intended_for_utc","local_date",
          "status","schedule_revision","skill_version","skill_revision_id","request_key_digest","request_fingerprint")
        VALUES ($1,$2,$3,'manual',clock_timestamp(),(clock_timestamp() AT TIME ZONE $4)::date,'queued',$5,$6,$7,$8,$9)
        RETURNING "id"
      `, [input.ownerId, input.scheduleId, schedule.conversation_id, schedule.time_zone, schedule.revision, schedule.skill_version,
        schedule.skill_revision_id, input.requestKeyDigest, input.requestFingerprint]))[0];
      if (!inserted) throw new Error('The manual occurrence could not be created.');
      const occurrence = rows<OccurrenceRow>(await manager.query(`${OCCURRENCE_SELECT} WHERE "id"=$1`, [inserted.id]))[0];
      if (!occurrence) throw new Error('The manual occurrence could not be loaded.');
      return { occurrence: toOccurrence(occurrence), replayed: false };
    });
  }

  public async listOccurrences(input: { readonly ownerId: string; readonly scheduleId: string; readonly limit: number; readonly before?: string }): Promise<AutomationOccurrencePage | null> {
    const schedule = rows<{ readonly id: string }>(await this.dataSource.query(
      'SELECT "id" FROM "automation_schedules" WHERE "owner_id"=$1 AND "id"=$2', [input.ownerId, input.scheduleId]
    ))[0];
    if (!schedule) return null;
    const parameters: unknown[] = [input.ownerId, input.scheduleId];
    let cursorFilter = '';
    if (input.before) {
      const cursor = cursorDecode(input.before);
      parameters.push(cursor.intended_for_utc, cursor.id);
      cursorFilter = ` AND ("intended_for_utc"<$3 OR ("intended_for_utc"=$3 AND "id"<$4))`;
    }
    parameters.push(Math.max(1, Math.min(100, Math.trunc(input.limit))) + 1);
    const result = rows<OccurrenceRow & CursorRow>(await this.dataSource.query(
      `${OCCURRENCE_SELECT} WHERE "owner_id"=$1 AND "schedule_id"=$2${cursorFilter}
       ORDER BY "intended_for_utc" DESC,"id" DESC LIMIT $${parameters.length}`,
      parameters
    ));
    const hasMore = result.length > Math.max(1, Math.min(100, Math.trunc(input.limit)));
    const page = hasMore ? result.slice(0, -1) : result;
    const projections = page.length ? rows<TaskSourceProjectionRow>(await this.dataSource.query(`
      SELECT o."id" AS "occurrence_id",source.value->>'id' AS "task_id",
        (source.value->>'revision')::integer AS "revision",(t."id" IS NOT NULL) AS "available",t."title"
      FROM "automation_occurrences" o
      JOIN "automation_schedules" s ON s."owner_id"=o."owner_id" AND s."id"=o."schedule_id"
      CROSS JOIN LATERAL jsonb_array_elements(o."task_source_revisions") WITH ORDINALITY AS source(value,ordinal)
      LEFT JOIN "project_tasks" t ON t."owner_id"=o."owner_id" AND t."project_id"=s."workspace_id"
        AND t."id"::text=source.value->>'id' AND t."version"::text=source.value->>'revision'
      WHERE o."owner_id"=$1 AND o."id"=ANY($2::uuid[])
      ORDER BY o."id",source.ordinal
    `, [input.ownerId, page.map((item) => item.id)])) : [];
    const sourcesByOccurrence = new Map<string, AutomationTaskSourceProjection[]>();
    for (const row of projections) {
      const sources = sourcesByOccurrence.get(row.occurrence_id) ?? [];
      sources.push({
        taskId: row.task_id,
        revision: Number(row.revision),
        available: row.available,
        title: row.available ? row.title : null,
        href: row.available ? `/tasks/${row.task_id}` : null
      });
      sourcesByOccurrence.set(row.occurrence_id, sources);
    }
    const last = page.at(-1);
    return { occurrences: page.map((item) => ({ ...toOccurrence(item), taskSources: sourcesByOccurrence.get(item.id) ?? [] })), nextCursor: hasMore && last ? cursorEncode({ intended_for_utc: date(last.intended_for_utc).toISOString(), id: last.id }) : null };
  }

  public async materializeDueSchedules(limit: number): Promise<number> {
    return await this.dataSource.transaction(async (manager) => {
      const due = rows<ScheduleRow & { readonly now: Date | string }>(await manager.query(`
        SELECT s."id",s."owner_id",s."workspace_id",s."conversation_id",s."skill_id",s."skill_revision_id",s."skill_version",
          to_char(s."local_time",'HH24:MI') AS "local_time",s."time_zone",s."enabled",s."revision",s."next_due_at",
          NULL::text AS "last_run_status",s."created_at",s."updated_at",clock_timestamp() AS "now"
        FROM "automation_schedules" s WHERE s."enabled"=true AND s."next_due_at"<=clock_timestamp()
        ORDER BY s."next_due_at",s."id" LIMIT $1 FOR UPDATE OF s SKIP LOCKED
      `, [Math.max(1, Math.min(100, Math.trunc(limit)))]));
      let created = 0;
      for (const schedule of due) {
        if (!schedule.next_due_at) continue;
        const plan = planDailyCatchUp({
          now: date(schedule.now),
          firstDueAt: date(schedule.next_due_at),
          localTime: String(schedule.local_time).slice(0, 5),
          timeZone: schedule.time_zone
        });
        if (plan.catchUp && MAX_CATCH_UP_OCCURRENCES > 0) {
          const requestKeyDigest = digest(`${schedule.id}:${schedule.revision}:${plan.catchUp.intendedFor.toISOString()}`);
          const inserted = rows<{ readonly id: string }>(await manager.query(`
            INSERT INTO "automation_occurrences" ("owner_id","schedule_id","conversation_id","kind","intended_for_utc","local_date",
              "status","schedule_revision","skill_version","skill_revision_id","request_key_digest","request_fingerprint")
            VALUES ($1,$2,$3,'scheduled',$4,$5::date,'queued',$6,$7,$8,$9,$10)
            ON CONFLICT DO NOTHING RETURNING "id"
          `, [schedule.owner_id, schedule.id, schedule.conversation_id, plan.catchUp.intendedFor, plan.catchUp.localDate,
            schedule.revision, schedule.skill_version, schedule.skill_revision_id, requestKeyDigest,
            digest(JSON.stringify({ scheduleId: schedule.id, intendedFor: plan.catchUp.intendedFor.toISOString(), revision: schedule.revision }))]));
          created += inserted.length;
        }
        await manager.query(`UPDATE "automation_schedules" SET "next_due_at"=$2,"updated_at"=clock_timestamp()
          WHERE "id"=$1`, [schedule.id, plan.next.intendedFor]);
      }
      return created;
    });
  }

  public async claimBatch(input: { readonly limit: number; readonly leaseMilliseconds: number }): Promise<readonly ClaimedAutomationOccurrence[]> {
    return await this.dataSource.transaction(async (manager) => {
      const candidates = rows<{ readonly id: string }>(await manager.query(`
        SELECT o."id" FROM "automation_occurrences" o
        WHERE (o."status"='queued'
          OR (o."status" IN ('claimed','dispatching','running','cancel_requested','interrupted_unknown')
            AND (o."lease_expires_at" IS NULL OR o."lease_expires_at"<=clock_timestamp())))
        ORDER BY o."updated_at",o."intended_for_utc",o."id" LIMIT $1 FOR UPDATE OF o SKIP LOCKED
      `, [Math.max(1, Math.min(32, Math.trunc(input.limit)))]));
      const claimed: ClaimedAutomationOccurrence[] = [];
      for (const candidate of candidates) {
        const updated = rows<OccurrenceRow>(await manager.query(`
          UPDATE "automation_occurrences" SET "lease_token"=gen_random_uuid(),"claim_generation"="claim_generation"+1,
            "lease_expires_at"=clock_timestamp()+($2::integer*interval '1 millisecond'),"heartbeat_at"=clock_timestamp(),
            "attempt_count"="attempt_count"+CASE WHEN "status"='queued' THEN 1 ELSE 0 END,
            "status"=CASE WHEN "status"='queued' THEN 'claimed' WHEN "status"='dispatching' AND "home_turn_id" IS NULL THEN 'claimed'
              WHEN "status"='cancel_requested' AND "home_turn_id" IS NULL THEN 'cancelled' ELSE "status" END,
            "updated_at"=clock_timestamp()
          WHERE "id"=$1 RETURNING "id","owner_id","schedule_id","kind","intended_for_utc","local_date","status","schedule_revision",
            "skill_version","skill_revision_id","home_turn_id","attempt_count","failure_code","lease_expires_at","created_at","updated_at",
            "lease_token","claim_generation"
        `, [candidate.id, input.leaseMilliseconds]))[0];
        if (!updated || updated.status === 'cancelled') continue;
        const schedule = rows<{ readonly workspace_id: string; readonly conversation_id: string; readonly skill_id: string }>(await manager.query(
          'SELECT "workspace_id","conversation_id","skill_id" FROM "automation_schedules" WHERE "owner_id"=$1 AND "id"=$2',
          [updated.owner_id, updated.schedule_id]
        ))[0];
        if (!schedule || !updated.lease_token || updated.claim_generation === undefined) continue;
        claimed.push({
          occurrence: toOccurrence(updated),
          fence: { occurrenceId: updated.id, leaseToken: updated.lease_token, generation: Number(updated.claim_generation) },
          workspaceId: schedule.workspace_id,
          conversationId: schedule.conversation_id,
          skillId: schedule.skill_id
        });
      }
      return claimed;
    });
  }

  public async assertDispatchCurrent(fence: AutomationLeaseFence): Promise<boolean> {
    return await this.dataSource.transaction(async (manager) => await this.withCurrentFence(manager, fence, true));
  }

  public async beginDispatch(fence: AutomationLeaseFence): Promise<boolean> {
    return await this.dataSource.transaction(async (manager) => {
      if (!(await this.withCurrentFence(manager, fence, true))) return false;
      const updated = rows<{ readonly id: string }>(await manager.query(`
        UPDATE "automation_occurrences" SET "status"='dispatching',"updated_at"=clock_timestamp()
        WHERE "id"=$1 AND "status"='claimed' AND "lease_token"=$2 AND "claim_generation"=$3
          AND "lease_expires_at">clock_timestamp()
        RETURNING "id"
      `, [fence.occurrenceId, fence.leaseToken, fence.generation]));
      return updated.length === 1;
    });
  }

  public async findOccurrence(ownerId: string, occurrenceId: string): Promise<AutomationOccurrence | null> {
    const occurrence = rows<OccurrenceRow>(await this.dataSource.query(
      `${OCCURRENCE_SELECT} WHERE "owner_id"=$1 AND "id"=$2`, [ownerId, occurrenceId]
    ))[0];
    return occurrence ? toOccurrence(occurrence) : null;
  }

  public async heartbeat(fence: AutomationLeaseFence, leaseMilliseconds: number): Promise<boolean> {
    const result = rows<{ readonly id: string }>(await this.dataSource.query(`
      UPDATE "automation_occurrences" SET "lease_expires_at"=clock_timestamp()+($4::integer*interval '1 millisecond'),
        "heartbeat_at"=clock_timestamp(),"updated_at"=clock_timestamp()
      WHERE "id"=$1 AND "lease_token"=$2 AND "claim_generation"=$3 AND "lease_expires_at">clock_timestamp()
      RETURNING "id"
    `, [fence.occurrenceId, fence.leaseToken, fence.generation, leaseMilliseconds]));
    return result.length === 1;
  }

  public async recordTurnStatus(input: AutomationLeaseFence & { readonly status: AutomationOccurrenceStatus; readonly failureCode?: string }): Promise<boolean> {
    const terminal = TERMINAL_OCCURRENCE_STATUSES.has(input.status);
    const result = rows<{ readonly id: string }>(await this.dataSource.query(`
      UPDATE "automation_occurrences" SET "status"=$4,"failure_code"=$5,
        "lease_token"=CASE WHEN $6 THEN NULL ELSE "lease_token" END,
        "lease_expires_at"=CASE WHEN $6 THEN NULL ELSE "lease_expires_at" END,"updated_at"=clock_timestamp()
      WHERE "id"=$1 AND "lease_token"=$2 AND "claim_generation"=$3 AND "lease_expires_at">clock_timestamp() RETURNING "id"
    `, [input.occurrenceId, input.leaseToken, input.generation, input.status, input.failureCode ?? null, terminal]));
    return result.length === 1;
  }

  /** Ends one bounded poll without leaving the next pass waiting for lease expiry. */
  public async releasePollingClaim(fence: AutomationLeaseFence): Promise<boolean> {
    const result = rows<{ readonly id: string }>(await this.dataSource.query(`
      UPDATE "automation_occurrences" SET "lease_token"=NULL,"lease_expires_at"=NULL,"updated_at"=clock_timestamp()
      WHERE "id"=$1 AND "lease_token"=$2 AND "claim_generation"=$3 AND "lease_expires_at">clock_timestamp()
        AND "status" IN ('running','cancel_requested','interrupted_unknown') RETURNING "id"
    `, [fence.occurrenceId, fence.leaseToken, fence.generation]));
    return result.length === 1;
  }

  public async recordCancellationResult(input: { readonly occurrenceId: string; readonly status: 'succeeded' | 'failed' | 'cancelled' | 'skipped' | 'interrupted_unknown' }): Promise<boolean> {
    const unresolved = input.status === 'interrupted_unknown';
    const result = rows<{ readonly id: string }>(await this.dataSource.query(`
      UPDATE "automation_occurrences" SET "status"=$2,"failure_code"=CASE WHEN $2 IN ('succeeded','failed','cancelled','skipped') THEN NULL ELSE 'CANCELLATION_UNCONFIRMED' END,
        "claim_generation"="claim_generation"+CASE WHEN $3 THEN 1 ELSE 0 END,
        "lease_token"=CASE WHEN $3 THEN gen_random_uuid() ELSE NULL END,
        "lease_expires_at"=CASE WHEN $3 THEN clock_timestamp()+interval '2 minutes' ELSE NULL END,
        "heartbeat_at"=CASE WHEN $3 THEN clock_timestamp() ELSE "heartbeat_at" END,"updated_at"=clock_timestamp()
      WHERE "id"=$1 AND "status"='cancel_requested' RETURNING "id"
    `, [input.occurrenceId, input.status, unresolved]));
    return result.length === 1;
  }

  public async finishWithoutTurn(input: AutomationLeaseFence & { readonly status: 'failed' | 'skipped'; readonly failureCode: string }): Promise<boolean> {
    const result = rows<{ readonly id: string }>(await this.dataSource.query(`
      UPDATE "automation_occurrences" SET "status"=$4,"failure_code"=$5,"lease_token"=NULL,
        "lease_expires_at"=NULL,"updated_at"=clock_timestamp()
      WHERE "id"=$1 AND "lease_token"=$2 AND "claim_generation"=$3 AND "home_turn_id" IS NULL
        AND "lease_expires_at">clock_timestamp() RETURNING "id"
    `, [input.occurrenceId, input.leaseToken, input.generation, input.status, input.failureCode]));
    return result.length === 1;
  }

  public async releaseSafeClaim(input: AutomationLeaseFence, failureCode: string): Promise<boolean> {
    const result = rows<{ readonly id: string }>(await this.dataSource.query(`
      UPDATE "automation_occurrences" SET "status"=CASE WHEN "attempt_count"<3 THEN 'queued' ELSE 'failed' END,
        "failure_code"=$4,"lease_token"=NULL,"lease_expires_at"=NULL,"updated_at"=clock_timestamp()
      WHERE "id"=$1 AND "lease_token"=$2 AND "claim_generation"=$3 AND "home_turn_id" IS NULL
        AND "lease_expires_at">clock_timestamp() RETURNING "id"
    `, [input.occurrenceId, input.leaseToken, input.generation, failureCode]));
    return result.length === 1;
  }

  public async recordTaskSources(input: { readonly ownerId: string; readonly fence: AutomationLeaseFence; readonly sources: readonly AutomationTaskSourceRevision[] }): Promise<'recorded' | 'limit_exceeded' | 'lease_lost'> {
    const incoming = normalizeIncomingTaskSources(input.sources);
    return await this.dataSource.transaction(async (manager) => {
      if (!await this.withCurrentFence(manager, input.fence, true)) return 'lease_lost';
      const current = rows<{ readonly task_source_revisions: unknown }>(await manager.query(`
        SELECT "task_source_revisions" FROM "automation_occurrences"
        WHERE "id"=$1 AND "owner_id"=$2 AND "lease_token"=$3 AND "claim_generation"=$4
          AND "lease_expires_at">clock_timestamp() AND "status"='running'
        FOR UPDATE
      `, [input.fence.occurrenceId, input.ownerId, input.fence.leaseToken, input.fence.generation]))[0];
      if (!current) return 'lease_lost';
      const existing = parseTaskSources(current.task_source_revisions);
      const keys = new Set(existing.map((source) => `${source.taskId}:${source.revision}`));
      const additions = incoming.filter((source) => !keys.has(`${source.taskId}:${source.revision}`));
      if (existing.length + additions.length > 256) {
        await manager.query(`
          UPDATE "automation_occurrences" SET "status"='failed',"failure_code"='TASK_SOURCE_LIMIT',
            "lease_token"=NULL,"lease_expires_at"=NULL,"updated_at"=clock_timestamp()
          WHERE "id"=$1 AND "owner_id"=$2 AND "lease_token"=$3 AND "claim_generation"=$4
            AND "lease_expires_at">clock_timestamp()
        `, [input.fence.occurrenceId, input.ownerId, input.fence.leaseToken, input.fence.generation]);
        return 'limit_exceeded';
      }
      if (!additions.length) return 'recorded';
      const combined = [...existing, ...additions].map((source) => ({ id: source.taskId, revision: source.revision }));
      const updated = rows<{ readonly id: string }>(await manager.query(`
        UPDATE "automation_occurrences" SET "task_source_revisions"=$5::jsonb,"updated_at"=clock_timestamp()
        WHERE "id"=$1 AND "owner_id"=$2 AND "lease_token"=$3 AND "claim_generation"=$4
          AND "lease_expires_at">clock_timestamp() AND "status"='running'
        RETURNING "id"
      `, [input.fence.occurrenceId, input.ownerId, input.fence.leaseToken, input.fence.generation, JSON.stringify(combined)]));
      return updated.length === 1 ? 'recorded' : 'lease_lost';
    });
  }

  public async markBudgetSkipped(input: { readonly ownerId: string; readonly fence: AutomationLeaseFence }): Promise<boolean> {
    return await this.dataSource.transaction(async (manager) => {
      if (!await this.withCurrentFence(manager, input.fence, true)) return false;
      const updated = rows<{ readonly id: string }>(await manager.query(`
        UPDATE "automation_occurrences" SET "status"='skipped',"failure_code"='BUDGET_EXHAUSTED',
          "lease_token"=NULL,"lease_expires_at"=NULL,"updated_at"=clock_timestamp()
        WHERE "id"=$1 AND "owner_id"=$2 AND "lease_token"=$3 AND "claim_generation"=$4
          AND "lease_expires_at">clock_timestamp() AND "status"='running' AND "home_turn_id" IS NOT NULL
        RETURNING "id"
      `, [input.fence.occurrenceId, input.ownerId, input.fence.leaseToken, input.fence.generation]));
      return updated.length === 1;
    });
  }

  private async withCurrentFence(manager: EntityManager, fence: AutomationLeaseFence, automaticOnly: boolean): Promise<boolean> {
    const pointer = rows<{ readonly owner_id: string; readonly schedule_id: string; readonly schedule_revision: number; readonly kind: string }>(await manager.query(`
      SELECT "owner_id","schedule_id","schedule_revision","kind" FROM "automation_occurrences"
      WHERE "id"=$1 AND "lease_token"=$2 AND "claim_generation"=$3 AND "lease_expires_at">clock_timestamp()
    `, [fence.occurrenceId, fence.leaseToken, fence.generation]))[0];
    if (!pointer) return false;
    const owner = rows<{ readonly active: boolean }>(await manager.query(`
      SELECT ("is_active" AND ("expires_at" IS NULL OR "expires_at">clock_timestamp())) AS "active"
      FROM "users" WHERE "id"=$1 FOR UPDATE
    `, [pointer.owner_id]
    ))[0];
    if (!owner?.active) return false;
    const cleanup = rows<{ readonly id: string }>(await manager.query(`
      SELECT dc."admission_id" AS "id" FROM "demo_expiry_cleanups" dc
      JOIN "demo_admissions" da ON da."id"=dc."admission_id" WHERE da."owner_id"=$1 LIMIT 1
    `, [pointer.owner_id]))[0];
    if (cleanup) return false;
    const schedule = rows<{ readonly id: string; readonly enabled: boolean; readonly revision: number; readonly workspace_id: string;
      readonly conversation_id: string; readonly skill_id: string; readonly skill_revision_id: string; readonly skill_version: number }>(await manager.query(`
      SELECT "id","enabled","revision","workspace_id","conversation_id","skill_id","skill_revision_id","skill_version"
      FROM "automation_schedules" WHERE "owner_id"=$1 AND "id"=$2 FOR UPDATE
    `, [pointer.owner_id, pointer.schedule_id]))[0];
    if (!schedule || Number(schedule.revision) !== Number(pointer.schedule_revision)) return false;
    const occurrence = rows<{ readonly skill_version: number; readonly skill_revision_id: string }>(await manager.query(`
      SELECT "skill_version","skill_revision_id" FROM "automation_occurrences"
      WHERE "id"=$1 AND "owner_id"=$2 AND "schedule_id"=$3 AND "schedule_revision"=$4
        AND "lease_token"=$5 AND "claim_generation"=$6 AND "lease_expires_at">clock_timestamp() FOR UPDATE
    `, [fence.occurrenceId, pointer.owner_id, pointer.schedule_id, pointer.schedule_revision, fence.leaseToken, fence.generation]))[0];
    if (!occurrence || automaticOnly && pointer.kind !== 'manual' && !schedule.enabled) return false;
    const workspace = rows<{ readonly id: string }>(await manager.query(`
      SELECT p."id" FROM "projects" p WHERE p."owner_id"=$1 AND p."id"=$2 AND p."status"='active'
        AND NOT EXISTS(SELECT 1 FROM "project_removal_jobs" j WHERE j."project_id"=p."id")
    `, [pointer.owner_id, schedule.workspace_id]))[0];
    if (!workspace) return false;
    const skill = await findCurrentSkill(manager, pointer.owner_id, schedule.skill_id);
    if (!skill || !skill.enabled || skill.revision_id !== schedule.skill_revision_id
      || Number(skill.current_version) !== Number(schedule.skill_version)
      || occurrence.skill_revision_id !== skill.revision_id || Number(occurrence.skill_version) !== Number(skill.current_version)) return false;
    try { assertReadOnlySkill(skill, schedule.workspace_id, Number(schedule.skill_version), schedule.skill_revision_id); }
    catch { return false; }
    return true;
  }
}
