import { createHash } from 'node:crypto';

import type { IClock } from '@/modules/auth/repositories/security-providers';
import type { IPrincipalAuthorization } from '@/modules/auth/use-cases/principal-authorization';
import type { AutomationOccurrence, AutomationSchedule } from '@/modules/automations/domain/automation-types';
import {
  AutomationIdempotencyConflictError,
  AutomationNotFoundError,
  AutomationRevisionConflictError,
  AutomationSkillNotReadOnlyError,
  AutomationSkillUnavailableError,
  AutomationWorkspaceUnavailableError
} from '@/modules/automations/domain/automation-errors';
import { assertLocalTime, nextScheduledInstant } from '@/modules/automations/domain/schedule-time';
import type { IAutomationRepository } from '@/modules/automations/repositories/automation-repository';
import type { CancelHomeTurnUseCase } from '@/modules/home-assistant/use-cases/cancel-home-turn';
import type { CreateHomeConversationUseCase } from '@/modules/home-assistant/use-cases/create-home-conversation';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { ISkillRepository } from '@/modules/skills/repositories/skill-repository';
import { AppError } from '@/shared/errors/app-error';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._~-]{8,128}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const READ_CAPABILITIES = new Set(['home_task_read', 'home_workspace_read']);

export interface CreateAutomationScheduleInput {
  readonly ownerId: string;
  readonly idempotencyKey: unknown;
  readonly workspaceId: unknown;
  readonly skillId: unknown;
  readonly skillVersion: unknown;
  readonly localTime: unknown;
  readonly timeZone: unknown;
}

export interface UpdateAutomationScheduleInput {
  readonly ownerId: string;
  readonly scheduleId: string;
  readonly expectedRevision: unknown;
  readonly skillId?: unknown;
  readonly skillVersion?: unknown;
  readonly localTime?: unknown;
  readonly timeZone?: unknown;
  readonly enabled?: unknown;
}

export class CreateAutomationScheduleUseCase {
  public constructor(
    private readonly repository: IAutomationRepository,
    private readonly conversations: CreateHomeConversationUseCase,
    private readonly projects: IProjectRepository,
    private readonly skills: ISkillRepository,
    private readonly principals: IPrincipalAuthorization,
    private readonly clock: IClock
  ) {}

  public async execute(input: CreateAutomationScheduleInput): Promise<{ readonly schedule: AutomationSchedule; readonly replayed: boolean }> {
    const key = validateIdempotencyKey(input.idempotencyKey);
    const workspaceId = validateUuid(input.workspaceId, 'workspaceId');
    const skillId = validateUuid(input.skillId, 'skillId');
    const skillVersion = validatePositiveInteger(input.skillVersion, 'skillVersion');
    const localTime = validateTime(input.localTime);
    const timeZone = validateTimeZone(input.timeZone);
    await this.principals.assertActive(input.ownerId);
    const createKeyDigest = digest(key);
    const requestFingerprint = digest(JSON.stringify({ workspaceId, skillId, skillVersion, localTime, timeZone }));
    const replay = await this.repository.findCreatedSchedule(input.ownerId, createKeyDigest, requestFingerprint);
    if (replay) return { schedule: replay, replayed: true };
    await assertActiveWorkspace(this.projects, input.ownerId, workspaceId);
    const skill = await this.skills.findActiveById(input.ownerId, skillId);
    assertScheduledSkill(skill, workspaceId, skillVersion);
    const conversation = await this.conversations.execute({
      ownerId: input.ownerId,
      scope: { kind: 'workspace', workspaceId },
      title: 'Scheduled daily briefing',
      requestKey: `automation-${createKeyDigest.slice(0, 48)}`
    });
    const nextDue = nextScheduledInstant(this.clock.now(), localTime, timeZone);
    return await this.repository.createSchedule({
      ownerId: input.ownerId,
      workspaceId,
      conversationId: conversation.resource.id,
      skillId,
      skillVersion: skill.version,
      skillRevisionId: skill.revisionId,
      localTime,
      timeZone,
      nextDueAt: nextDue.intendedFor,
      createKeyDigest,
      requestFingerprint
    });
  }
}

