import { AiRunValidationError } from '@/modules/ai-runs/domain/ai-run-errors';
import type { ProjectFileHistoryItemDto, ProjectFileHistoryOutcome, ProjectFileHistoryPageDto } from '@/modules/ai-runs/domain/file-history-types';
import type { IProposedChangeSetRepository } from '@/modules/ai-runs/repositories/change-set-repository';
import { ProjectNotFoundError } from '@/modules/projects/domain/project-errors';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import { redactSensitiveText } from '@/infrastructure/workspace/workspace-text';
import { WorkspaceRelativePath } from '@/modules/files/domain/workspace-path';
import { isProtectedFileName } from '@/modules/files/domain/workspace-policy';
import { CHANGE_SET_LIMITS } from '@/modules/ai-runs/domain/change-policy';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const SUMMARY_MAX_BYTES = 240;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ListProjectFileHistoryInput {
  readonly ownerId: string;
  readonly projectId: string;
  readonly path?: unknown;
  readonly outcome?: unknown;
  readonly limit?: unknown;
  readonly cursor?: unknown;
}

export class ListProjectFileHistoryUseCase {
  public constructor(private readonly projectRepository: IProjectRepository, private readonly changeSets: IProposedChangeSetRepository) {}

  public async execute(input: ListProjectFileHistoryInput): Promise<ProjectFileHistoryPageDto> {
    const project = await this.projectRepository.findByIdForOwner(input.ownerId, input.projectId);
    if (!project) throw new ProjectNotFoundError();
    const path = parsePath(input.path);
    const outcome = parseOutcome(input.outcome);
    const limit = parseLimit(input.limit);
    const cursor = parseCursor(input.cursor, path, outcome);
    const page = await this.changeSets.listFileHistoryForProjectOwner({
      ownerId: input.ownerId,
      projectId: input.projectId,
      path,
      outcome,
      limit,
      ...(cursor ? { cursor } : {})
    });
    const last = page.records[page.records.length - 1];
    return {
      projectId: input.projectId,
      path,
      outcome,
      items: page.records.map((record): ProjectFileHistoryItemDto => ({
        changeSetId: record.changeSetId,
        projectId: record.projectId,
        runId: record.runId,
        conversationId: record.conversationId,
        operationId: record.operationId,
        operationIndex: record.operationIndex,
        operation: record.operation,
        matchedPath: record.matchedPath,
        path: record.path,
        ...(record.destinationPath ? { destinationPath: record.destinationPath } : {}),
        summary: safeSummary(record.summary),
        changeSetStatus: record.changeSetStatus,
        operationStatus: record.operationStatus,
        backupStatus: record.backupStatus,
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString()
      })),
      nextCursor: page.hasMore && last ? encodeCursor(last.createdAt.toISOString(), last.changeSetId, last.operationIndex, path, outcome) : null
    };
  }
}

function parsePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw validation('path', 'Enter a normalized relative project file path.');
  try {
    const normalized = WorkspaceRelativePath.parse(value, { field: 'path', maxLength: CHANGE_SET_LIMITS.maxPathLength }).value;
    if (isProtectedFileName(normalized)) throw validation('path', 'Protected file paths are not available in file history.');
    return normalized;
  } catch {
    throw validation('path', 'Enter a normalized relative project file path.');
  }
}

function parseOutcome(value: unknown): ProjectFileHistoryOutcome {
  if (value === undefined || value === 'all') return 'all';
  if (value === 'applied') return 'applied';
  throw validation('outcome', 'Choose all outcomes or applied changes.');
}

function parseLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (typeof value !== 'string' && typeof value !== 'number') throw validation('limit', 'Page size must be between 1 and 50.');
  const text = String(value);
  if (!/^\d{1,2}$/u.test(text)) throw validation('limit', 'Page size must be between 1 and 50.');
  const limit = Number(text);
  if (limit < 1 || limit > MAX_LIMIT) throw validation('limit', 'Page size must be between 1 and 50.');
  return limit;
}

function parseCursor(value: unknown, path: string, outcome: ProjectFileHistoryOutcome): { readonly createdAt: Date; readonly changeSetId: string; readonly operationIndex: number } | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw invalidCursor();
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (decoded.path !== path || decoded.outcome !== outcome || typeof decoded.createdAt !== 'string' || typeof decoded.changeSetId !== 'string' || !UUID_PATTERN.test(decoded.changeSetId) || typeof decoded.operationIndex !== 'number' || !Number.isSafeInteger(decoded.operationIndex) || decoded.operationIndex < 0) throw invalidCursor();
    const createdAt = new Date(decoded.createdAt);
    if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== decoded.createdAt) throw invalidCursor();
    return { createdAt, changeSetId: decoded.changeSetId.toLowerCase(), operationIndex: decoded.operationIndex };
  } catch {
    throw invalidCursor();
  }
}

function encodeCursor(createdAt: string, changeSetId: string, operationIndex: number, path: string, outcome: ProjectFileHistoryOutcome): string {
  return Buffer.from(JSON.stringify({ createdAt, changeSetId, operationIndex, path, outcome })).toString('base64url');
}

function safeSummary(value: string): string {
  const sanitized = redactSensitiveText(value).replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
  let result = '';
  for (const character of sanitized) {
    if (Buffer.byteLength(result + character, 'utf8') > SUMMARY_MAX_BYTES) break;
    result += character;
  }
  return result;
}

function validation(field: string, message: string): AiRunValidationError {
  return new AiRunValidationError([{ field, message }]);
}

function invalidCursor(): AiRunValidationError {
  return validation('cursor', 'The file history cursor is invalid or belongs to another filter.');
}
