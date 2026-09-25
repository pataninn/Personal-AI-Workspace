import { createHash } from 'node:crypto';
import type { Conversation, MessagePage } from '@/modules/conversations/domain/conversation-types';
import type { IConversationRepository } from '@/modules/conversations/repositories/conversation-repository';
import type { EgressManifest } from '@/modules/ai-runs/domain/ai-run-types';
import type { IWorkspaceGateway } from '@/modules/files/repositories/workspace-gateway';
import type { WorkspaceReadResult } from '@/modules/files/domain/workspace-types';
import { FakeModelProvider } from '@/infrastructure/ai-provider/fake-model-provider';
import { DirectProviderAgentRuntime } from '@/infrastructure/ai-provider/direct-provider-agent-runtime';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const CONTENT = 'export const value = 42;\n';

function manifest(): EgressManifest {
  return {
    manifestHash: 'a'.repeat(64),
    provider: 'NVIDIA hosted NIM',
    providerProfile: 'nvidia-hosted-nim',
    model: 'nvidia/nemotron-3-super-120b-a12b',
    categories: ['Request', 'Project files'],
    files: [{ relativePath: 'src/index.ts', sourceHash: sha(CONTENT), sizeBytes: Buffer.byteLength(CONTENT, 'utf8') }],
    requestBytes: Buffer.byteLength('Inspect the project.', 'utf8'),
    messageBytes: 0,
    messageCount: 0,
    messageHash: sha('[]'),
    byteEstimate: Buffer.byteLength(CONTENT, 'utf8') + Buffer.byteLength('Inspect the project.', 'utf8'),
    tokenEstimate: 20,
    excludedItemCount: 0,
    omittedItemCount: 0,
    omissionSummary: 'No selected items were excluded or omitted.',
    bestEffortSecretDetection: true
  };
}

describe('DirectProviderAgentRuntime', () => {
  it('reads only the approved file and sends the redacted context through the provider port', async () => {
    const provider = new FakeModelProvider();
    provider.options = { response: 'The file looks safe.' };
    const workspace = workspaceGateway(CONTENT);
    const runtime = new DirectProviderAgentRuntime({ provider, workspaceGateway: workspace, conversationRepository: conversationRepository() });

    const events = await collect(runtime.startRun({
      runId: 'run-1', ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, relativeRoot: 'project',
      request: 'Inspect the project.', manifest: manifest()
    }));

    expect(provider.requests[0]?.files).toEqual([{ relativePath: 'src/index.ts', content: CONTENT }]);
    expect(events).toEqual(expect.arrayContaining([{ type: 'completed', text: 'The file looks safe.' }]));
  });

  it('does not call the provider when the approved file hash has drifted', async () => {
    const provider = new FakeModelProvider();
    const runtime = new DirectProviderAgentRuntime({ provider, workspaceGateway: workspaceGateway('changed'), conversationRepository: conversationRepository() });

    const events = await collect(runtime.startRun({
      runId: 'run-2', ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, relativeRoot: 'project',
      request: 'Inspect the project.', manifest: manifest()
    }));

    expect(provider.requests).toHaveLength(0);
    expect(events).toEqual([{ type: 'blocked', message: 'The approved project context changed before provider transmission.' }]);
  });

  it('does not expose secret-bearing provider text through runtime deltas', async () => {
    const provider = new FakeModelProvider();
    provider.options = { response: 'token=provider-secret' };
    const runtime = new DirectProviderAgentRuntime({ provider, workspaceGateway: workspaceGateway(CONTENT), conversationRepository: conversationRepository() });

    const events = await collect(runtime.startRun({
      runId: 'run-3', ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, relativeRoot: 'project',
      request: 'Inspect the project.', manifest: manifest()
    }));

    expect(JSON.stringify(events)).not.toContain('provider-secret');
    expect(events).toEqual(expect.arrayContaining([{ type: 'assistant.delta', text: 'token=[REDACTED]' }]));
  });
});

function workspaceGateway(content: string): IWorkspaceGateway {
  return {
    list: jest.fn(),
    tree: jest.fn(),
    searchText: jest.fn(),
    readText: jest.fn(async (_scope, input): Promise<WorkspaceReadResult> => ({
      path: input.path,
      content,
      encoding: 'utf-8',
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      lineCount: 1,
      truncated: false
    }))
  };
}

function conversationRepository(): IConversationRepository {
  const now = new Date('2026-09-21T00:00:00.000Z');
  const conversation: Conversation = {
    id: CONVERSATION_ID,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    title: 'Chat',
    status: 'active',
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now
  };
  const page: MessagePage = { conversation, messages: [], nextBeforeSequence: null };
  return {
    listByProjectForOwner: jest.fn(),
    findWithMessagesForOwner: jest.fn(async () => page),
    create: jest.fn(),
    addUserMessage: jest.fn()
  };
}

function sha(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}
