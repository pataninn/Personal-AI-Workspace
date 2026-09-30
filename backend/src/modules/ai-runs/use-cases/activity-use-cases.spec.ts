import type { AiRun, EgressManifest } from '@/modules/ai-runs/domain/ai-run-types';
import type { AiRunActivityRecordPage } from '@/modules/ai-runs/domain/activity-types';
import type { ProposedChangeSet } from '@/modules/ai-runs/domain/change-types';
import type { IConversationRepository } from '@/modules/conversations/repositories/conversation-repository';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IAiRunRepository } from '@/modules/ai-runs/repositories/ai-run-repository';
import type { IProposedChangeSetRepository } from '@/modules/ai-runs/repositories/change-set-repository';
import { GetAiRunActivityUseCase, ListAiRunActivityUseCase } from '@/modules/ai-runs/use-cases/activity-use-cases';
import { AiRunNotFoundError, AiRunValidationError } from '@/modules/ai-runs/domain/ai-run-errors';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const MESSAGE_ID = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-09-30T00:00:00.000Z');

function makeRun(overrides: Partial<AiRun> = {}): AiRun {
  const manifest: EgressManifest = {
    manifestHash: 'a'.repeat(64), provider: 'NVIDIA hosted NIM', providerProfile: 'nvidia-hosted-nim', model: 'nvidia/nemotron-3-super-120b-a12b',
    categories: ['Request', 'Project files', 'Project facts'],
    files: [{ relativePath: 'src/app.ts', sourceHash: 'b'.repeat(64), sizeBytes: 12 }],
    facts: [{ id: MESSAGE_ID, title: 'Project goal', content: 'fact body must stay private', source: { kind: 'user', label: 'Added by you', reference: null }, version: 1, verifiedAt: null, verificationStatus: 'verified', updatedAt: NOW.toISOString(), sizeBytes: 28, sourceHash: 'c'.repeat(64) }],
    requestBytes: 32, messageBytes: 0, messageCount: 0, messageHash: 'd'.repeat(64), byteEstimate: 32, tokenEstimate: 8,
    excludedItemCount: 0, omittedItemCount: 0, omissionSummary: 'No items omitted.', bestEffortSecretDetection: true
  };
  return {
    id: RUN_ID, ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, request: 'token=super-secret inspect the project', relativeRoot: '', requestedPaths: [],
    manifest, manifestInvalidated: false, status: 'succeeded', phase: 'terminal', decision: 'approved', cleanup: 'complete', providerTransmission: 'transmitted_confirmed', stagingItemCount: 0,
    sandboxReady: true, assistantMessageId: MESSAGE_ID, assistantComplete: true, safeMessage: 'done', createdAt: NOW, updatedAt: NOW, ...overrides
  };
}

function projectRepository(owned = true): IProjectRepository {
  return { findByIdForOwner: jest.fn(async () => owned ? ({ id: PROJECT_ID, ownerId: OWNER_ID, name: 'Project', slug: 'project', relativeRoot: 'project', status: 'active', version: 1, createdAt: NOW, updatedAt: NOW }) : null) } as unknown as IProjectRepository;
}

