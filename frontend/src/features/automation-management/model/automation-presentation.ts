import type { AutomationOccurrence, AutomationOccurrenceStatus } from '@/entities/automation';

const ACTIVE_STATUSES: readonly AutomationOccurrenceStatus[] = [
  'queued', 'claimed', 'dispatching', 'running', 'cancel_requested', 'interrupted_unknown'
];

export function hasUnresolvedOccurrence(occurrences: readonly AutomationOccurrence[]): boolean {
  return occurrences.some((occurrence) => ACTIVE_STATUSES.includes(occurrence.status));
}

export function occurrenceStatusLabel(status: AutomationOccurrenceStatus, failureCode: string | null): string {
  if (status === 'dispatching') return 'Starting';
  if (status === 'interrupted_unknown') return 'Interrupted — outcome and usage pending reconciliation';
  if (status === 'skipped' && failureCode === 'BUDGET_EXHAUSTED') return 'Skipped — AI budget';
  const labels: Record<AutomationOccurrenceStatus, string> = {
    queued: 'Queued', claimed: 'Running', dispatching: 'Starting', running: 'Running',
    succeeded: 'Succeeded', failed: 'Failed', cancel_requested: 'Cancelling',
    cancelled: 'Cancelled', interrupted_unknown: 'Interrupted — outcome and usage pending reconciliation', skipped: 'Skipped'
  };
  return labels[status];
}

export function formatDateInTimeZone(value: string | null, timeZone: string): string {
  if (!value) return 'No next run';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Time unavailable';
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium', timeStyle: 'short', timeZone
    }).format(date);
  } catch {
    return 'Time unavailable';
  }
}

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
