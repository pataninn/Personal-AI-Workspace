import { AppError } from '@/shared/errors/app-error';

export class AutomationNotFoundError extends AppError {
  public constructor() { super('AUTOMATION_NOT_FOUND', 404, 'The schedule is unavailable.'); }
}

export class AutomationRevisionConflictError extends AppError {
  public constructor() { super('SCHEDULE_REVISION_CONFLICT', 409, 'The schedule changed. Refresh it before updating.'); }
}

export class AutomationIdempotencyConflictError extends AppError {
  public constructor() { super('IDEMPOTENCY_KEY_REUSED', 409, 'This Idempotency-Key was already used for a different schedule request.'); }
}

export class AutomationWorkspaceUnavailableError extends AppError {
  public constructor() { super('AUTOMATION_WORKSPACE_NOT_FOUND', 404, 'The workspace is unavailable.'); }
}

export class AutomationSkillUnavailableError extends AppError {
  public constructor() { super('AUTOMATION_SKILL_NOT_FOUND', 404, 'The skill is unavailable for this schedule.'); }
}

export class AutomationSkillNotReadOnlyError extends AppError {
  public constructor() { super('SCHEDULE_SKILL_NOT_READ_ONLY', 422, 'Scheduled skills must declare read-only workspace capabilities.'); }
}

export class AutomationBusyError extends AppError {
  public constructor() { super('SCHEDULE_BUSY', 409, 'The schedule has an unresolved run.'); }
}
