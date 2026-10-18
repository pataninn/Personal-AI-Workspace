import { createHash } from 'node:crypto';

import type { IConversationRepository } from '@/modules/conversations/repositories/conversation-repository';
import { ProjectNotFoundError } from '@/modules/projects/domain/project-errors';
import { requireProjectFileRoot, requireProjectFileScope } from '@/modules/projects/domain/project-file-root';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IWorkspaceGateway } from '@/modules/files/repositories/workspace-gateway';
import type { WorkspaceReadResult } from '@/modules/files/domain/workspace-types';
import {
  AiRunManifestConflictError,
  AiRunNotFoundError,
  AiRunReviewRequiredError,
  AiRunRuntimeUnavailableError,
  AiRunSourceChangedError,
  AiRunStagingFailedError,
  AiRunValidationError
} from '@/modules/ai-runs/domain/ai-run-errors';
import { validateContextFactIds, validateContextPaths, validateDecision, validateIdempotencyKey, validateManifestHash, validateRequest, AI_RUN_LIMITS } from '@/modules/ai-runs/domain/ai-run-validation';
import type { AiRun, AiRunSnapshot } from '@/modules/ai-runs/domain/ai-run-types';
import type { IAiRunRepository } from '@/modules/ai-runs/repositories/ai-run-repository';
import type { IAgentRuntime } from '@/modules/ai-runs/repositories/agent-runtime';
import type { IStagingGateway } from '@/modules/ai-runs/repositories/staging-gateway';
import { buildManifest, hashText, toEgressProjectFact, type ManifestMessage } from '@/modules/ai-runs/use-cases/manifest-builder';
import { redactEgressText } from '@/shared/egress/redaction';
import type { IProjectFactRepository } from '@/modules/memory/repositories/project-fact-repository';
import { ProjectFactNotFoundError } from '@/modules/memory/domain/project-fact-errors';
import type { IProviderPermissionRepository } from '@/modules/ai-runs/repositories/provider-permission-repository';
import { AiRunProviderPermissionRevokedError } from '@/modules/ai-runs/domain/ai-run-errors';
import { assertAiRunProjectHasFileRoot } from '@/modules/ai-runs/use-cases/assert-ai-run-project';

export interface CreateAiRunInput {
  readonly ownerId: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly request: unknown;
  readonly relativePaths: unknown;
  readonly factIds?: unknown;
  readonly includeRecentMessages: boolean;
  readonly includeProjectConversations?: boolean;
  readonly idempotencyKey: string;
}

export interface CreateAiRunOutput {
  readonly resource: AiRun;
  readonly replayed: boolean;
}

