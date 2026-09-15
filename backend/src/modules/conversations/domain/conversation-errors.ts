import type { ErrorDetail } from '@/shared/errors/app-error';

export class ConversationDomainError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details: readonly ErrorDetail[];

  public constructor(
    code: string,
    statusCode: number,
    message: string,
    details: readonly ErrorDetail[] = []
  ) {
    super(message);
    this.name = 'ConversationDomainError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class ConversationNotFoundError extends ConversationDomainError {
  public constructor() {
    super('CONVERSATION_NOT_FOUND', 404, 'Conversation not found.');
  }
}

export class ConversationTitleInvalidError extends ConversationDomainError {
  public constructor(message = 'Enter a conversation name.') {
    super('CONVERSATION_TITLE_INVALID', 400, 'The conversation name is invalid.', [{
      field: 'title',
      message
    }]);
  }
}

export class MessageContentInvalidError extends ConversationDomainError {
  public constructor(message = 'Enter a message.') {
    super('MESSAGE_CONTENT_INVALID', 400, 'The message content is invalid.', [{
      field: 'content',
      message
    }]);
  }
}

export class ProjectArchivedError extends ConversationDomainError {
  public constructor() {
    super('PROJECT_ARCHIVED', 409, 'This project is archived and read-only.');
  }
}

export class IdempotencyKeyRequiredError extends ConversationDomainError {
  public constructor() {
    super('VALIDATION_ERROR', 400, 'A valid Idempotency-Key header is required.', [{
      field: 'Idempotency-Key',
      message: 'Provide an idempotency key for this mutation.'
    }]);
  }
}

export class IdempotencyKeyReusedError extends ConversationDomainError {
  public constructor() {
    super('IDEMPOTENCY_KEY_REUSED', 409, 'This retry key was already used for different content.');
  }
}

export class ConversationQueryInvalidError extends ConversationDomainError {
  public constructor(field: string, message: string) {
    super('VALIDATION_ERROR', 400, 'The conversation request is invalid.', [{ field, message }]);
  }
}
