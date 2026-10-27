import { canonicalCreditTimeZone } from '@/modules/credits/domain/credit-time-windows';

export interface LocalScheduleTime {
  readonly localDate: string;
  readonly localTime: string;
  readonly timeZone: string;
}

export interface ScheduledInstant {
  readonly localDate: string;
  readonly intendedFor: Date;
}

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/u;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const SECOND_MS = 1000;

/** Resolves one local minute. Gaps map to the transition instant; folds map to the earlier instant. */
export function resolveScheduledInstant(input: LocalScheduleTime): ScheduledInstant {
  const target = parseLocalDateTime(input.localDate, input.localTime);
  const timeZone = canonicalCreditTimeZone(input.timeZone);
  const offsets = nearbyOffsets(target.epoch, timeZone);
  const exact = offsets
    .map((offset) => target.epoch - offset)
    .filter((instant) => localDateTimeKey(new Date(instant), timeZone) === target.key)
    .sort((left, right) => left - right)[0];

  if (exact !== undefined) return { localDate: input.localDate, intendedFor: new Date(exact) };

  const gapTransition = findForwardGapTransition(target.epoch, target.key, timeZone);
  if (gapTransition !== null) return { localDate: input.localDate, intendedFor: gapTransition };

  throw new RangeError('The local date and time could not be resolved in this IANA timezone.');
}

/** Finds the first future daily occurrence strictly after `after`. */
export function nextScheduledInstant(after: Date, localTime: string, timeZone: string): ScheduledInstant {
  if (!Number.isFinite(after.getTime())) throw new RangeError('A valid current instant is required.');
  const canonicalZone = canonicalCreditTimeZone(timeZone);
  assertLocalTime(localTime);
  let localDate = localDateAt(after, canonicalZone);
  let occurrence = resolveScheduledInstant({ localDate, localTime, timeZone: canonicalZone });
  if (occurrence.intendedFor.getTime() <= after.getTime()) {
    localDate = addCalendarDays(localDate, 1);
    occurrence = resolveScheduledInstant({ localDate, localTime, timeZone: canonicalZone });
  }
  return occurrence;
}

/** Coalesces a delayed daily schedule to its most recent due local date and next future instant. */
export function planDailyCatchUp(input: {
  readonly now: Date;
  readonly firstDueAt: Date;
  readonly localTime: string;
  readonly timeZone: string;
}): { readonly catchUp: ScheduledInstant | null; readonly next: ScheduledInstant } {
  if (!Number.isFinite(input.now.getTime()) || !Number.isFinite(input.firstDueAt.getTime())) {
    throw new RangeError('Valid schedule instants are required.');
  }
  const next = nextScheduledInstant(input.now, input.localTime, input.timeZone);
  if (input.firstDueAt.getTime() > input.now.getTime()) return { catchUp: null, next };

  const timeZone = canonicalCreditTimeZone(input.timeZone);
  let localDate = localDateAt(input.now, timeZone);
  let latestDue = resolveScheduledInstant({ localDate, localTime: input.localTime, timeZone });
  if (latestDue.intendedFor.getTime() > input.now.getTime()) {
    localDate = addCalendarDays(localDate, -1);
    latestDue = resolveScheduledInstant({ localDate, localTime: input.localTime, timeZone });
  }
  return {
    catchUp: latestDue.intendedFor.getTime() >= input.firstDueAt.getTime() ? latestDue : null,
    next
  };
}

export function assertLocalTime(value: string): string {
  if (typeof value !== 'string' || !LOCAL_TIME.test(value)) throw new RangeError('Use local time in HH:mm format.');
  return value;
}

function parseLocalDateTime(localDate: string, localTime: string): { readonly epoch: number; readonly key: string } {
  const dateMatch = LOCAL_DATE.exec(localDate);
  const timeMatch = LOCAL_TIME.exec(localTime);
  if (!dateMatch || !timeMatch) throw new RangeError('A valid local date and HH:mm time are required.');
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, 0, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new RangeError('A valid local calendar date is required.');
  }
  return { epoch: date.getTime(), key: localKey(year, month, day, hour, minute) };
}

