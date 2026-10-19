import type { MessagePage } from '@/modules/conversations/domain/conversation-types';
import type { IConversationRepository } from '@/modules/conversations/repositories/conversation-repository';
import type { AiRun, EgressManifest } from '@/modules/ai-runs/domain/ai-run-types';
import type { IAgentRuntime, RuntimeCreateInput, RuntimeReadyResult } from '@/modules/ai-runs/repositories/agent-runtime';
import type { IStagingGateway } from '@/modules/ai-runs/repositories/staging-gateway';
import type { IWorkspaceGateway } from '@/modules/files/repositories/workspace-gateway';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import { InMemoryAiRunRepository } from '@/infrastructure/ai-runs/in-memory-ai-run-repository';
import { DecideEgressUseCase } from '@/modules/ai-runs/use-cases/ai-run-use-cases';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';

describe('DecideEgressUseCase direct provider path', () => {
  it('transitions to direct readiness without staging or OpenShell calls', async () => {
    const repository = new InMemoryAiRunRepository();
    const manifest = makeManifest();
    const created = await repository.create({ ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, request: 'Inspect', relativeRoot: 'project', storageKind: 'legacy', requestedPaths: [], manifest, idempotencyKey: 'create-direct-1', requestFingerprint: 'fingerprint' });
    const runtime = new DirectRuntime();
    const staging = new RejectingStagingGateway();
    const projects = { findByIdForOwner: jest.fn(async () => ({ id: PROJECT_ID, ownerId: OWNER_ID, name: 'Project', slug: 'project', relativeRoot: 'project', storageKind: 'legacy', objective: null, status: 'active', version: 1, createdAt: new Date(), updatedAt: new Date() })) } as unknown as IProjectRepository;
    const useCase = new DecideEgressUseCase(repository, projects, conversationRepository(), workspaceGateway(), staging, runtime, '/workspace');

    const result = await useCase.execute({ ownerId: OWNER_ID, runId: created.resource.id, manifestHash: manifest.manifestHash, decision: 'approve', idempotencyKey: 'decision-direct-1' });

    expect(result.status).toBe('ready');
    expect(result.runtimeKind).toBe('direct');
    expect(result.stagingItemCount).toBe(0);
    expect(runtime.prepared).toBe(1);
    expect(staging.called).toBe(false);
  });
});

class DirectRuntime implements IAgentRuntime {
  public readonly directProvider = true as const;
  public prepared = 0;

  public async checkAvailability(): Promise<void> { return Promise.resolve(); }
  public async prepareDirectRun(): Promise<RuntimeReadyResult> {
    this.prepared += 1;
    return { kind: 'direct', sandboxReady: true };
  }
  public async create(_input: RuntimeCreateInput): Promise<RuntimeReadyResult> { return { kind: 'direct', sandboxReady: true }; }
  public async destroy(): Promise<void> { return Promise.resolve(); }
}

class RejectingStagingGateway implements IStagingGateway {
  public called = false;
  public async stage(): Promise<never> {
    this.called = true;
    throw new Error('direct provider must not stage');
  }
  public async cleanup(): Promise<void> { return Promise.resolve(); }
  public async assertFresh(): Promise<void> { return Promise.resolve(); }
  public async cleanupExpired(): Promise<number> { return 0; }
}

function makeManifest(): EgressManifest {
  return {
    manifestHash: 'a'.repeat(64), provider: 'NVIDIA hosted NIM', providerProfile: 'nvidia-hosted-nim', model: 'nvidia/nemotron-3-super-120b-a12b',
    categories: ['Request'], files: [], requestBytes: 7, messageBytes: 0, messageCount: 0, messageHash: hash('[]'), byteEstimate: 7, tokenEstimate: 2,
    excludedItemCount: 0, omittedItemCount: 0, omissionSummary: 'No selected items were excluded or omitted.', bestEffortSecretDetection: true
  };
}

function conversationRepository(): IConversationRepository {
  return {
    listByProjectForOwner: jest.fn(),
    findWithMessagesForOwner: jest.fn(async (): Promise<MessagePage> => ({ conversation: {} as MessagePage['conversation'], messages: [], nextBeforeSequence: null })),
    create: jest.fn(), addUserMessage: jest.fn()
  };
}

function workspaceGateway(): IWorkspaceGateway {
  return { list: jest.fn(), tree: jest.fn(), readText: jest.fn(), searchText: jest.fn() };
}

function hash(value: string): string {
  const crypto = require('node:crypto') as typeof import('node:crypto');
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
