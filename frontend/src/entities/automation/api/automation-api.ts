import { getJson, patchJson, postJson } from '@/shared/api';
import type {
  AutomationOccurrence,
  AutomationOccurrencePage,
  AutomationSchedule,
  CreateAutomationScheduleRequest,
  UpdateAutomationScheduleRequest
} from '@/entities/automation/model/types';

const AUTOMATIONS_PATH = '/api/v1/automations/schedules';

export async function listAutomationSchedules(): Promise<readonly AutomationSchedule[]> {
  const response = await getJson<{ readonly schedules: AutomationSchedule[] }>(AUTOMATIONS_PATH);
  return response.schedules;
}

export async function createAutomationSchedule(
  request: CreateAutomationScheduleRequest,
  csrfToken: string,
  idempotencyKey: string
): Promise<AutomationSchedule> {
  const response = await postJson<{ readonly schedule: AutomationSchedule }>(AUTOMATIONS_PATH, request, {
    'X-CSRF-Token': csrfToken,
    'Idempotency-Key': idempotencyKey
  });
  return response.schedule;
}

export async function updateAutomationSchedule(
  scheduleId: string,
  request: UpdateAutomationScheduleRequest,
  csrfToken: string
): Promise<AutomationSchedule> {
  const response = await patchJson<{ readonly schedule: AutomationSchedule }>(
    `${AUTOMATIONS_PATH}/${encodeURIComponent(scheduleId)}`,
    request,
    { 'X-CSRF-Token': csrfToken }
  );
  return response.schedule;
}

export async function runAutomationNow(
  scheduleId: string,
  csrfToken: string,
  idempotencyKey: string
): Promise<AutomationOccurrence> {
  const response = await postJson<{ readonly occurrence: AutomationOccurrence }>(
    `${AUTOMATIONS_PATH}/${encodeURIComponent(scheduleId)}/runs`,
    {},
    { 'X-CSRF-Token': csrfToken, 'Idempotency-Key': idempotencyKey }
  );
  return response.occurrence;
}

export function listAutomationOccurrences(
  scheduleId: string,
  before?: string
): Promise<AutomationOccurrencePage> {
  const query = new URLSearchParams({ limit: '50' });
  if (before) query.set('before', before);
  return getJson<AutomationOccurrencePage>(`${AUTOMATIONS_PATH}/${encodeURIComponent(scheduleId)}/occurrences?${query.toString()}`);
}