describe('Project AI run activity use cases', () => {
  it('returns bounded metadata, separates estimated and provider usage, and validates filters', async () => {
    const run = makeRun();
    const page: AiRunActivityRecordPage = { records: [{ run, changeSet: null }], hasMore: false };
    const listActivityForProjectOwner = jest.fn(async () => page);
    const repository = { listActivityForProjectOwner } as unknown as IAiRunRepository;
    const useCase = new ListAiRunActivityUseCase(projectRepository(), repository);

    const result = await useCase.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, limit: '8', filter: 'all' });

    expect(result.items[0]?.requestPreview).toContain('token=[REDACTED]');
    expect(result.items[0]?.requestPreview).not.toContain('super-secret');
    expect(result.items[0]?.context.estimatedTokens).toBe(8);
    expect(result.items[0]?.usage).toEqual({ status: 'not_reported', promptTokens: null, completionTokens: null, totalTokens: null });
    expect(result.items[0]?.cost.label).toBe('Unavailable — no rate configured');
    expect(listActivityForProjectOwner).toHaveBeenCalledWith(expect.objectContaining({ filter: 'all', limit: 8 }));
    await expect(useCase.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, filter: 'unknown' })).rejects.toBeInstanceOf(AiRunValidationError);
  });

  it('does not reveal history for projects owned by someone else', async () => {
    const listActivityForProjectOwner = jest.fn();
    const useCase = new ListAiRunActivityUseCase(projectRepository(false), { listActivityForProjectOwner } as unknown as IAiRunRepository);

    await expect(useCase.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID })).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    expect(listActivityForProjectOwner).not.toHaveBeenCalled();
  });

  it('returns redacted, bounded run details without context, change, hash, or recovery payloads', async () => {
    const run = makeRun();
    const changeSet = {
      id: 'change-set-id', runId: RUN_ID, ownerId: OWNER_ID, projectId: PROJECT_ID, proposalHash: 'f'.repeat(64), status: 'applied', decision: 'approved',
      operations: [{ operationId: 'operation-id', operation: 'edit', path: 'src/app.ts', content: 'private change body', summary: 'Change app', expectedSourceHash: 'e'.repeat(64), sourcePresent: true, destinationPresent: false, backupRequired: true, preview: { text: 'private preview', limited: false, kind: 'diff' }, sizeBytes: 10, lineCount: 1, reviewable: true }],
      counts: { total: 1, creates: 0, edits: 1, overwrites: 0, renames: 0, deletes: 0, destructive: 0 }, totalSizeBytes: 10, totalLineCount: 1, previewLimitBytes: 100, previewLimitLines: 10, fakeRuntime: false,
      result: { persisted: true, operations: [{ operationId: 'operation-id', operation: 'edit', path: 'src/app.ts', status: 'applied', backup: 'created', backupReference: 'private-recovery-reference', safeMessage: 'Applied safely.' }], appliedCount: 1, skippedCount: 0, failedCount: 0, backupCount: 1 },
      createdAt: NOW, updatedAt: NOW, safeMessage: 'Applied.'
    } as unknown as ProposedChangeSet;
    const aiRunRepository = { findByIdForOwner: jest.fn(async () => run) } as unknown as IAiRunRepository;
    const changeSetRepository = { findByRunForOwner: jest.fn(async () => changeSet) } as unknown as IProposedChangeSetRepository;
    const conversationRepository = { findMessageForOwner: jest.fn(async () => ({ id: MESSAGE_ID, conversationId: CONVERSATION_ID, role: 'assistant', sequence: 2, content: 'password=hunter2 Safe answer.', createdAt: NOW })) } as unknown as IConversationRepository;
    const useCase = new GetAiRunActivityUseCase(aiRunRepository, changeSetRepository, conversationRepository);

    const detail = await useCase.execute({ ownerId: OWNER_ID, runId: RUN_ID });
    const serialized = JSON.stringify(detail);

    expect(detail.assistantPreview).toContain('password=[REDACTED]');
    expect(detail.operations).toEqual([{ operation: 'edit', path: 'src/app.ts', outcome: 'applied', backupStatus: 'created' }]);
    expect(serialized).not.toContain('fact body must stay private');
    expect(serialized).not.toContain('private change body');
    expect(serialized).not.toContain('private preview');
    expect(serialized).not.toContain('private-recovery-reference');
    expect(serialized).not.toContain('e'.repeat(64));
  });

  it('hides a run that is missing or owned by another principal', async () => {
    const aiRunRepository = { findByIdForOwner: jest.fn(async () => null) } as unknown as IAiRunRepository;
    const useCase = new GetAiRunActivityUseCase(aiRunRepository, {} as IProposedChangeSetRepository, {} as IConversationRepository);

    await expect(useCase.execute({ ownerId: 'foreign-owner', runId: RUN_ID })).rejects.toBeInstanceOf(AiRunNotFoundError);
  });
});