export class CreateAiRunUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly conversationRepository: IConversationRepository,
    private readonly workspaceGateway: IWorkspaceGateway,
    private readonly aiRunRepository: IAiRunRepository,
    private readonly providerProfile: string,
    private readonly model: string,
    private readonly factRepository?: IProjectFactRepository
  ) {}

  public async execute(input: CreateAiRunInput): Promise<CreateAiRunOutput> {
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
    const project = await this.projectRepository.findByIdForOwner(input.ownerId, input.projectId);
    if (!project || project.status === 'archived') {
      throw new ProjectNotFoundError();
    }
    const projectScope = requireProjectFileScope(project);
    const relativeRoot = requireProjectFileRoot(project);
    const conversation = await this.conversationRepository.findWithMessagesForOwner({
      ownerId: input.ownerId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      limit: AI_RUN_LIMITS.maxMessages
    });
    if (!conversation) {
      throw new AiRunNotFoundError();
    }
    const request = validateRequest(input.request);
    const relativePaths = validateContextPaths(input.relativePaths);
    const factIds = validateContextFactIds(input.factIds);
    const facts = await this.selectFacts(input.ownerId, input.projectId, factIds);
    const history = input.includeProjectConversations && this.conversationRepository.findRecentMessagesByProjectForOwner
      ? await this.conversationRepository.findRecentMessagesByProjectForOwner({ ownerId: input.ownerId, projectId: input.projectId, conversationId: input.conversationId, limit: AI_RUN_LIMITS.maxMessages })
      : conversation.messages;
    const factSnapshots = facts.map(toEgressProjectFact);
    const reservedBytes = Buffer.byteLength(request, 'utf8') + factSnapshots.reduce((total, fact) => total + fact.sizeBytes, 0);
    const messages = input.includeRecentMessages ? toManifestMessages(history, reservedBytes) : [];
    const built = await buildManifest({
      workspaceGateway: this.workspaceGateway,
      projectId: project.id,
      ownerId: projectScope.ownerId,
      storageKind: projectScope.storageKind,
      relativeRoot,
      request,
      requestedPaths: relativePaths,
      messages,
      facts: factSnapshots,
      providerProfile: this.providerProfile,
      model: this.model
    });
    const requestFingerprint = hashText(JSON.stringify({ conversationId: input.conversationId, request, relativePaths, factIds, includeRecentMessages: input.includeRecentMessages, includeProjectConversations: input.includeProjectConversations ?? false }));
    const created = await this.aiRunRepository.create({
      ownerId: input.ownerId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      request,
      relativeRoot,
      storageKind: projectScope.storageKind,
      requestedPaths: relativePaths,
      manifest: built.manifest,
      idempotencyKey,
      requestFingerprint
    });
    if (this.conversationRepository.addRunUserMessage && !created.resource.requestMessageId) {
      const message = await this.conversationRepository.addRunUserMessage({
        ownerId: input.ownerId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        content: request,
        idempotencyKey: `run-user-${created.resource.id}`,
        requestFingerprint: hashText(JSON.stringify({ runId: created.resource.id, request }))
      });
      const withMessage: AiRun = { ...created.resource, requestMessageId: message.resource.id, updatedAt: new Date() };
      await this.aiRunRepository.save(withMessage);
      return { resource: withMessage, replayed: false };
    }
    return created;
  }

  private async selectFacts(ownerId: string, projectId: string, factIds: readonly string[]) {
    if (factIds.length === 0) {
      return [];
    }
    if (!this.factRepository) {
      throw new AiRunValidationError([{ field: 'context.factIds', message: 'Project memory is not available for this run.' }]);
    }
    const facts = await this.factRepository.findActiveByIds(ownerId, projectId, factIds);
    if (facts.length !== factIds.length) {
      throw new ProjectFactNotFoundError();
    }
    const byId = new Map(facts.map((fact) => [fact.id, fact]));
    return factIds.map((factId) => byId.get(factId)).filter((fact) => fact !== undefined);
  }
}

export interface GetAiRunInput {
  readonly ownerId: string;
  readonly runId: string;
}

export class GetAiRunUseCase {
  public constructor(private readonly aiRunRepository: IAiRunRepository, private readonly projectRepository: IProjectRepository) {}

  public async execute(input: GetAiRunInput): Promise<AiRun> {
    const run = await this.aiRunRepository.findByIdForOwner(input.ownerId, input.runId);
    if (!run) {
      throw new AiRunNotFoundError();
    }
    await assertAiRunProjectHasFileRoot(this.projectRepository, input.ownerId, run.projectId);
    return run;
  }
}

export interface DecideEgressInput {
  readonly ownerId: string;
  readonly runId: string;
  readonly manifestHash: unknown;
  readonly decision: unknown;
  readonly rememberProviderPermission?: unknown;
  readonly rememberedPermissionId?: string;
  readonly idempotencyKey: string;
}

export class DecideEgressUseCase {
  public constructor(
    private readonly aiRunRepository: IAiRunRepository,
    private readonly projectRepository: IProjectRepository,
    private readonly conversationRepository: IConversationRepository,
    private readonly workspaceGateway: IWorkspaceGateway,
    private readonly stagingGateway: IStagingGateway | undefined,
    private readonly agentRuntime: IAgentRuntime,
    _workspaceRoot: string,
    private readonly factRepository?: IProjectFactRepository,
    private readonly providerPermissionRepository?: IProviderPermissionRepository
  ) {}

