import { createHash } from 'node:crypto';

import { WorkspaceRelativePath } from '@/modules/files/domain/workspace-path';
import { WorkspacePathForbiddenError, type WorkspaceDomainError } from '@/modules/files/domain/workspace-errors';
import type { IWorkspaceGateway } from '@/modules/files/repositories/workspace-gateway';
import type { WorkspaceReadResult } from '@/modules/files/domain/workspace-types';
import { AI_RUN_LIMITS } from '@/modules/ai-runs/domain/ai-run-validation';
import type { EgressFileEntry, EgressManifest, EgressMessage } from '@/modules/ai-runs/domain/ai-run-types';
import type { EgressProjectFact } from '@/modules/ai-runs/domain/ai-run-types';
import type { ProjectFact } from '@/modules/memory/domain/project-fact';
import { redactEgressText } from '@/shared/egress/redaction';
import { AiRunValidationError } from '@/modules/ai-runs/domain/ai-run-errors';
import { providerLabel } from '@/modules/ai-runs/domain/model-provider-profile';
import type { ProjectStorageKind } from '@/modules/projects/domain/project-types';

export type ManifestMessage = EgressMessage;

export interface ManifestBuildInput {
  readonly workspaceGateway: IWorkspaceGateway;
  readonly projectId: string;
  readonly ownerId: string;
  readonly storageKind: ProjectStorageKind;
  readonly relativeRoot: string;
  readonly request: string;
  readonly requestedPaths: readonly string[];
  readonly messages: readonly ManifestMessage[];
  readonly facts?: readonly EgressProjectFact[];
  readonly providerProfile: string;
  readonly model: string;
}

export interface ManifestBuildResult {
  readonly manifest: EgressManifest;
  readonly omittedPaths: readonly string[];
}

export async function buildManifest(input: ManifestBuildInput): Promise<ManifestBuildResult> {
  const files: EgressFileEntry[] = [];
  const excludedPaths: string[] = [];
  const omittedPaths: string[] = [];
  const requestBytes = Buffer.byteLength(input.request, 'utf8');
  const messageBytes = input.messages.reduce((total, message) => total + Buffer.byteLength(message.content, 'utf8'), 0);
  const facts = input.facts ?? [];
  const factBytes = facts.reduce((total, fact) => total + fact.sizeBytes, 0);
  if (requestBytes + messageBytes + factBytes > AI_RUN_LIMITS.maxTotalBytes) {
    throw new AiRunValidationError([{ field: 'context.factIds', message: 'The selected facts are too large to include with this request and conversation.' }]);
  }
  const maxFileBytes = Math.max(0, Math.min(
    AI_RUN_LIMITS.maxContextBytes,
    AI_RUN_LIMITS.maxTotalBytes - requestBytes - messageBytes - factBytes
  ));
  const seenPaths = new Set<string>();
  let includedBytes = 0;
  for (const requestedPath of input.requestedPaths) {
    const canonicalPath = WorkspaceRelativePath.parse(requestedPath, { field: 'context.relativePaths' }).value;
    if (seenPaths.has(canonicalPath)) {
      continue;
    }
    seenPaths.add(canonicalPath);
    const readResult = await readCandidate(input, canonicalPath).catch((error: unknown) => {
      const omission = classifyOmission(error);
      if (omission === 'excluded') {
        excludedPaths.push(canonicalPath);
        return null;
      }
      if (omission === 'omitted') {
        omittedPaths.push(canonicalPath);
        return null;
      }
      throw error;
    });
    if (!readResult) {
      continue;
    }
    if (readResult.truncated || includedBytes + readResult.sizeBytes > maxFileBytes) {
      omittedPaths.push(canonicalPath);
      continue;
    }
    files.push({
      relativePath: canonicalPath,
      sourceHash: readResult.sourceHash ?? hashText(readResult.content),
      sizeBytes: readResult.sizeBytes
    });
    includedBytes += readResult.sizeBytes;
  }
  const messageHash = hashJson(input.messages);
  const categories = ['Request'];
  if (input.messages.length > 0) {
    categories.push('Recent conversation');
  }
  if (files.length > 0) {
    categories.push('Project files');
  }
  if (facts.length > 0) {
    categories.push('Project facts');
  }
  const manifestWithoutHash = {
    provider: providerLabel(input.providerProfile),
    providerProfile: input.providerProfile,
    model: input.model,
    categories,
    files,
    facts,
    requestBytes,
    messageBytes,
    messageCount: input.messages.length,
    messageHash,
    messages: input.messages,
    byteEstimate: requestBytes + messageBytes + factBytes + includedBytes,
    tokenEstimate: Math.ceil((requestBytes + messageBytes + factBytes + includedBytes) / 4),
    excludedItemCount: excludedPaths.length,
    omittedItemCount: omittedPaths.length,
    omissionSummary: omissionSummary(excludedPaths.length, omittedPaths.length)
  };
  const manifestHash = hashJson(manifestWithoutHash);
  return {
    manifest: {
      ...manifestWithoutHash,
      manifestHash,
      bestEffortSecretDetection: true
    },
    omittedPaths
  };
}

export function toEgressProjectFact(fact: ProjectFact): EgressProjectFact {
  const title = redactEgressText(fact.title);
  const content = redactEgressText(fact.content);
  const source = { kind: 'user' as const, label: 'Added by you' as const, reference: null };
  const disclosedValue = JSON.stringify({ title, content, source: source.label });
  return {
    id: fact.id,
    title,
    content,
    source,
    version: fact.version,
    verifiedAt: fact.verifiedAt?.toISOString() ?? null,
    verificationStatus: fact.verificationStatus,
    updatedAt: fact.updatedAt.toISOString(),
    sizeBytes: Buffer.byteLength(disclosedValue, 'utf8'),
    sourceHash: hashText(disclosedValue)
  };
}

export function hashText(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function hashJson(value: unknown): string {
  return hashText(JSON.stringify(value));
}

async function readCandidate(input: ManifestBuildInput, relativePath: string): Promise<WorkspaceReadResult> {
  return input.workspaceGateway.readText({ ownerId: input.ownerId, projectId: input.projectId, storageKind: input.storageKind, relativeRoot: input.relativeRoot }, { path: relativePath });
}

function classifyOmission(error: unknown): 'excluded' | 'omitted' | null {
  if (error instanceof WorkspacePathForbiddenError) {
    return 'excluded';
  }
  if (!isWorkspaceOmission(error)) {
    return null;
  }
  if (error.code === 'WORKSPACE_FILE_UNSUPPORTED' || error.code === 'WORKSPACE_FILE_BINARY') {
    return 'excluded';
  }
  return 'omitted';
}

function isWorkspaceOmission(error: unknown): error is WorkspaceDomainError {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return false;
  }
  const code = error.code;
  return code === 'WORKSPACE_PATH_NOT_FOUND'
    || code === 'WORKSPACE_FILE_UNSUPPORTED'
    || code === 'WORKSPACE_FILE_BINARY'
    || code === 'WORKSPACE_LIMIT_EXCEEDED';
}

function omissionSummary(excludedItemCount: number, omittedItemCount: number): string {
  if (excludedItemCount > 0 && omittedItemCount > 0) {
    return 'Some selected items were excluded by local safety policy or omitted by bounded inspection.';
  }
  if (excludedItemCount > 0) {
    return 'Some selected items were excluded by local safety policy.';
  }
  if (omittedItemCount > 0) {
    return 'Some selected items were omitted by bounded inspection or size policy.';
  }
  return 'No selected items were excluded or omitted.';
}