export class ListAutomationSchedulesUseCase {
  public constructor(private readonly repository: IAutomationRepository) {}
  public async execute(input: { readonly ownerId: string }): Promise<readonly AutomationSchedule[]> {
    return await this.repository.listSchedules(input.ownerId);
  }
}

export class UpdateAutomationScheduleUseCase {
  public constructor(
    private readonly repository: IAutomationRepository,
    private readonly projects: IProjectRepository,
    private readonly skills: ISkillRepository,
    private readonly principals: IPrincipalAuthorization,
    private readonly cancelHomeTurn: CancelHomeTurnUseCase,
    private readonly clock: IClock
  ) {}

  public async execute(input: UpdateAutomationScheduleInput): Promise<AutomationSchedule> {
    const scheduleId = validateUuid(input.scheduleId, 'scheduleId');
    const expectedRevision = validatePositiveInteger(input.expectedRevision, 'expectedRevision');
    await this.principals.assertActive(input.ownerId);
    const current = await this.repository.findSchedule(input.ownerId, scheduleId);
    if (!current) throw new AutomationNotFoundError();
    if (current.revision !== expectedRevision) throw new AutomationRevisionConflictError();
    const skillId = input.skillId === undefined ? current.skillId : validateUuid(input.skillId, 'skillId');
    const skillVersion = input.skillVersion === undefined ? current.skillVersion : validatePositiveInteger(input.skillVersion, 'skillVersion');
    if ((input.skillId === undefined) !== (input.skillVersion === undefined)) {
      throw validationError('skillId and skillVersion must be updated together.');
    }
    const localTime = input.localTime === undefined ? current.localTime : validateTime(input.localTime);
    const timeZone = input.timeZone === undefined ? current.timeZone : validateTimeZone(input.timeZone);
    const enabled = input.enabled === undefined ? current.enabled : validateBoolean(input.enabled, 'enabled');
    await assertActiveWorkspace(this.projects, input.ownerId, current.workspaceId);
    let revisionId = current.skillRevisionId;
    if (enabled || input.skillId !== undefined) {
      const skill = await this.skills.findActiveById(input.ownerId, skillId);
      assertScheduledSkill(skill, current.workspaceId, skillVersion);
      revisionId = skill.revisionId;
    }
    const nextDueAt = enabled ? nextScheduledInstant(this.clock.now(), localTime, timeZone).intendedFor : null;
    const updated = await this.repository.updateSchedule({
      ownerId: input.ownerId,
      scheduleId,
      expectedRevision,
      skillId,
      skillVersion,
      skillRevisionId: revisionId,
      localTime,
      timeZone,
      enabled,
      nextDueAt
    });
    for (const turn of updated.activeTurns) {
      try {
        const result = await this.cancelHomeTurn.execute({
          ownerId: turn.ownerId,
          conversationId: turn.conversationId,
          turnId: turn.turnId
        });
        await this.repository.recordCancellationResult({ occurrenceId: turn.occurrenceId, status: cancellationStatus(result.resource.status) });
      } catch {
        await this.repository.recordCancellationResult({ occurrenceId: turn.occurrenceId, status: 'interrupted_unknown' });
      }
    }
    return updated.schedule;
  }
}

export class RunAutomationNowUseCase {
  public constructor(
    private readonly repository: IAutomationRepository,
    private readonly principals: IPrincipalAuthorization
  ) {}