  public async execute(input: DecideEgressInput): Promise<AiRun> {
    const manifestHash = validateManifestHash(input.manifestHash);
    const decision = validateDecision(input.decision);
    const rememberProviderPermission = input.rememberProviderPermission === true;
    if (rememberProviderPermission && decision !== 'approve') {
      throw new AiRunValidationError([{ field: 'rememberProviderPermission', message: 'A saved provider permission can only be created while approving a run.' }]);
    }
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
    const current = await this.aiRunRepository.findByIdForOwner(input.ownerId, input.runId);
    if (!current) {
      throw new AiRunNotFoundError();
    }
    await assertAiRunProjectHasFileRoot(this.projectRepository, input.ownerId, current.projectId);
    if (current.manifest.manifestHash !== manifestHash) {
      throw new AiRunManifestConflictError();
    }
    if (current.manifestInvalidated) {
      throw new AiRunManifestConflictError();
    }
    if (decision === 'approve') {
      try {
        await this.assertFactsUnchanged(current);
      } catch (error: unknown) {
        if (error instanceof AiRunSourceChangedError) {
          await this.saveFailure(current, 'failed', 'not_started_confirmed', 'not_started', true);
        }
        throw error;
      }
    }
    let permissionFingerprintId: string | undefined;
    if (input.rememberedPermissionId) {
      const permission = await this.providerPermissionRepository?.findActiveById({ ownerId: input.ownerId, projectId: current.projectId, permissionId: input.rememberedPermissionId });
      if (!permission || permission.providerProfile !== current.manifest.providerProfile || permission.model !== current.manifest.model) {
        throw new AiRunProviderPermissionRevokedError();
      }
      permissionFingerprintId = permission.id;
    } else if (rememberProviderPermission) {
      if (!this.providerPermissionRepository) {
        throw new AiRunValidationError([{ field: 'rememberProviderPermission', message: 'Provider permissions are not available.' }]);
      }
    }
    const requestFingerprint = hashText(JSON.stringify({ manifestHash, decision, rememberProviderPermission, rememberedPermissionId: permissionFingerprintId ?? null }));
    const result = await this.aiRunRepository.recordDecision({
      ownerId: input.ownerId,
      runId: input.runId,
      manifestHash,
      decision,
      idempotencyKey,
      requestFingerprint,
      ...(decision === 'approve' && input.rememberedPermissionId ? { providerPermissionId: input.rememberedPermissionId } : {})
    });
    let permissionSaveFailed = false;
    if (decision === 'approve' && rememberProviderPermission && !input.rememberedPermissionId) {
      try {
        await this.providerPermissionRepository?.grant({
          ownerId: input.ownerId,
          projectId: current.projectId,
          providerProfile: current.manifest.providerProfile,
          model: current.manifest.model
        });
      } catch {
        // The recorded approval still authorizes this exact run; a failed saved grant must not widen future approvals.
        permissionSaveFailed = true;
      }
    }
    if (result.replayed || decision === 'reject') {
      return permissionSaveFailed ? withPermissionSaveNotice(result.resource) : result.resource;
    }
    const prepared = await this.prepareApprovedRun(result.resource);
    return permissionSaveFailed ? withPermissionSaveNotice(prepared) : prepared;
  }

  public async approveWithRememberedPermission(input: { readonly ownerId: string; readonly runId: string }): Promise<AiRun | null> {
    if (!this.providerPermissionRepository) return null;
    const current = await this.aiRunRepository.findByIdForOwner(input.ownerId, input.runId);
    if (!current || current.decision !== 'pending' || current.manifestInvalidated) return null;
    await assertAiRunProjectHasFileRoot(this.projectRepository, input.ownerId, current.projectId);
    const permission = await this.providerPermissionRepository.findActive({
      ownerId: input.ownerId,
      projectId: current.projectId,
      providerProfile: current.manifest.providerProfile,
      model: current.manifest.model
    });
    if (!permission) return null;
    return this.execute({
      ownerId: input.ownerId,
      runId: input.runId,
      manifestHash: current.manifest.manifestHash,
      decision: 'approve',
      idempotencyKey: `permission-${permission.id}-${current.id}`,
      rememberedPermissionId: permission.id
    });
  }

