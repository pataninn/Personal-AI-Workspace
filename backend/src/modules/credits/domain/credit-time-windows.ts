export interface CreditDailyWindow {
  readonly timeZone: string;
  readonly localDate: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

export function canonicalCreditTimeZone(timeZone: string): string {
  const value = timeZone.trim();
  if (value.length === 0 || value.length > 128) throw new RangeError('A valid IANA timezone is required.');
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw new RangeError('A valid IANA timezone is required.');
  }
}

/** Returns the local calendar-day interval as UTC instants, including 23/25-hour DST days. */
export function creditDailyWindowAt(instant: Date, timeZone: string, timeZoneStartedAt?: Date | null): CreditDailyWindow {
  if (!Number.isFinite(instant.getTime())) throw new RangeError('A valid instant is required.');
  const canonicalZone = canonicalCreditTimeZone(timeZone);
  const localDate = localDateAt(instant, canonicalZone);
  const startsAt = firstInstantOfLocalDate(localDate, canonicalZone);
  const nextLocalDate = addCalendarDays(localDate, 1);
  const regularEnd = firstInstantOfLocalDate(nextLocalDate, canonicalZone);
  const anchor = timeZoneStartedAt?.getTime();
  const effectiveStart = anchor !== undefined && anchor > startsAt.getTime() && anchor <= instant.getTime()
    ? new Date(anchor)
    : startsAt;
  const endsAt = effectiveStart.getTime() < regularEnd.getTime()
    ? regularEnd
    : firstInstantOfLocalDate(addCalendarDays(nextLocalDate, 1), canonicalZone);
  return { timeZone: canonicalZone, localDate, startsAt: effectiveStart, endsAt };
}

/** The next account-local midnight; timezone changes are applied only at this instant. */
export function nextCreditTimeZoneChangeBoundary(instant: Date, timeZone: string): Date {
  const canonicalZone = canonicalCreditTimeZone(timeZone);
  return firstInstantOfLocalDate(addCalendarDays(localDateAt(instant, canonicalZone), 1), canonicalZone);
}

export function utcDailyWindowAt(instant: Date): CreditDailyWindow {
  return creditDailyWindowAt(instant, 'UTC');
}

function localDateAt(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(instant);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get('year');
  const month = values.get('month');
  const day = values.get('day');
  if (!year || !month || !day) throw new RangeError('The IANA timezone could not be evaluated.');
  return `${year.padStart(4, '0')}-${month}-${day}`;
}

function firstInstantOfLocalDate(localDate: string, timeZone: string): Date {
  const [year, month, day] = localDate.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined || !Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    throw new RangeError('A valid local date is required.');
  }
  const nominalUtc = Date.UTC(year, month - 1, day);
  let low = nominalUtc - 48 * 60 * 60 * 1000;
  let high = nominalUtc + 48 * 60 * 60 * 1000;
  if (localDateAt(new Date(low), timeZone) >= localDate || localDateAt(new Date(high), timeZone) < localDate) {
    throw new RangeError('Unable to resolve an IANA local-day boundary.');
  }
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (localDateAt(new Date(middle), timeZone) >= localDate) high = middle;
    else low = middle;
  }
  return new Date(high);
}

function addCalendarDays(localDate: string, days: number): string {
  const [year, month, day] = localDate.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined || !Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    throw new RangeError('A valid local date is required.');
  }
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return `${next.getUTCFullYear().toString().padStart(4, '0')}-${(next.getUTCMonth() + 1).toString().padStart(2, '0')}-${next.getUTCDate().toString().padStart(2, '0')}`;
}
