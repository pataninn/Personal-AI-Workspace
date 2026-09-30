import { AiRunNotFoundError, AiRunValidationError } from '@/modules/ai-runs/domain/ai-run-errors';
import { AI_RUN_ACTIVITY_FILTERS, type AiRunActivityCost, type AiRunActivityDetail, type AiRunActivityFilter, type AiRunActivityItem, type AiRunActivityUsage } from '@/modules/ai-runs/domain/activity-types';
import type { AiRun, ProviderTransmissionStatus } from '@/modules/ai-runs/domain/ai-run-types';
import { CHANGE_SET_LIMITS } from '@/modules/ai-runs/domain/change-policy';
import type { IConversationRepository } from '@/modules/conversations/repositories/conversation-repository';
import { ProjectNotFoundError } from '@/modules/projects/domain/project-errors';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import { redactEgressText } from '@/shared/egress/redaction';
import type { IAiRunRepository } from '@/modules/ai-runs/repositories/ai-run-repository';
import type { IProposedChangeSetRepository } from '@/modules/ai-runs/repositories/change-set-repository';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const PREVIEW_MAX_BYTES = 800;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COST_UNAVAILABLE: AiRunActivityCost = { status: 'unavailable', label: 'Unavailable — no rate configured' };

export interface ListAiRunActivityInput {
  readonly ownerId: string;
  readonly projectId: string;
  readonly limit?: unknown;
  readonly cursor?: unknown;
  readonly filter?: unknown;
}

export class ListAiRunActivityUseCase {
  public constructor(private readonly projectRepository: IProjectRepository, private readonly aiRunRepository: IAiRunRepository) {}

  public async execute(input: ListAiRunActivityInput): Promise<{ readonly projectId: string; readonly items: readonly AiRunActivityItem[]; readonly nextCursor: string | null }> {
    const project = await this.projectRepository.findByIdForOwner(input.ownerId, input.projectId);
    if (!project) {
      throw new ProjectNotFoundError();
    }
    const filter = parseFilter(input.filter);
    const limit = parseLimit(input.limit);
    const cursor = parseCursor(input.cursor);
    if (!this.aiRunRepository.listActivityForProjectOwner) {
      throw new Error('The AI run activity query is unavailable.');
    }
    const page = await this.aiRunRepository.listActivityForProjectOwner({
      ownerId: input.ownerId,
      projectId: input.projectId,
      filter,
      limit,
      ...(cursor ? { cursor } : {})
    });
    const last = page.records[page.records.length - 1]?.run;
    return {
      projectId: input.projectId,
      items: page.records.map(({ run, changeSet }) => toActivityItem(run, changeSet)),
      nextCursor: page.hasMore && last ? encodeCursor(last) : null
    };
  }
}

export interface GetAiRunActivityInput {
  readonly ownerId: string;
  readonly runId: string;
}

export class GetAiRunActivityUseCase {
  public constructor(
    private readonly aiRunRepository: IAiRunRepository,
    private readonly changeSetRepository: IProposedChangeSetRepository,
    private readonly conversationRepository: IConversationRepository
  ) {}

  public async execute(input: GetAiRunActivityInput): Promise<AiRunActivityDetail> {
    const run = await this.aiRunRepository.findByIdForOwner(input.ownerId, input.runId);
    if (!run) {
      throw new AiRunNotFoundError();
    }
    const [changeSet, assistantMessage] = await Promise.all([
      this.changeSetRepository.findByRunForOwner(input.ownerId, run.id),
      run.assistantMessageId && this.conversationRepository.findMessageForOwner
        ? this.conversationRepository.findMessageForOwner({ ownerId: input.ownerId, projectId: run.projectId, conversationId: run.conversationId, messageId: run.assistantMessageId })
        : Promise.resolve(null)
    ]);
    const resultById = new Map(changeSet?.result?.operations.map((operation) => [operation.operationId, operation]) ?? []);
    const operations = (changeSet?.operations ?? []).slice(0, CHANGE_SET_LIMITS.maxOperations).map((operation) => {
      const result = resultById.get(operation.operationId);
      return {
        operation: operation.operation,
        path: safePreview(operation.path, 512),
        outcome: result?.status ?? changeSet?.status ?? 'unknown',
        backupStatus: result?.backup ?? (operation.backupRequired ? 'pending' : 'not_required')
      };
    });
    return {
      ...toActivityItem(run, changeSet ? {
        status: changeSet.status,
        operationCount: changeSet.operations.length,
        appliedCount: changeSet.result?.appliedCount ?? 0,
        skippedCount: changeSet.result?.skippedCount ?? 0,
        failedCount: changeSet.result?.failedCount ?? 0,
        backupCount: changeSet.result?.backupCount ?? 0
      } : null),
      assistantPreview: assistantMessage ? safePreview(assistantMessage.content) : null,
      selectedFiles: run.manifest.files.map((file) => safePreview(file.relativePath, 512)),
      selectedFactTitles: (run.manifest.facts ?? []).map((fact) => safePreview(fact.title, 256)),
      operations,
      omittedOperationCount: Math.max(0, (changeSet?.operations.length ?? 0) - operations.length)
    };
  }
}