  private async prepareApprovedRun(run: AiRun): Promise<AiRun> {
    const conversation = await this.conversationRepository.findWithMessagesForOwner({
      ownerId: run.ownerId,
      projectId: run.projectId,
      conversationId: run.conversationId,
      limit: AI_RUN_LIMITS.maxMessages
    });
    const messages = conversation?.messages.map((message) => ({ role: message.role, content: message.content })) ?? [];
    const messageSnapshot = run.manifest.messages ?? (run.manifest.messageCount > 0
      ? toManifestMessages(messages.slice(-AI_RUN_LIMITS.maxMessages), Buffer.byteLength(run.request, 'utf8'))
      : []);
    if (!conversation || hashMessages(messageSnapshot) !== run.manifest.messageHash) {
      await this.saveFailure(run, 'failed', 'not_started_confirmed', 'not_started', true);
      throw new AiRunSourceChangedError();
    }
    try {
      await this.assertFilesUnchanged(run);
      await this.assertFactsUnchanged(run);
    } catch (error: unknown) {
      await this.handlePreparationFailure(run, error);
      throw error;
    }
    try {
      await this.agentRuntime.checkAvailability();
    } catch (error: unknown) {
      await this.saveFailure(run, error instanceof AiRunRuntimeUnavailableError ? 'failed' : 'review_required', error instanceof AiRunRuntimeUnavailableError ? 'not_started_confirmed' : 'unknown', 'not_started');
      if (error instanceof AiRunRuntimeUnavailableError) {
        throw error;
      }
      throw new AiRunReviewRequiredError();
    }
    if (this.agentRuntime.prepareDirectRun) {
      return this.prepareDirectRun(run);
    }
    let stagingReference: string | undefined;
    let runtimeCreated = false;
    const stagingGateway = this.stagingGateway;
    if (!stagingGateway) {
      throw new AiRunRuntimeUnavailableError();
    }
    try {
      const files = await this.readApprovedFiles(run);
      const staged = await stagingGateway.stage({
        runId: run.id,
        request: run.request,
        files,
        messages: messageSnapshot
      });
      stagingReference = staged.stagingReference;
      const runtime = await this.agentRuntime.create({ runId: run.id, stagedReference: staged.stagingReference, manifest: run.manifest });
      runtimeCreated = true;
      const ready: AiRun = {
        ...run,
        status: 'ready',
        phase: 'runtime',
        stagingItemCount: staged.itemCount,
        runtimeReference: staged.stagingReference,
        runtimeKind: runtime.kind,
        sandboxReady: runtime.sandboxReady,
        safeMessage: 'Private run environment ready. Your approved context is isolated for this run. The assistant can now begin working.',
        updatedAt: new Date()
      };
      await this.aiRunRepository.save(ready);
      return ready;
    } catch (error: unknown) {
      let cleanupUnknown = false;
      if (runtimeCreated) {
        try {
          await this.agentRuntime.destroy(run.id);
        } catch {
          cleanupUnknown = true;
        }
      }
      if (stagingReference) {
        try {
          await stagingGateway.cleanup(stagingReference);
        } catch {
          cleanupUnknown = true;
        }
      }
      if (cleanupUnknown) {
        await this.saveFailure(run, 'review_required', 'unknown', 'unknown');
        throw new AiRunReviewRequiredError();
      }
      await this.handlePreparationFailure(run, error);
      if (error instanceof AiRunSourceChangedError) {
        throw error;
      }
      throw error instanceof AiRunStagingFailedError ? error : new AiRunReviewRequiredError();
    }
  }

  private async prepareDirectRun(run: AiRun): Promise<AiRun> {
    try {
      const runtime = await this.agentRuntime.prepareDirectRun?.({ runId: run.id, manifest: run.manifest });
      if (!runtime) {
        throw new AiRunRuntimeUnavailableError();
      }
      const ready: AiRun = {
        ...run,
        status: 'ready',
        phase: 'runtime',
        stagingItemCount: 0,
        runtimeKind: runtime.kind,
        sandboxReady: runtime.sandboxReady,
        safeMessage: 'Provider access approved. The assistant will receive only this run\'s bounded context.',
        updatedAt: new Date()
      };
      await this.aiRunRepository.save(ready);
      return ready;
    } catch (error: unknown) {
      await this.saveFailure(run, 'failed', 'not_started_confirmed', 'complete');
      if (error instanceof AiRunRuntimeUnavailableError) {
        throw error;
      }
      throw new AiRunRuntimeUnavailableError();
    }
  }

  private async assertFilesUnchanged(run: AiRun): Promise<void> {
    for (const file of run.manifest.files) {
      let read: WorkspaceReadResult;
      try {
        read = await this.workspaceGateway.readText({ ownerId: run.ownerId, projectId: run.projectId, storageKind: run.storageKind, relativeRoot: run.relativeRoot }, { path: file.relativePath });
      } catch {
        throw new AiRunSourceChangedError();
      }
      if (read.truncated || read.sizeBytes !== file.sizeBytes || (read.sourceHash ?? hashText(read.content)) !== file.sourceHash) {
        throw new AiRunSourceChangedError();
      }
    }
  }

  private async readApprovedFiles(run: AiRun): Promise<readonly (AiRun['manifest']['files'][number] & { readonly content: string })[]> {
    const files: (AiRun['manifest']['files'][number] & { readonly content: string })[] = [];
    for (const file of run.manifest.files) {
      let read: WorkspaceReadResult;
      try {
        read = await this.workspaceGateway.readText({ ownerId: run.ownerId, projectId: run.projectId, storageKind: run.storageKind, relativeRoot: run.relativeRoot }, { path: file.relativePath });
      } catch {
        throw new AiRunSourceChangedError();
      }
      if (read.truncated || read.sizeBytes !== file.sizeBytes || (read.sourceHash ?? hashText(read.content)) !== file.sourceHash) {
        throw new AiRunSourceChangedError();
      }
      files.push({ ...file, content: redactEgressText(read.content) });
    }
    return files;
  }

