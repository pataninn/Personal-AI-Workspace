import { ApiClientError, postJson } from '@/shared/api';
import type {
  CurrentShowcase,
  PublishShowcaseRequest,
  ShowcasePreviewRequest,
  ShowcaseFact,
  ShowcaseFile,
  ShowcasePreview,
  ShowcasePreviewFact,
  ShowcasePreviewFile,
  ShowcasePreviewTask,
  ShowcasePublishResult,
  ShowcaseTask
} from '@/entities/showcase/model/types';

const SHOWCASE_PATH = '/api/v1/showcases/current';
const SHOWCASE_PREVIEW_PATH = '/api/v1/admin/showcases/previews';
const SHOWCASE_PUBLISH_PATH = '/api/v1/admin/showcases/versions';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/** Loads the public snapshot without attaching a workspace session cookie. */
export async function getCurrentShowcase(): Promise<CurrentShowcase> {
  return normalizeCurrentShowcase(await fetchPublicJson(SHOWCASE_PATH));
}

/** Requests the exact selected projection and file bytes for administrator review. */
export async function previewShowcase(
  request: ShowcasePreviewRequest,
  csrfToken: string
): Promise<ShowcasePreview> {
  const response = await postJson<unknown>(SHOWCASE_PREVIEW_PATH, request, { 'X-CSRF-Token': csrfToken });
  return normalizeShowcasePreview(response);
}

/** Publishes an unchanged preview and replays safely when the key is reused. */
export async function publishShowcase(
  request: PublishShowcaseRequest,
  csrfToken: string,
  idempotencyKey: string
): Promise<ShowcasePublishResult> {
  const response = await postJson<unknown>(SHOWCASE_PUBLISH_PATH, request, {
    'X-CSRF-Token': csrfToken,
    'Idempotency-Key': idempotencyKey
  });
  return normalizeShowcasePublishResult(response);
}

/** Downloads one file as an octet stream, without exposing it to inline rendering. */
export async function downloadShowcaseFile(file: ShowcaseFile): Promise<void> {
  const response = await fetch(showcaseFilePath(file.id), { credentials: 'omit' });
  if (!response.ok) {
    throw new ApiClientError(response.status, response.status === 404 ? 'SHOWCASE_FILE_NOT_FOUND' : 'HTTP_ERROR', 'The showcase file could not be downloaded.');
  }
  const content = await response.arrayBuffer();
  const objectUrl = URL.createObjectURL(new Blob([content], { type: 'application/octet-stream' }));
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = file.name.split('/').at(-1) ?? 'showcase-file';
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

export function showcaseFilePath(fileId: string): string {
  return `${SHOWCASE_PATH}/files/${encodeURIComponent(fileId)}`;
}

async function fetchPublicJson(path: string): Promise<unknown> {
  const response = await fetch(path, { credentials: 'omit', headers: { Accept: 'application/json' } });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw invalidResponse();
  }
  const envelope = asRecord(body);
  const error = asRecord(envelope?.error);
  if (!envelope || !('data' in envelope) || !('error' in envelope)) {
    throw invalidResponse();
  }
  if (!response.ok || error) {
    throw new ApiClientError(
      response.status,
      typeof error?.code === 'string' ? error.code : 'HTTP_ERROR',
      typeof error?.message === 'string' ? error.message : 'The request failed.'
    );
  }
  return envelope.data;
}

function normalizeCurrentShowcase(value: unknown): CurrentShowcase {
  const record = asRecord(value);
  const project = asRecord(record?.project);
  return {
    version: readUuid(record?.version),
    publishedAt: readTimestamp(record?.publishedAt),
    project: normalizeProject(project),
    tasks: readArray(record?.tasks, normalizeShowcaseTask),
    facts: readArray(record?.facts, normalizeShowcaseFact),
    files: readArray(record?.files, normalizeShowcaseFile)
  };
}

function normalizeShowcasePreview(value: unknown): ShowcasePreview {
  const record = asRecord(value);
  const project = asRecord(record?.project);
  const totals = asRecord(record?.totals);
  return {
    project: normalizeProject(project),
    tasks: readArray(record?.tasks, normalizePreviewTask),
    facts: readArray(record?.facts, normalizePreviewFact),
    files: readArray(record?.files, normalizePreviewFile),
    previewDigest: readHash(record?.previewDigest),
    sourceRevision: readHash(record?.sourceRevision),
    totals: {
      itemCount: readNonNegativeInteger(totals?.itemCount),
      fileCount: readNonNegativeInteger(totals?.fileCount),
      snapshotBytes: readNonNegativeInteger(totals?.snapshotBytes)
    },
    exclusions: readArray(record?.exclusions, readString)
  };
}

