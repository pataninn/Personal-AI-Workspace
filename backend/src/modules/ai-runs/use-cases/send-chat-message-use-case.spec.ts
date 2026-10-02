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
  readonly decide: jest.Mock;
  readonly start: jest.Mock;
  readonly facts: jest.Mocked<IProjectFactRepository>;
  readonly run: Awaited<ReturnType<InMemoryAiRunRepository['create']>>['resource'];
}> {
  const repository = new InMemoryAiRunRepository();
  const { resource: run } = await repository.create({ ...input, relativeRoot: 'project', requestedPaths: [], manifest, requestFingerprint: 'fingerprint' });
  const contexts = { get: jest.fn().mockResolvedValue({ relativePaths: ['README.md'], factIds: ['selected', 'deleted'], includeProjectConversations: true }), update: jest.fn() };
  const facts: jest.Mocked<IProjectFactRepository> = { findActiveByIds: jest.fn().mockResolvedValue([{ id: 'selected' } satisfies Pick<ProjectFact, 'id'>]),
    listActiveByProject: jest.fn(), findActiveById: jest.fn(), create: jest.fn(), update: jest.fn(), verify: jest.fn(), softDelete: jest.fn() };
  const create = jest.fn().mockResolvedValue({ resource: run, replayed: false });
  const decide = jest.fn().mockResolvedValue({ ...run, decision: 'approved', status: 'ready' });
  const start = jest.fn().mockResolvedValue({ resource: { ...run, decision: 'approved', status: 'queued' }, replayed: false });
  return { useCase: new SendChatMessageUseCase(contexts, facts, { execute: create }, { execute: decide }, { execute: start }), create, decide, start, facts, run };
}

describe('SendChatMessageUseCase', () => {
  it('uses project-wide context, skips deleted facts, approves and starts the run in one action', async () => {
    const { useCase, create, decide, start, facts, run } = await fixture();
    const result = await useCase.execute(input);
    expect(create).toHaveBeenCalledWith({ ...input, relativePaths: ['README.md'], factIds: ['selected'], includeRecentMessages: true, includeProjectConversations: true });
    expect(facts.findActiveByIds).toHaveBeenCalledWith('owner', 'project', ['selected', 'deleted']);
    expect(decide).toHaveBeenCalledWith({ ownerId: 'owner', runId: run.id, manifestHash: manifest.manifestHash, decision: 'approve', idempotencyKey: `chat-approve-${run.id}` });
    expect(start).toHaveBeenCalledWith({ ownerId: 'owner', runId: run.id, idempotencyKey: `chat-start-${run.id}` });
    expect(result.resource).toMatchObject({ status: 'queued', decision: 'approved' });
  });

  it('returns an existing running request without approving or starting duplicate inference', async () => {
    const { useCase, create, decide, start, run } = await fixture();
    create.mockResolvedValue({ resource: { ...run, status: 'running', decision: 'approved' }, replayed: true });
    await expect(useCase.execute(input)).resolves.toMatchObject({ replayed: true, resource: { status: 'running' } });
    expect(decide).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });

  it('does not send to the provider when approval preparation fails', async () => {
    const { useCase, decide, start } = await fixture();
    decide.mockRejectedValue(new Error('Context changed'));
    await expect(useCase.execute(input)).rejects.toThrow('Context changed');
    expect(start).not.toHaveBeenCalled();
  });
});
