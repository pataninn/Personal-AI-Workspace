import { InMemoryAiRunRepository } from '@/infrastructure/ai-runs/in-memory-ai-run-repository';
import { SendChatMessageUseCase } from '@/modules/ai-runs/use-cases/send-chat-message-use-case';
import type { IProjectFactRepository } from '@/modules/memory/repositories/project-fact-repository';
import type { ProjectFact } from '@/modules/memory/domain/project-fact';
import type { EgressManifest } from '@/modules/ai-runs/domain/ai-run-types';

const manifest: EgressManifest = { manifestHash: 'a'.repeat(64), provider: 'NVIDIA hosted NIM', providerProfile: 'nvidia-hosted-nim', model: 'test-model',
  categories: ['Request'], files: [], requestBytes: 5, messageBytes: 0, messageCount: 0, messageHash: 'b'.repeat(64), byteEstimate: 5, tokenEstimate: 2,
  excludedItemCount: 0, omittedItemCount: 0, omissionSummary: 'No selected items were excluded.', bestEffortSecretDetection: true };
const input = { ownerId: 'owner', projectId: 'project', conversationId: 'conversation', request: 'Hello', idempotencyKey: 'chat-request-test' };

async function fixture(): Promise<{
  readonly useCase: SendChatMessageUseCase;
  readonly create: jest.Mock;
  readonly prepare: jest.Mock;
  readonly start: jest.Mock;
  readonly facts: jest.Mocked<IProjectFactRepository>;
  readonly run: Awaited<ReturnType<InMemoryAiRunRepository['create']>>['resource'];
}> {
  const repository = new InMemoryAiRunRepository();
  const { resource: run } = await repository.create({ ...input, relativeRoot: 'project', storageKind: 'legacy', requestedPaths: [], manifest, requestFingerprint: 'fingerprint' });
  const contexts = { get: jest.fn().mockResolvedValue({ relativePaths: ['README.md'], factIds: ['selected', 'deleted'], includeProjectConversations: true }), update: jest.fn() };
  const facts: jest.Mocked<IProjectFactRepository> = { findActiveByIds: jest.fn().mockResolvedValue([{ id: 'selected' } satisfies Pick<ProjectFact, 'id'>]),
    listActiveByProject: jest.fn(), findActiveById: jest.fn(), create: jest.fn(), update: jest.fn(), verify: jest.fn(), softDelete: jest.fn() };
  const create = jest.fn().mockResolvedValue({ resource: run, replayed: false });
  const prepare = jest.fn(async () => ({ ...run, decision: 'policy_authorized' as const, policyRevision: '2', status: 'ready' as const }));
  const start = jest.fn(async () => ({ resource: { ...run, decision: 'policy_authorized' as const, policyRevision: '2', status: 'queued' as const }, replayed: false }));
  return { useCase: new SendChatMessageUseCase(contexts, facts, { execute: create }, { preparePolicyAuthorizedRun: prepare }, { execute: start }), create, prepare, start, facts, run };
}

describe('SendChatMessageUseCase', () => {
  it('uses persisted project context and only prepares/starts a policy-authorized run internally', async () => {
    const { useCase, create, prepare, start, facts, run } = await fixture();
    const authorized = { ...run, decision: 'policy_authorized' as const, policyRevision: '2', status: 'staging' as const };
    create.mockResolvedValue({ resource: authorized, replayed: false });

    const result = await useCase.execute(input);

    expect(create).toHaveBeenCalledWith({ ...input, relativePaths: ['README.md'], factIds: ['selected'], includeRecentMessages: true, includeProjectConversations: true });
    expect(facts.findActiveByIds).toHaveBeenCalledWith('owner', 'project', ['selected', 'deleted']);
    expect(prepare).toHaveBeenCalledWith({ ownerId: input.ownerId, runId: run.id });
    expect(start).toHaveBeenCalledWith({ ownerId: input.ownerId, runId: run.id, idempotencyKey: `policy-start-${run.id}` });
    expect(result).toMatchObject({ replayed: false, resource: { id: run.id, conversationId: input.conversationId, status: 'queued', decision: 'policy_authorized', policyRevision: '2' } });
  });

  it('does not dispatch a legacy pending run through the internal policy path', async () => {
    const { useCase, prepare, start, run } = await fixture();

    await expect(useCase.execute(input)).resolves.toMatchObject({ resource: { id: run.id, status: 'pending_approval', decision: 'pending' } });

    expect(prepare).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('never rebinds or restarts a policy-authorized idempotency replay', async () => {
    const { useCase, create, prepare, start, run } = await fixture();
    create.mockResolvedValue({ resource: { ...run, decision: 'policy_authorized', policyRevision: '2', status: 'running' }, replayed: true });

    await expect(useCase.execute(input)).resolves.toMatchObject({ replayed: true, resource: { status: 'running' } });

    expect(prepare).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('does not start when policy preparation returns an unavailable state', async () => {
    const { useCase, create, prepare, start, run } = await fixture();
    create.mockResolvedValue({ resource: { ...run, decision: 'policy_authorized', policyRevision: '2', status: 'staging' }, replayed: false });
    prepare.mockResolvedValue({ ...run, decision: 'policy_authorized', policyRevision: '2', status: 'failed' });

    await expect(useCase.execute(input)).resolves.toMatchObject({ resource: { status: 'failed' } });

    expect(start).not.toHaveBeenCalled();
  });
});