function normalizeShowcasePublishResult(value: unknown): ShowcasePublishResult {
  const record = asRecord(value);
  return { version: readUuid(record?.version), publishedAt: readTimestamp(record?.publishedAt) };
}

function normalizeProject(value: Record<string, unknown> | null): CurrentShowcase['project'] {
  if (!value) throw invalidResponse();
  return { name: readString(value.name), objective: readNullableString(value.objective) };
}

function normalizeShowcaseTask(value: unknown): ShowcaseTask {
  const record = asRecord(value);
  const status = readEnum(record?.status, ['todo', 'in_progress', 'blocked', 'done', 'archived'] as const);
  const importance = readEnum(record?.importance, ['low', 'medium', 'high', 'urgent'] as const);
  return {
    id: readUuid(record?.id),
    title: readString(record?.title),
    details: readNullableString(record?.details),
    status,
    importance,
    deadline: readNullableDate(record?.deadline),
    checklist: readArray(record?.checklist, (entry) => {
      const item = asRecord(entry);
      if (typeof item?.completed !== 'boolean') throw invalidResponse();
      return { id: readUuid(item.id), title: readString(item.title), completed: item.completed };
    })
  };
}

function normalizeShowcaseFact(value: unknown): ShowcaseFact {
  const record = asRecord(value);
  return { id: readUuid(record?.id), title: readString(record?.title), content: readString(record?.content) };
}

function normalizeShowcaseFile(value: unknown): ShowcaseFile {
  const record = asRecord(value);
  return {
    id: readUuid(record?.id),
    name: readSafeRelativeName(record?.name),
    mediaType: readString(record?.mediaType),
    byteLength: readNonNegativeInteger(record?.byteLength)
  };
}

function normalizePreviewTask(value: unknown): ShowcasePreviewTask {
  const record = asRecord(value);
  return {
    title: readString(record?.title),
    details: readNullableString(record?.details),
    status: readEnum(record?.status, ['todo', 'in_progress', 'blocked', 'done', 'archived'] as const),
    importance: readEnum(record?.importance, ['low', 'medium', 'high', 'urgent'] as const),
    deadline: readNullableDate(record?.deadline),
    checklist: readArray(record?.checklist, (entry) => {
      const item = asRecord(entry);
      if (typeof item?.completed !== 'boolean') throw invalidResponse();
      return { title: readString(item.title), completed: item.completed };
    })
  };
}

function normalizePreviewFact(value: unknown): ShowcasePreviewFact {
  const record = asRecord(value);
  return { title: readString(record?.title), content: readString(record?.content) };
}

function normalizePreviewFile(value: unknown): ShowcasePreviewFile {
  const record = asRecord(value);
  const byteLength = readNonNegativeInteger(record?.byteLength);
  const contentBase64 = readBase64(record?.contentBase64, byteLength);
  return {
    name: readSafeRelativeName(record?.name),
    mediaType: readString(record?.mediaType),
    byteLength,
    sha256: readHash(record?.sha256),
    contentBase64
  };
}

function readArray<T>(value: unknown, normalize: (entry: unknown) => T): T[] {
  if (!Array.isArray(value)) throw invalidResponse();
  return value.map(normalize);
}

function readEnum<const T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (isAllowedEnum(value, allowed)) return value;
  throw invalidResponse();
}

function isAllowedEnum<const T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === 'string' && allowed.some((candidate) => candidate === value);
}

function readUuid(value: unknown): string {
  if (typeof value === 'string' && UUID_PATTERN.test(value)) return value;
  throw invalidResponse();
}

function readHash(value: unknown): string {
  if (typeof value === 'string' && SHA256_PATTERN.test(value)) return value;
  throw invalidResponse();
}

function readTimestamp(value: unknown): string {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value;
  throw invalidResponse();
}

function readNullableDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  throw invalidResponse();
}

function readSafeRelativeName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.startsWith('/') || /^[a-z]:/iu.test(value) || value.split(/[\\/]/u).some((part) => part === '..') || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalidResponse();
  }
  return value;
}

function readBase64(value: unknown, expectedLength: number): string {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw invalidResponse();
  }
  try {
    if (atob(value).length !== expectedLength) throw invalidResponse();
  } catch {
    throw invalidResponse();
  }
  return value;
}

function readNonNegativeInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  throw invalidResponse();
}

function readNullableString(value: unknown): string | null {
  if (value === null) return null;
  return readString(value, true);
}

function readString(value: unknown, allowEmpty = false): string {
  if (typeof value === 'string' && (allowEmpty || value.trim().length > 0)) return value;
  throw invalidResponse();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function invalidResponse(): ApiClientError {
  return new ApiClientError(200, 'INVALID_RESPONSE', 'The local app returned an invalid response.');
}
