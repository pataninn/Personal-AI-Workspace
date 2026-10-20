import { createHash } from 'node:crypto';

import type { IProjectFileAccess, IProjectFileGateway } from '@/modules/files/repositories/project-file-access';
import { containsPotentialSecret } from '@/shared/egress/redaction';
import { AppError } from '@/shared/errors/app-error';
import {
  WORKSPACE_EXPORT_LIMITS,
  type WorkspaceExportDescriptor,
  type WorkspaceExportDocument
} from '@/modules/workspace-exports/domain/workspace-export';
import type { IWorkspaceExportArtifactStore, IWorkspaceExportRepository } from '@/modules/workspace-exports/repositories/workspace-export-repository';
import type { WorkspaceExportBuilderIdentity } from '@/modules/workspace-exports/domain/workspace-export';
import type { WorkspaceExportRecord } from '@/modules/workspace-exports/repositories/workspace-export-repository';

export interface CreateWorkspaceExportResult {
  readonly descriptor: WorkspaceExportDescriptor;
  readonly replayed: boolean;
}

export class CreateWorkspaceExportUseCase {
  public constructor(
    private readonly exports: IWorkspaceExportRepository,
    private readonly artifacts: IWorkspaceExportArtifactStore,
    private readonly files: IProjectFileAccess,
    private readonly gateway: IProjectFileGateway,
    private readonly getBuilderIdentity: () => Promise<WorkspaceExportBuilderIdentity>
  ) {}

  public async execute(input: { readonly ownerId: string; readonly workspaceId: string; readonly idempotencyKey: string }): Promise<CreateWorkspaceExportResult> {
    assertIdempotencyKey(input.idempotencyKey);
    const deadlineAt = Date.now() + WORKSPACE_EXPORT_LIMITS.deadlineMs;
    const builder = await this.getBuilderIdentity().catch(() => { throw exportFailed(); });
    const keyDigest = digest(input.idempotencyKey);
    const requestFingerprint = digest(JSON.stringify({ workspaceId: input.workspaceId }));
    const started = await this.exports.begin({ ...input, keyDigest, requestFingerprint, builder });
    if (started.kind === 'replay') return { descriptor: started.descriptor, replayed: true };
    if (started.kind === 'in_progress') throw new AppError('EXPORT_IN_PROGRESS', 409, 'This export is still being prepared. Retry the same request.');
    if (started.kind === 'expired_key') throw new AppError('IDEMPOTENCY_KEY_EXPIRED', 409, 'This export key has expired. Use a new key.');
    if (Date.now() >= deadlineAt) {
      await this.exports.markFailed(started.record.id);
      throw exportTooLarge();
    }
    return this.waitForBuilder(this.build(input, started.record, deadlineAt), deadlineAt);
  }

  private async build(
    input: { readonly ownerId: string; readonly workspaceId: string },
    record: WorkspaceExportRecord,
    deadlineAt: number
  ): Promise<CreateWorkspaceExportResult> {
    try {
      const snapshot = await this.exports.captureSnapshot(input.ownerId, input.workspaceId);
      if (containsPotentialSecret(JSON.stringify(snapshot))) throw exportContentUnsafe();
      assertDeadline(deadlineAt);
      const filesReadStartedAt = new Date().toISOString();
      const files = snapshot.fileBacked ? await this.files.execute({ ownerId: input.ownerId, projectId: input.workspaceId }, (scope) => this.gateway.captureForExport(scope, {
        maxFiles: WORKSPACE_EXPORT_LIMITS.maxFiles,
        maxTotalBytes: WORKSPACE_EXPORT_LIMITS.maxFileTotalBytes,
        deadlineAt
      })) : [];
      const filesReadCompletedAt = new Date().toISOString();
      const document = createDocument(snapshot, files, record.createdAt.toISOString(), filesReadStartedAt, filesReadCompletedAt);
      const structuredBytes = Buffer.byteLength(JSON.stringify(structuredProjection(document)), 'utf8');
      if (structuredBytes > WORKSPACE_EXPORT_LIMITS.maxStructuredBytes) throw exportTooLarge();
      const bytes = Buffer.from(JSON.stringify(document), 'utf8');
      if (bytes.byteLength > WORKSPACE_EXPORT_LIMITS.maxDocumentBytes) throw exportTooLarge();
      assertDeadline(deadlineAt);
      await this.artifacts.write(record.id, bytes);
      assertDeadline(deadlineAt);
      const descriptor = await this.exports.publish(record.id, input.ownerId, input.workspaceId, record.demoCleanupGeneration, bytes.byteLength, deadlineAt);
      if (!descriptor) throw exportUnavailable();
      return { descriptor, replayed: false };
    } catch (error: unknown) {
      await this.artifacts.remove(record.id).catch(() => undefined);
      await this.exports.markFailed(record.id).catch(() => undefined);
      throw safeExportError(error);
    }
  }

