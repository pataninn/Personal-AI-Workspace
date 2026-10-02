import { AiRunRuntimeUnavailableError, AiRunSourceChangedError } from '@/modules/ai-runs/domain/ai-run-errors';
import type { EgressManifest } from '@/modules/ai-runs/domain/ai-run-types';
import type { CommandResult } from '@/modules/ai-runs/domain/command-types';
import type { IConversationRepository } from '@/modules/conversations/repositories/conversation-repository';
import type { IWorkspaceGateway } from '@/modules/files/repositories/workspace-gateway';
import type { IProjectFactRepository } from '@/modules/memory/repositories/project-fact-repository';
import type { EgressProjectFact } from '@/modules/ai-runs/domain/ai-run-types';
import type {
  IAgentRuntime,
  RuntimeCommandCancellationInput,
  RuntimeCommandInput,
  RuntimeCommandProposalInput,
  RuntimeCreateInput,
  RuntimeInferenceEvent,
  RuntimeRunCancellationInput,
  RuntimeRunCancellationResult,
  RuntimeRunInput,
  RuntimeReadyResult
} from '@/modules/ai-runs/repositories/agent-runtime';
import type { IModelProvider, ModelProviderEvent, ModelProviderRequest } from '@/modules/ai-runs/repositories/model-provider';
import { hashText, toEgressProjectFact } from '@/modules/ai-runs/use-cases/manifest-builder';
import { redactEgressText } from '@/shared/egress/redaction';
import { AI_RUN_LIMITS } from '@/modules/ai-runs/domain/ai-run-validation';

export interface DirectProviderAgentRuntimeOptions {
  readonly provider: IModelProvider;
  readonly workspaceGateway: IWorkspaceGateway;
  readonly conversationRepository: IConversationRepository;
  readonly projectFactRepository?: IProjectFactRepository;
}

export class DirectProviderAgentRuntime implements IAgentRuntime {
  public readonly directProvider = true as const;
  private readonly provider: IModelProvider;
  private readonly workspaceGateway: IWorkspaceGateway;
  private readonly conversationRepository: IConversationRepository;
  private readonly projectFactRepository: IProjectFactRepository | undefined;

  public constructor(options: DirectProviderAgentRuntimeOptions) {
    this.provider = options.provider;
    this.workspaceGateway = options.workspaceGateway;
    this.conversationRepository = options.conversationRepository;
    this.projectFactRepository = options.projectFactRepository;
  }

  public async checkAvailability(): Promise<void> {
    try {
      await this.provider.checkAvailability();
    } catch {
      throw new AiRunRuntimeUnavailableError();
    }
  }

  public async create(_input: RuntimeCreateInput): Promise<RuntimeReadyResult> {
    return this.prepareReady();
  }

  public async prepareDirectRun(_input: { readonly runId: string; readonly manifest: EgressManifest }): Promise<RuntimeReadyResult> {
    await this.checkAvailability();
    return this.prepareReady();
  }

  public async *startRun(input: RuntimeRunInput): AsyncIterable<RuntimeInferenceEvent> {
    if (!input.ownerId || !input.projectId || !input.conversationId || input.relativeRoot === undefined) {
      yield { type: 'failed', message: 'The approved provider context is unavailable.' };
      return;
    }
    try {
      const context = await this.readApprovedContext(input);
      const request: ModelProviderRequest = {
        runId: input.runId,
        request: redactEgressText(input.request),
        manifest: input.manifest,
        files: context.files,
        facts: context.facts,
        messages: context.messages
      };
      for await (const event of this.provider.stream(request)) {
        if (event.type === 'changes.proposed') await this.readApprovedContext(input);
        yield toRuntimeEvent(event);
      }
    } catch (error: unknown) {
      if (error instanceof AiRunSourceChangedError) {
        yield { type: 'blocked', message: 'The approved project context changed before provider transmission.' };
        return;
      }
      yield { type: 'failed', message: 'The provider request could not be completed safely.' };
    }
  }

  public async cancelRun(input: RuntimeRunCancellationInput): Promise<RuntimeRunCancellationResult> {
    return this.provider.cancel(input.runId);
  }

  public async proposeCommand(_input: RuntimeCommandProposalInput): Promise<void> {
    throw new AiRunRuntimeUnavailableError();
  }

  public async executeCommand(_input: RuntimeCommandInput): Promise<CommandResult> {
    throw new AiRunRuntimeUnavailableError();
  }

  public async cancelCommand(_input: RuntimeCommandCancellationInput): Promise<void> {
    throw new AiRunRuntimeUnavailableError();
  }

  public async destroy(_runId: string): Promise<void> {
    return Promise.resolve();
  }

