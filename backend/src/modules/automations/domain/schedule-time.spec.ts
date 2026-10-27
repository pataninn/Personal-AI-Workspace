import { nextScheduledInstant, planDailyCatchUp, resolveScheduledInstant } from '@/modules/automations/domain/schedule-time';

describe('daily schedule time resolution', () => {
  it('chooses the first valid local instant after a spring-forward gap', () => {
    const resolved = resolveScheduledInstant({
      localDate: '2024-03-10',
      localTime: '02:30',
      timeZone: 'America/Los_Angeles'
    });

    expect(resolved.intendedFor.toISOString()).toBe('2024-03-10T10:00:00.000Z');
  });

  it('chooses the earlier instant for a fall-back repeated time', () => {
    const resolved = resolveScheduledInstant({
      localDate: '2024-11-03',
      localTime: '01:30',
      timeZone: 'America/Los_Angeles'
    });

    expect(resolved.intendedFor.toISOString()).toBe('2024-11-03T08:30:00.000Z');
  });

  it('returns the next strictly future local occurrence across a DST boundary', () => {
    const resolved = nextScheduledInstant(new Date('2024-03-10T10:01:00.000Z'), '02:30', 'America/Los_Angeles');

    expect(resolved.localDate).toBe('2024-03-11');
    expect(resolved.intendedFor.toISOString()).toBe('2024-03-11T09:30:00.000Z');
  });

  it('coalesces downtime to the most recent due local date and next future occurrence', () => {
    const plan = planDailyCatchUp({
      now: new Date('2024-03-11T11:00:00.000Z'),
      firstDueAt: new Date('2024-03-07T16:30:00.000Z'),
      localTime: '08:30',
      timeZone: 'America/Los_Angeles'
    });

    expect(plan.catchUp?.localDate).toBe('2024-03-10');
    expect(plan.catchUp?.intendedFor.toISOString()).toBe('2024-03-10T15:30:00.000Z');
    expect(plan.next.localDate).toBe('2024-03-11');
    expect(plan.next.intendedFor.toISOString()).toBe('2024-03-11T15:30:00.000Z');
  });

  it('does not create catch-up when the first due instant is still in the future', () => {
    const plan = planDailyCatchUp({
      now: new Date('2024-03-11T14:00:00.000Z'),
      firstDueAt: new Date('2024-03-11T15:30:00.000Z'),
      localTime: '08:30',
      timeZone: 'America/Los_Angeles'
    });

    expect(plan.catchUp).toBeNull();
    expect(plan.next.intendedFor.toISOString()).toBe('2024-03-11T15:30:00.000Z');
  });
});
