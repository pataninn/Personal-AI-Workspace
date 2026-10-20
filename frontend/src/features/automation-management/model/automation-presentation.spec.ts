import { describe, expect, it } from 'vitest';

import type { AutomationOccurrence } from '@/entities/automation';
import { formatDateInTimeZone, hasUnresolvedOccurrence, isValidTimeZone, occurrenceStatusLabel } from '@/features/automation-management';

function occurrence(status: AutomationOccurrence['status'], failureCode: string | null = null): AutomationOccurrence {
  return {
    id: '11111111-1111-4111-8111-111111111111', kind: 'manual', intendedFor: '2026-10-20T08:30:00.000Z', status,
    scheduleRevision: 1, skillVersion: 2, homeTurnId: null, failureCode, attemptCount: 1, taskSources: [],
    providerUsage: { state: 'not_started', calls: [] }, createdAt: '2026-10-20T08:30:00.000Z', updatedAt: '2026-10-20T08:30:00.000Z'
  };
}

describe('automation presentation', () => {
  it('blocks fresh runs for active and unknown outcomes but allows settled history', () => {
    expect(hasUnresolvedOccurrence([occurrence('queued')])).toBe(true);
    expect(hasUnresolvedOccurrence([occurrence('interrupted_unknown')])).toBe(true);
    expect(hasUnresolvedOccurrence([occurrence('succeeded')])).toBe(false);
    expect(hasUnresolvedOccurrence([occurrence('skipped', 'BUDGET_EXHAUSTED')])).toBe(false);
  });

  it('shows only safe status copy and exposes the budget reason only when confirmed', () => {
    expect(occurrenceStatusLabel('dispatching', null)).toBe('Starting');
    expect(occurrenceStatusLabel('skipped', 'BUDGET_EXHAUSTED')).toBe('Skipped — AI budget');
    expect(occurrenceStatusLabel('skipped', 'PRIVATE_INTERNAL_CODE')).toBe('Skipped');
  });

  it('validates IANA zones and formats authoritative instants in the saved zone', () => {
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true);
    expect(isValidTimeZone('Mars/Base')).toBe(false);
    const expected = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' })
      .format(new Date('2026-10-20T08:30:00.000Z'));
    expect(formatDateInTimeZone('2026-10-20T08:30:00.000Z', 'Asia/Shanghai')).toBe(expected);
    expect(formatDateInTimeZone(null, 'UTC')).toBe('No next run');
    expect(formatDateInTimeZone('bad-date', 'UTC')).toBe('Time unavailable');
  });
});
