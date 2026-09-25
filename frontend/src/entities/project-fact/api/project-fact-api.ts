import { ApiClientError, deleteNoContent, getJson, patchJson, postJson } from '@/shared/api';
import type { ProjectFact, ProjectFactDraft, ProjectFactSource, ProjectFactSourceKind, ProjectFactVerificationStatus } from '@/entities/project-fact/model/types';

const PROJECTS_PATH = '/api/v1/projects';

export async function listProjectFacts(projectId: string): Promise<readonly ProjectFact[]> {
  const response = await getJson<unknown>(projectFactsPath(projectId));
  const facts = asRecord(response)?.facts;
  if (!Array.isArray(facts)) {
    throw invalidResponse();
  }
  return facts.map((fact) => normalizeProjectFact(fact, projectId));
}

export async function createProjectFact(projectId: string, draft: ProjectFactDraft, csrfToken: string): Promise<ProjectFact> {
  const response = await postJson<unknown>(projectFactsPath(projectId), draft, { 'X-CSRF-Token': csrfToken });
  return normalizeFactMutation(response, projectId);
}

export async function updateProjectFact(projectId: string, factId: string, draft: ProjectFactDraft, expectedVersion: number, csrfToken: string): Promise<ProjectFact> {
  const response = await patchJson<unknown>(
    `${projectFactsPath(projectId)}/${encodeURIComponent(factId)}`,
    { ...draft, expectedVersion },
    { 'X-CSRF-Token': csrfToken }
  );
  return normalizeFactMutation(response, projectId);
}

export async function verifyProjectFact(projectId: string, factId: string, expectedVersion: number, csrfToken: string): Promise<ProjectFact> {
  const response = await postJson<unknown>(
    `${projectFactsPath(projectId)}/${encodeURIComponent(factId)}/verification`,
    { expectedVersion },
    { 'X-CSRF-Token': csrfToken }
  );
  return normalizeFactMutation(response, projectId);
}

export function deleteProjectFact(projectId: string, factId: string, version: number, csrfToken: string): Promise<void> {
  return deleteNoContent(
    `${projectFactsPath(projectId)}/${encodeURIComponent(factId)}`,
    { 'X-CSRF-Token': csrfToken, 'If-Match': `"${version}"` }
  );
}

export function normalizeProjectFact(value: unknown, expectedProjectId?: string): ProjectFact {
  const record = asRecord(value);
  const source = normalizeSource(record?.source);
  const verificationStatus = readVerificationStatus(record?.verificationStatus);
  const verifiedAt = record?.verifiedAt;
  const fact: ProjectFact = {
    id: readNonEmptyString(record?.id),
    projectId: readNonEmptyString(record?.projectId),
    title: readNonEmptyString(record?.title),
    content: readNonEmptyString(record?.content),
    source,
    createdAt: readNonEmptyString(record?.createdAt),
    updatedAt: readNonEmptyString(record?.updatedAt),
    version: readVersion(record?.version),
    verifiedAt: verifiedAt === null ? null : readNonEmptyString(verifiedAt),
    verificationStatus
  };
  if (expectedProjectId && fact.projectId !== expectedProjectId) {
    throw invalidResponse();
  }
  if ((fact.verificationStatus === 'verified') !== (fact.verifiedAt !== null)) {
    throw invalidResponse();
  }
  return fact;
}

function normalizeFactMutation(value: unknown, projectId: string): ProjectFact {
  const fact = asRecord(value)?.fact;
  return normalizeProjectFact(fact, projectId);
}

function normalizeSource(value: unknown): ProjectFactSource {
  const record = asRecord(value);
  const kind = record?.kind;
  const reference = record?.reference;
  if (!isSourceKind(kind) || typeof reference !== 'string' && reference !== null) {
    throw invalidResponse();
  }
  return {
    kind,
    label: readNonEmptyString(record?.label),
    reference
  };
}

function readVerificationStatus(value: unknown): ProjectFactVerificationStatus {
  if (value === 'verified' || value === 'needs_review') {
    return value;
  }
  throw invalidResponse();
}

function readVersion(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  throw invalidResponse();
}

function readNonEmptyString(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  throw invalidResponse();
}

function isSourceKind(value: unknown): value is ProjectFactSourceKind {
  return value === 'user' || value === 'conversation' || value === 'project_file';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function projectFactsPath(projectId: string): string {
  return `${PROJECTS_PATH}/${encodeURIComponent(projectId)}/facts`;
}

function invalidResponse(): ApiClientError {
  return new ApiClientError(200, 'INVALID_RESPONSE', 'The local app returned an invalid response.');
}