function nearbyOffsets(targetEpoch: number, timeZone: string): readonly number[] {
  const offsets = new Set<number>();
  for (let offset = -36; offset <= 36; offset += 3) {
    offsets.add(timeZoneOffsetAt(targetEpoch + offset * HOUR_MS, timeZone));
  }
  return [...offsets];
}

function findForwardGapTransition(targetEpoch: number, targetKey: string, timeZone: string): Date | null {
  const start = targetEpoch - 36 * HOUR_MS;
  const end = targetEpoch + 36 * HOUR_MS;
  const step = 3 * HOUR_MS;
  let previousInstant = start;
  let previousOffset = timeZoneOffsetAt(previousInstant, timeZone);

  for (let sample = start + step; sample <= end; sample += step) {
    const currentOffset = timeZoneOffsetAt(sample, timeZone);
    if (currentOffset !== previousOffset) {
      const transition = firstInstantWithOffset(previousInstant, sample, previousOffset, timeZone);
      if (currentOffset > previousOffset) {
        const before = localDateTimeKey(new Date(transition.getTime() - SECOND_MS), timeZone);
        const after = localDateTimeKey(transition, timeZone);
        if (targetKey > before && targetKey < after) return transition;
      }
    }
    previousInstant = sample;
    previousOffset = currentOffset;
  }
  return null;
}

function firstInstantWithOffset(lowInstant: number, highInstant: number, oldOffset: number, timeZone: string): Date {
  let low = lowInstant;
  let high = highInstant;
  while (high - low > SECOND_MS) {
    const middle = low + Math.floor((high - low) / (2 * SECOND_MS)) * SECOND_MS;
    if (middle <= low) break;
    if (timeZoneOffsetAt(middle, timeZone) === oldOffset) low = middle;
    else high = middle;
  }
  while (timeZoneOffsetAt(high, timeZone) === oldOffset) high += SECOND_MS;
  return new Date(high);
}

function timeZoneOffsetAt(instant: number, timeZone: string): number {
  const date = new Date(instant);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, Number(part.value)]));
  const localEpoch = utcEpoch(
    requiredPart(values, 'year'), requiredPart(values, 'month'), requiredPart(values, 'day'),
    requiredPart(values, 'hour'), requiredPart(values, 'minute'), requiredPart(values, 'second')
  );
  return localEpoch - Math.floor(instant / SECOND_MS) * SECOND_MS;
}

function localDateTimeKey(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(instant);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return localKey(
    Number(values.get('year')), Number(values.get('month')), Number(values.get('day')),
    Number(values.get('hour')), Number(values.get('minute'))
  );
}

function localDateAt(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get('year');
  const month = values.get('month');
  const day = values.get('day');
  if (!year || !month || !day) throw new RangeError('The IANA timezone could not be evaluated.');
  return `${year.padStart(4, '0')}-${month}-${day}`;
}

function addCalendarDays(localDate: string, days: number): string {
  const match = LOCAL_DATE.exec(localDate);
  if (!match) throw new RangeError('A valid local date is required.');
  const date = new Date(0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days);
  return `${date.getUTCFullYear().toString().padStart(4, '0')}-${(date.getUTCMonth() + 1).toString().padStart(2, '0')}-${date.getUTCDate().toString().padStart(2, '0')}`;
}

function utcEpoch(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

function localKey(year: number, month: number, day: number, hour: number, minute: number): string {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}T${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
}

function requiredPart(values: ReadonlyMap<string, number>, part: string): number {
  const value = values.get(part);
  if (value === undefined || !Number.isFinite(value)) throw new RangeError('The IANA timezone could not be evaluated.');
  return value;
}