  public async execute(input: { readonly ownerId: string; readonly scheduleId: string; readonly expectedRevision?: unknown; readonly idempotencyKey: unknown }): Promise<{ readonly occurrence: AutomationOccurrence; readonly replayed: boolean }> {
    const scheduleId = validateUuid(input.scheduleId, 'scheduleId');
    const key = validateIdempotencyKey(input.idempotencyKey);
    await this.principals.assertActive(input.ownerId);
    const schedule = await this.repository.findSchedule(input.ownerId, scheduleId);
    if (!schedule) throw new AutomationNotFoundError();
    const expectedRevision = input.expectedRevision === undefined ? schedule.revision : validatePositiveInteger(input.expectedRevision, 'expectedRevision');
    const requestKeyDigest = digest(key);
    return await this.repository.createManualOccurrence({
      ownerId: input.ownerId,
      scheduleId,
      expectedRevision,
      requestKeyDigest,
      requestFingerprint: digest(JSON.stringify({ scheduleId, kind: 'manual' }))
    });
  }
}

export class ListAutomationOccurrencesUseCase {
  public constructor(private readonly repository: IAutomationRepository) {}
  public async execute(input: { readonly ownerId: string; readonly scheduleId: string; readonly limit: number; readonly before?: string }) {
    const result = await this.repository.listOccurrences(input);
    if (!result) throw new AutomationNotFoundError();
    return result;
  }
}

export function validateScheduledSkill(
  skill: Awaited<ReturnType<ISkillRepository['findActiveById']>>,
  workspaceId: string,
  skillVersion?: number,
  revisionId?: string
): asserts skill is NonNullable<typeof skill> {
  assertScheduledSkill(skill, workspaceId, skillVersion, revisionId);
}

function assertScheduledSkill(
  skill: Awaited<ReturnType<ISkillRepository['findActiveById']>>,
  workspaceId: string,
  skillVersion?: number,
  revisionId?: string
): asserts skill is NonNullable<typeof skill> {
  if (!skill || !skill.enabled || skill.workspaceId !== null && skill.workspaceId !== workspaceId) {
    throw new AutomationSkillUnavailableError();
  }
  if ((skillVersion !== undefined && skill.version !== skillVersion) || (revisionId !== undefined && skill.revisionId !== revisionId)) {
    throw new AppError('SKILL_VERSION_CONFLICT', 409, 'The skill changed. Select its current version before scheduling.');
  }
  if (!skill.declaredTools.every((capability) => READ_CAPABILITIES.has(capability))) throw new AutomationSkillNotReadOnlyError();
}

async function assertActiveWorkspace(projects: IProjectRepository, ownerId: string, workspaceId: string): Promise<void> {
  const project = await projects.findByIdForOwner(ownerId, workspaceId);
  if (!project || project.status !== 'active') throw new AutomationWorkspaceUnavailableError();
}

function validateIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) throw validationError('A valid Idempotency-Key is required.');
  return value;
}

function validateUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw validationError(`${field} must be a UUID.`);
  return value;
}

function validatePositiveInteger(value: unknown, field: string): number {
  const number = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isSafeInteger(number) || number < 1) throw validationError(`${field} must be a positive integer.`);
  return number;
}

function validateTime(value: unknown): string {
  if (typeof value !== 'string') throw validationError('localTime must use HH:mm format.');
  try { return assertLocalTime(value); } catch { throw validationError('localTime must use HH:mm format.'); }
}

function validateTimeZone(value: unknown): string {
  if (typeof value !== 'string') throw validationError('timeZone must be a valid IANA timezone.');
  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).resolvedOptions().timeZone;
    if (!canonical || value.trim().length > 128) throw new RangeError();
    return canonical;
  } catch { throw validationError('timeZone must be a valid IANA timezone.'); }
}

function validateBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw validationError(`${field} must be a boolean.`);
  return value;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validationError(message: string): AppError {
  return new AppError('VALIDATION_ERROR', 400, message);
}

function cancellationStatus(status: string): 'succeeded' | 'failed' | 'cancelled' | 'skipped' | 'interrupted_unknown' {
  if (status === 'completed' || status === 'partial') return 'succeeded';
  if (status === 'failed') return 'failed';
  if (status === 'unsupported') return 'skipped';
  if (status === 'cancelled') return 'cancelled';
  return 'interrupted_unknown';
}
