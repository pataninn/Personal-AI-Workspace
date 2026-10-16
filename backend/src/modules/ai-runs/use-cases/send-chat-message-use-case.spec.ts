import { InMemoryAiRunRepository } from '@/infrastructure/ai-runs/in-memory-ai-run-repository';
import { AiRunProviderPermissionRevokedError } from '@/modules/ai-runs/domain/ai-run-errors';
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
  readonly approveWithRememberedPermission: jest.Mock;
  readonly facts: jest.Mocked<IProjectFactRepository>;
  readonly run: Awaited<ReturnType<InMemoryAiRunRepository['create']>>['resource'];
}> {
  const repository = new InMemoryAiRunRepository();
  const { resource: run } = await repository.create({ ...input, relativeRoot: 'project', requestedPaths: [], manifest, requestFingerprint: 'fingerprint' });
  const contexts = { get: jest.fn().mockResolvedValue({ relativePaths: ['README.md'], factIds: ['selected', 'deleted'], includeProjectConversations: true }), update: jest.fn() };
  const facts: jest.Mocked<IProjectFactRepository> = { findActiveByIds: jest.fn().mockResolvedValue([{ id: 'selected' } satisfies Pick<ProjectFact, 'id'>]),
    listActiveByProject: jest.fn(), findActiveById: jest.fn(), create: jest.fn(), update: jest.fn(), verify: jest.fn(), softDelete: jest.fn() };
  const create = jest.fn().mockResolvedValue({ resource: run, replayed: false });
  const approveWithRememberedPermission = jest.fn().mockResolvedValue(null);
  return {
    useCase: new SendChatMessageUseCase(contexts, facts, { execute: create }, { approveWithRememberedPermission }),
    create,
    approveWithRememberedPermission,
    facts,
    run
  };
}

describe('SendChatMessageUseCase', () => {
  it('preserves project context and conversation binding while returning pending consent without an exact remembered permission', async () => {
    const { useCase, create, approveWithRememberedPermission, facts, run } = await fixture();

    const result = await useCase.execute(input);

    expect(create).toHaveBeenCalledWith({ ...input, relativePaths: ['README.md'], factIds: ['selected'], includeRecentMessages: true, includeProjectConversations: true });
    expect(facts.findActiveByIds).toHaveBeenCalledWith('owner', 'project', ['selected', 'deleted']);
    expect(approveWithRememberedPermission).toHaveBeenCalledWith({ ownerId: 'owner', runId: run.id });
    expect(result).toMatchObject({ replayed: false, resource: { id: run.id, conversationId: input.conversationId, status: 'pending_approval', decision: 'pending' } });
  });

  it('applies an exact remembered permission and leaves the ready run for the existing explicit start route', async () => {
    const { useCase, approveWithRememberedPermission, run } = await fixture();
    approveWithRememberedPermission.mockResolvedValue({ ...run, decision: 'approved', status: 'ready' });

    await expect(useCase.execute(input)).resolves.toMatchObject({ resource: { id: run.id, conversationId: input.conversationId, status: 'ready', decision: 'approved' } });
    expect(approveWithRememberedPermission).toHaveBeenCalledWith({ ownerId: input.ownerId, runId: run.id });
  });

  it('keeps consent pending if a remembered permission is revoked during exact-scope approval', async () => {
    const { useCase, approveWithRememberedPermission, run } = await fixture();
    approveWithRememberedPermission.mockRejectedValue(new AiRunProviderPermissionRevokedError());

    await expect(useCase.execute(input)).resolves.toMatchObject({ resource: { id: run.id, status: 'pending_approval', decision: 'pending' } });
  });

  it('returns an existing running request without rechecking permission or creating a second run', async () => {
    const { useCase, create, approveWithRememberedPermission, run } = await fixture();
    create.mockResolvedValue({ resource: { ...run, status: 'running', decision: 'approved' }, replayed: true });

    await expect(useCase.execute(input)).resolves.toMatchObject({ replayed: true, resource: { status: 'running' } });
    expect(approveWithRememberedPermission).not.toHaveBeenCalled();
  });

  it('propagates failures while preparing an exact remembered-permission approval', async () => {
    const { useCase, approveWithRememberedPermission } = await fixture();
    approveWithRememberedPermission.mockRejectedValue(new Error('Context changed'));

    await expect(useCase.execute(input)).rejects.toThrow('Context changed');
  });
});
