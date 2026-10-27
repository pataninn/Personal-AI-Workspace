import { creditDailyWindowAt, nextCreditTimeZoneChangeBoundary, utcDailyWindowAt } from '@/modules/credits/domain/credit-time-windows';

describe('credit daily windows', () => {
  it('uses local midnight boundaries for account IANA timezones', () => {
    const window = creditDailyWindowAt(new Date('2026-10-18T16:00:00.000Z'), 'Asia/Shanghai');
    expect(window.localDate).toBe('2026-10-19');
    expect(window.startsAt.toISOString()).toBe('2026-10-18T16:00:00.000Z');
    expect(window.endsAt.toISOString()).toBe('2026-10-19T16:00:00.000Z');
  });

  it('preserves daylight-saving short and long local days', () => {
    const shortDay = creditDailyWindowAt(new Date('2026-03-08T16:00:00.000Z'), 'America/Los_Angeles');
    const longDay = creditDailyWindowAt(new Date('2026-11-01T16:00:00.000Z'), 'America/Los_Angeles');
    expect(shortDay.endsAt.getTime() - shortDay.startsAt.getTime()).toBe(23 * 60 * 60 * 1000);
    expect(longDay.endsAt.getTime() - longDay.startsAt.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it('queues timezone changes to the old zone boundary and anchors the first new window there', () => {
    const instant = new Date('2026-10-19T03:00:00.000Z');
    const effectiveAt = nextCreditTimeZoneChangeBoundary(instant, 'Asia/Shanghai');
    expect(effectiveAt.toISOString()).toBe('2026-10-19T16:00:00.000Z');
    const newWindow = creditDailyWindowAt(new Date('2026-10-20T02:00:00.000Z'), 'America/Los_Angeles', effectiveAt);
    expect(newWindow.startsAt).toEqual(effectiveAt);
    expect(newWindow.endsAt.toISOString()).toBe('2026-10-20T07:00:00.000Z');
  });

  it('uses fixed UTC boundaries for deployment demo windows', () => {
    const window = utcDailyWindowAt(new Date('2026-10-19T00:00:00.000Z'));
    expect(window.startsAt.toISOString()).toBe('2026-10-19T00:00:00.000Z');
    expect(window.endsAt.toISOString()).toBe('2026-10-20T00:00:00.000Z');
  });

  it('rejects unknown timezone identifiers', () => {
    expect(() => creditDailyWindowAt(new Date(), 'not/a-timezone')).toThrow(RangeError);
  });
});
