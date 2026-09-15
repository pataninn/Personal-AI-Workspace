import {
  ConversationQueryInvalidError,
  ConversationTitleInvalidError,
  MessageContentInvalidError
} from '@/modules/conversations/domain/conversation-errors';

const MAX_TITLE_LENGTH = 160;
const MAX_MESSAGE_LENGTH = 20_000;

export function normalizeConversationTitle(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ConversationTitleInvalidError();
  }
  const title = value.trim();
  if (title.length === 0) {
    throw new ConversationTitleInvalidError();
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw new ConversationTitleInvalidError(`Use ${MAX_TITLE_LENGTH} characters or fewer.`);
  }
  if (containsControlCharacter(title)) {
    throw new ConversationTitleInvalidError('Use normal text without control characters.');
  }
  return title;
}

export function validateMessageContent(value: unknown): string {
  if (typeof value !== 'string') {
    throw new MessageContentInvalidError();
  }
  if (value.trim().length === 0) {
    throw new MessageContentInvalidError();
  }
  if (value.length > MAX_MESSAGE_LENGTH) {
    throw new MessageContentInvalidError(`Use ${MAX_MESSAGE_LENGTH} characters or fewer.`);
  }
  if (containsControlCharacter(value, true)) {
    throw new MessageContentInvalidError('Use normal text without control characters.');
  }
  return value;
}

export function parsePositiveLimit(value: unknown, defaultValue: number, maximum: number, field: string): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
    throw new ConversationQueryInvalidError(field, `Use a whole number from 1 to ${maximum}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new ConversationQueryInvalidError(field, `Use a whole number from 1 to ${maximum}.`);
  }
  return parsed;
}

export function parseBeforeSequence(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
    throw new ConversationQueryInvalidError('beforeSequence', 'Use a positive message sequence.');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ConversationQueryInvalidError('beforeSequence', 'Use a positive message sequence.');
  }
  return parsed;
}

function containsControlCharacter(value: string, allowNewlines = false): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 && !(allowNewlines && (code === 10 || code === 13 || code === 9))) {
      return true;
    }
  }
  return false;
}