function toActivityItem(run: AiRun, changeSet: AiRunActivityItem['changeSet']): AiRunActivityItem {
  return {
    runId: run.id,
    projectId: run.projectId,
    conversationId: run.conversationId,
    status: run.status,
    decision: run.decision,
    providerTransmission: run.providerTransmission,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    provider: run.manifest.provider,
    model: run.manifest.model,
    requestPreview: safePreview(run.request),
    context: {
      categories: [...run.manifest.categories],
      fileCount: run.manifest.files.length,
      factCount: run.manifest.facts?.length ?? 0,
      messageCount: run.manifest.messageCount,
      estimatedTokens: run.manifest.tokenEstimate
    },
    usage: toUsage(run.providerUsage, run.providerTransmission, run.status),
    cost: COST_UNAVAILABLE,
    changeSet
  };
}

function toUsage(usage: AiRun['providerUsage'], transmission: ProviderTransmissionStatus, status: AiRun['status']): AiRunActivityUsage {
  const values = [usage?.promptTokens, usage?.completionTokens, usage?.totalTokens];
  const supplied = values.filter((value) => value !== undefined && Number.isSafeInteger(value) && value >= 0).length;
  const usageStatus: AiRunActivityUsage['status'] = supplied === 3
    ? 'reported'
    : supplied > 0
      ? 'partial'
      : transmission === 'not_started' || transmission === 'not_started_confirmed'
        ? 'not_transmitted'
        : transmission === 'unknown'
          ? 'unknown'
          : isTerminal(status) ? 'not_reported' : 'unavailable';
  return {
    status: usageStatus,
    promptTokens: validCount(usage?.promptTokens),
    completionTokens: validCount(usage?.completionTokens),
    totalTokens: validCount(usage?.totalTokens)
  };
}

function isTerminal(status: AiRun['status']): boolean {
  return ['rejected', 'succeeded', 'failed', 'cancelled', 'blocked', 'review_required'].includes(status);
}

function validCount(value: number | undefined): number | null {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safePreview(value: string, maxBytes = PREVIEW_MAX_BYTES): string {
  const sanitized = redactEgressText(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
  let result = '';
  let usedBytes = 0;
  for (const character of sanitized) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (usedBytes + bytes > maxBytes) {
      return `${result}…`;
    }
    result += character;
    usedBytes += bytes;
  }
  return result;
}

function parseFilter(value: unknown): AiRunActivityFilter {
  if (value === undefined || value === 'all') {
    return 'all';
  }
  if (typeof value === 'string' && (AI_RUN_ACTIVITY_FILTERS as readonly string[]).includes(value)) {
    return value as AiRunActivityFilter;
  }
  throw new AiRunValidationError([{ field: 'filter', message: 'Choose a valid activity filter.' }]);
}

function parseLimit(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_LIMIT;
  }
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d{1,3}$/u.test(text)) {
    throw new AiRunValidationError([{ field: 'limit', message: 'Activity page size must be a number between 1 and 50.' }]);
  }
  const limit = Number(text);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new AiRunValidationError([{ field: 'limit', message: 'Activity page size must be a number between 1 and 50.' }]);
  }
  return limit;
}

function parseCursor(value: unknown): { readonly createdAt: Date; readonly id: string } | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw invalidCursor();
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!decoded || typeof decoded !== 'object') {
      throw invalidCursor();
    }
    const cursor = decoded as { readonly createdAt?: unknown; readonly id?: unknown };
    if (typeof cursor.createdAt !== 'string' || typeof cursor.id !== 'string' || !UUID_PATTERN.test(cursor.id)) {
      throw invalidCursor();
    }
    const createdAt = new Date(cursor.createdAt);
    if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== cursor.createdAt) {
      throw invalidCursor();
    }
    return { createdAt, id: cursor.id.toLowerCase() };
  } catch {
    throw invalidCursor();
  }
}

function encodeCursor(run: AiRun): string {
  return Buffer.from(JSON.stringify({ createdAt: run.createdAt.toISOString(), id: run.id })).toString('base64url');
}

function invalidCursor(): AiRunValidationError {
  return new AiRunValidationError([{ field: 'cursor', message: 'The activity cursor is invalid.' }]);
}
