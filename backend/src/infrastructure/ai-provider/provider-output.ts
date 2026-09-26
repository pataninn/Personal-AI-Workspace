import { z } from 'zod';

import { ModelProviderOutputError } from '@/modules/ai-runs/domain/model-provider-errors';
import type { RuntimeChangeProposal } from '@/modules/ai-runs/domain/change-types';
import { containsCredentialLikeValue, redactEgressText } from '@/shared/egress/redaction';

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_STRUCTURED_BYTES = 128 * 1024;
const MAX_CHANGES = 100;
const MAX_PATH_LENGTH = 512;
const MAX_CONTENT_BYTES = 128 * 1024;
const MAX_TASK_SUGGESTIONS = 5;
const MAX_TASK_DETAILS_BYTES = 4096;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const FORBIDDEN_TITLE_CONTROL = /[\u0000-\u001F\u007F]/u;
const FORBIDDEN_DETAILS_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

const operationSchema = z.enum(['create', 'edit', 'overwrite', 'rename', 'delete']);
const changeSchema = z.object({
  operation: operationSchema.optional(),
  type: operationSchema.optional(),
  kind: operationSchema.optional(),
  path: z.string().min(1).max(MAX_PATH_LENGTH),
  destinationPath: z.string().min(1).max(MAX_PATH_LENGTH).optional(),
  content: z.string().max(MAX_CONTENT_BYTES).optional(),
  new: z.string().max(MAX_CONTENT_BYTES).optional(),
  old: z.string().max(MAX_CONTENT_BYTES).optional(),
  expectedSourceHash: z.string().regex(HASH_PATTERN).optional(),
  expectedDestinationHash: z.string().regex(HASH_PATTERN).optional(),
  summary: z.string().max(512).optional()
}).strict().refine((change) => {
  const operations = [change.operation, change.type, change.kind].filter(Boolean);
  return operations.length > 0 && operations.every((operation) => operation === operations[0])
    && (change.content === undefined || change.new === undefined || change.content === change.new);
});

const taskSuggestionSchema = z.object({
  title: z.string(),
  details: z.string().nullable().optional()
}).strict();

const envelopeSchema = z.object({
  message: z.string().max(MAX_OUTPUT_BYTES).optional(),
  text: z.string().max(MAX_OUTPUT_BYTES).optional(),
  changes: z.array(changeSchema).max(MAX_CHANGES).optional(),
  proposedChanges: z.array(changeSchema).max(MAX_CHANGES).optional(),
  taskSuggestions: z.array(taskSuggestionSchema).max(MAX_TASK_SUGGESTIONS).optional()
}).strict();

export interface ParsedTaskSuggestion {
  readonly title: string;
  readonly details: string | null;
}

export interface ParsedProviderOutput {
  readonly text: string;
  readonly changes: readonly RuntimeChangeProposal[];
  readonly taskSuggestions: readonly ParsedTaskSuggestion[];
}

export function parseProviderOutput(text: string): ParsedProviderOutput {
  if (Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_BYTES) {
    throw new ModelProviderOutputError();
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) {
    return { text: redactEgressText(text), changes: [], taskSuggestions: [] };
  }
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_STRUCTURED_BYTES) {
    throw new ModelProviderOutputError();
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(trimmed) as unknown;
  } catch {
    throw new ModelProviderOutputError();
  }
  const parsed = envelopeSchema.safeParse(candidate);
  if (!parsed.success || (parsed.data.changes && parsed.data.proposedChanges)) {
    throw new ModelProviderOutputError();
  }
  const changes = parsed.data.changes ?? parsed.data.proposedChanges ?? [];
  for (const change of changes) {
    if (containsCredentialLikeValue(change.content ?? '') || containsCredentialLikeValue(change.new ?? '') || containsCredentialLikeValue(change.old ?? '') || containsCredentialLikeValue(change.summary ?? '')) {
      throw new ModelProviderOutputError();
    }
  }
  const taskSuggestions = (parsed.data.taskSuggestions ?? []).map((suggestion) => {
    const title = suggestion.title.trim();
    const details = suggestion.details?.trim() || null;
    if (title.length === 0 || Array.from(title).length > 120 || FORBIDDEN_TITLE_CONTROL.test(title)
      || (details !== null && (Buffer.byteLength(details, 'utf8') > MAX_TASK_DETAILS_BYTES || FORBIDDEN_DETAILS_CONTROL.test(details)))
      || containsCredentialLikeValue(title) || (details !== null && containsCredentialLikeValue(details))) {
      throw new ModelProviderOutputError();
    }
    return { title, details };
  });
  const responseText = redactEgressText(parsed.data.message ?? parsed.data.text ?? '');
  return { text: responseText, changes: changes.map(toRuntimeChangeProposal), taskSuggestions };
}

function toRuntimeChangeProposal(change: z.infer<typeof changeSchema>): RuntimeChangeProposal {
  const content = change.content ?? change.new;
  return {
    operation: (change.operation ?? change.type ?? change.kind)!,
    path: change.path,
    ...(change.destinationPath ? { destinationPath: change.destinationPath } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(change.expectedSourceHash ? { expectedSourceHash: change.expectedSourceHash } : {}),
    ...(change.expectedDestinationHash ? { expectedDestinationHash: change.expectedDestinationHash } : {}),
    ...(change.summary ? { summary: change.summary } : {})
  };
}

export function maxProviderOutputBytes(): number {
  return MAX_OUTPUT_BYTES;
}