  private async assertFactsUnchanged(run: AiRun): Promise<void> {
    const expectedFacts = run.manifest.facts ?? [];
    if (expectedFacts.length === 0) {
      return;
    }
    if (!this.factRepository) {
      throw new AiRunSourceChangedError();
    }
    const currentFacts = await this.factRepository.findActiveByIds(run.ownerId, run.projectId, expectedFacts.map((fact) => fact.id));
    if (currentFacts.length !== expectedFacts.length) {
      throw new AiRunSourceChangedError();
    }
    const currentById = new Map(currentFacts.map((fact) => [fact.id, fact]));
    const matches = expectedFacts.every((snapshot) => {
      const current = currentById.get(snapshot.id);
      const currentSnapshot = current ? toEgressProjectFact(current) : undefined;
      return current !== undefined
        && currentSnapshot !== undefined
        && currentSnapshot.title === snapshot.title
        && currentSnapshot.content === snapshot.content
        && currentSnapshot.version === snapshot.version
        && currentSnapshot.verifiedAt === snapshot.verifiedAt
        && currentSnapshot.updatedAt === snapshot.updatedAt
        && currentSnapshot.sizeBytes === snapshot.sizeBytes
        && currentSnapshot.sourceHash === snapshot.sourceHash;
    });
    if (!matches) {
      throw new AiRunSourceChangedError();
    }
  }

  private async handlePreparationFailure(run: AiRun, error: unknown): Promise<void> {
    if (error instanceof AiRunSourceChangedError) {
      await this.saveFailure(run, 'failed', 'not_started_confirmed', 'not_started', true);
      return;
    }
    if (error instanceof AiRunStagingFailedError) {
      await this.saveFailure(run, 'failed', error.cleanup === 'complete' ? 'not_started_confirmed' : 'unknown', error.cleanup);
      return;
    }
    await this.saveFailure(run, 'review_required', 'unknown', 'unknown');
  }

  private async saveFailure(run: AiRun, status: 'failed' | 'review_required', providerTransmission: AiRun['providerTransmission'], cleanup: AiRun['cleanup'], manifestInvalidated = false): Promise<void> {
    const failed: AiRun = {
      ...run,
      status,
      phase: status === 'review_required' ? 'review' : 'staging',
      manifestInvalidated,
      cleanup,
      providerTransmission,
      safeMessage: status === 'review_required'
        ? 'The run stopped, but the app could not confirm whether cleanup or provider transmission finished. Do not retry automatically; refresh the run status before trying again.'
        : 'We could not prepare the private run environment. No provider call was started.',
      updatedAt: new Date()
    };
    await this.aiRunRepository.save(failed);
  }
}

function withPermissionSaveNotice(run: AiRun): AiRun {
  return {
    ...run,
    safeMessage: `${run.safeMessage} The saved permission could not be created, so this approval applies only to this run.`
  };
}

export function toSnapshot(run: AiRun): AiRunSnapshot {
  return {
    runId: run.id,
    projectId: run.projectId,
    conversationId: run.conversationId,
    status: run.status,
    phase: run.phase,
    manifestHash: run.manifest.manifestHash,
    decision: run.decision,
    ...(run.decision === 'approved' ? { providerApprovalMode: run.providerPermissionId ? 'remembered_permission' : 'one_time' } : {}),
    safeMessage: run.safeMessage,
    cleanup: run.cleanup,
    providerTransmission: run.providerTransmission,
    stagingItemCount: run.stagingItemCount,
    ...(run.assistantComplete !== undefined || run.assistantContentLength !== undefined ? {
      assistant: {
        ...(run.assistantMessageId ? { messageId: run.assistantMessageId } : {}),
        complete: run.assistantComplete ?? false,
        contentLength: run.assistantContentLength ?? 0
      }
    } : {}),
    ...(run.runtimeKind && run.sandboxReady ? { runtime: { kind: run.runtimeKind, sandboxReady: true } } : {})
  };
}

function toManifestMessages(messages: readonly { readonly role: string; readonly content: string }[], requestBytes: number): readonly ManifestMessage[] {
  const selected: ManifestMessage[] = [];
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

function hashMessages(messages: readonly ManifestMessage[]): string {
  return hashText(JSON.stringify(messages));
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