  private async waitForBuilder(work: Promise<CreateWorkspaceExportResult>, deadlineAt: number): Promise<CreateWorkspaceExportResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(exportTooLarge()), Math.max(1, deadlineAt - Date.now()));
    });
    try { return await Promise.race([work, deadline]); }
    finally { if (timer) clearTimeout(timer); }
  }
}

function createDocument(
  snapshot: Awaited<ReturnType<IWorkspaceExportRepository['captureSnapshot']>>,
  files: WorkspaceExportDocument['files'],
  createdAt: string,
  filesReadStartedAt: string,
  filesReadCompletedAt: string
): WorkspaceExportDocument {
  return {
    manifest: {
      format: 'personal-ai-workspace-export', version: 1, createdAt,
      databaseSnapshotAt: snapshot.databaseSnapshotAt, filesReadStartedAt, filesReadCompletedAt
    },
    workspace: snapshot.workspace,
    files,
    tasks: snapshot.tasks,
    memory: { facts: snapshot.facts, context: snapshot.context },
    conversations: { project: snapshot.projectConversations, home: snapshot.homeConversations },
    skills: snapshot.skills,
    schedules: snapshot.schedules
  };
}

function structuredProjection(document: WorkspaceExportDocument): Omit<WorkspaceExportDocument, 'files' | 'manifest'> {
  return {
    workspace: document.workspace,
    tasks: document.tasks,
    memory: document.memory,
    conversations: document.conversations,
    skills: document.skills,
    schedules: document.schedules
  };
}

function assertIdempotencyKey(value: string): void {
  if (!/^[A-Za-z0-9._~-]{8,128}$/u.test(value)) throw new AppError('VALIDATION_ERROR', 400, 'The export request is invalid.');
}

function assertDeadline(deadlineAt: number): void {
  if (Date.now() >= deadlineAt) throw exportTooLarge();
}

function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function exportTooLarge(): AppError { return new AppError('EXPORT_TOO_LARGE', 413, 'The workspace export exceeds its safe limits.'); }
function exportContentUnsafe(): AppError { return new AppError('EXPORT_CONTENT_UNSAFE', 422, 'Workspace content contains text that looks like a credential. Remove it before exporting.'); }
function exportUnavailable(): AppError { return new AppError('WORKSPACE_UNAVAILABLE', 404, 'The workspace is unavailable.'); }
function exportFailed(): AppError { return new AppError('EXPORT_FAILED', 500, 'The workspace export could not be prepared.'); }

function safeExportError(error: unknown): AppError {
  if (error instanceof AppError && error.code === 'EXPORT_TOO_LARGE') return error;
  if (error instanceof AppError && error.code === 'EXPORT_CONTENT_UNSAFE') return error;
  if (error instanceof AppError && error.code === 'WORKSPACE_UNAVAILABLE') return error;
  return exportFailed();
}
