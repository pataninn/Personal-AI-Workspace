import { containsPotentialSecret } from '@/shared/egress/redaction';
import { ProjectFactValidationError } from '@/modules/memory/domain/project-fact-errors';

const MAX_TITLE_LENGTH = 120;
const MAX_CONTENT_BYTES = 4_096;

export interface ProjectFactDraft {
  readonly title: string;
  readonly content: string;
  readonly key: string;
}

export function validateProjectFactDraft(titleValue: unknown, contentValue: unknown): ProjectFactDraft {
  const title = validateTitle(titleValue);
  const content = validateContent(contentValue);
  return { title, content, key: normalizeProjectFactKey(title) };
}

export function validateExpectedVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ProjectFactValidationError([{ field: 'expectedVersion', message: 'Use a positive current fact version.' }]);
  }
  return value;
}

export function normalizeProjectFactKey(title: string): string {
  return title.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

function validateTitle(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ProjectFactValidationError([{ field: 'title', message: 'Enter a fact name.' }]);
  }
  const title = value.trim();
  if (title.length === 0 || title.length > MAX_TITLE_LENGTH || containsPotentialSecret(title)) {
    throw new ProjectFactValidationError([{ field: 'title', message: 'Enter a fact name up to 120 characters without credential-like text.' }]);
  }
  return title;
}

function validateContent(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ProjectFactValidationError([{ field: 'content', message: 'Enter what the assistant should know.' }]);
  }
  const content = value.trim();
  if (content.length === 0 || Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES || containsPotentialSecret(content)) {
    throw new ProjectFactValidationError([{ field: 'content', message: 'Enter a fact up to 4,096 bytes without credential-like text.' }]);
  }
  return content;
}