  private prepareReady(): RuntimeReadyResult {
    return { kind: 'direct', sandboxReady: true };
  }

  private async readApprovedContext(input: RuntimeRunInput): Promise<{ readonly files: readonly { readonly relativePath: string; readonly content: string }[]; readonly facts: readonly EgressProjectFact[]; readonly messages: readonly { readonly role: string; readonly content: string }[] }> {
    const conversation = await this.conversationRepository.findWithMessagesForOwner({
      ownerId: input.ownerId ?? '',
      projectId: input.projectId ?? '',
      conversationId: input.conversationId ?? '',
      limit: AI_RUN_LIMITS.maxMessages
    });
    const messages = input.manifest.messages ?? (conversation && input.manifest.messageCount > 0
      ? toManifestMessages(conversation.messages.map((message) => ({ role: message.role, content: message.content })), Buffer.byteLength(input.request, 'utf8'))
      : []);
    if (!conversation || messages.length !== input.manifest.messageCount || hashText(JSON.stringify(messages)) !== input.manifest.messageHash) {
      throw new AiRunSourceChangedError();
    }
    const facts = await this.readApprovedFacts(input);
    const files = [];
    for (const file of input.manifest.files) {
      const read = await this.workspaceGateway.readText({ projectId: input.projectId ?? '', relativeRoot: input.relativeRoot ?? '' }, { path: file.relativePath });
      if (read.truncated || read.sizeBytes !== file.sizeBytes || (read.sourceHash ?? hashText(read.content)) !== file.sourceHash) {
        throw new AiRunSourceChangedError();
      }
      files.push({ relativePath: file.relativePath, content: redactEgressText(read.content) });
    }
    return { files, facts, messages };
  }

  private async readApprovedFacts(input: RuntimeRunInput): Promise<readonly EgressProjectFact[]> {
    const expectedFacts = input.manifest.facts ?? [];
    if (expectedFacts.length === 0) {
      return [];
    }
    if (!this.projectFactRepository || !input.ownerId || !input.projectId) {
      throw new AiRunSourceChangedError();
    }
    const currentFacts = await this.projectFactRepository.findActiveByIds(input.ownerId, input.projectId, expectedFacts.map((fact) => fact.id));
    if (currentFacts.length !== expectedFacts.length) {
      throw new AiRunSourceChangedError();
    }
    const currentSnapshots = new Map(currentFacts.map((fact) => {
      const snapshot = toEgressProjectFact(fact);
      return [snapshot.id, snapshot] as const;
    }));
    if (expectedFacts.some((snapshot) => !areSameFactSnapshot(snapshot, currentSnapshots.get(snapshot.id)))) {
      throw new AiRunSourceChangedError();
    }
    return expectedFacts;
  }
}

function areSameFactSnapshot(expected: EgressProjectFact, current: EgressProjectFact | undefined): boolean {
  return current !== undefined
    && current.id === expected.id
    && current.title === expected.title
    && current.content === expected.content
    && current.source.kind === expected.source.kind
    && current.source.label === expected.source.label
    && current.source.reference === expected.source.reference
    && current.version === expected.version
    && current.verifiedAt === expected.verifiedAt
    && current.verificationStatus === expected.verificationStatus
    && current.updatedAt === expected.updatedAt
    && current.sizeBytes === expected.sizeBytes
    && current.sourceHash === expected.sourceHash;
}

function toRuntimeEvent(event: ModelProviderEvent): RuntimeInferenceEvent {
  if (event.type === 'assistant.delta' || event.type === 'assistant.message.completed' || event.type === 'completed') {
    return { ...event, text: redactEgressText(event.text) };
  }
  if (event.type === 'failed' || event.type === 'needs_manual_review') {
    return { ...event, message: redactEgressText(event.message) };
  }
  return event;
}

function toManifestMessages(messages: readonly { readonly role: string; readonly content: string }[], requestBytes: number): readonly { readonly role: string; readonly content: string }[] {
  const selected: { role: string; content: string }[] = [];
  let selectedBytes = 0;
  const maxMessageBytes = Math.max(0, AI_RUN_LIMITS.maxTotalBytes - requestBytes);
  for (const message of messages.slice(-AI_RUN_LIMITS.maxMessages).reverse()) {
    const content = truncateUtf8(redactEgressText(message.content), AI_RUN_LIMITS.maxMessageBytes);
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (selectedBytes + contentBytes > maxMessageBytes) {
      break;
    }
    selected.unshift({ role: message.role, content });
    selectedBytes += contentBytes;
  }
  return selected;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value;
  }
  let output = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    output += character;
    bytes += characterBytes;
  }
  return output;
}
