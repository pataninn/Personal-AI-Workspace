import { getJson } from '@/shared/api';
import type { AccountStorageUsage, AccountUsageSnapshot, CreditUsage } from '@/entities/account-usage/model/types';

export async function getAccountUsage(): Promise<AccountUsageSnapshot> {
  return normalizeAccountUsage(await getJson<unknown>('/api/v1/account/usage'));
}

function normalizeAccountUsage(value: unknown): AccountUsageSnapshot {
  const root = record(value);
  const daily = record(root?.daily);
  const lifetime = record(root?.lifetime);
  const storage = normalizeStorage(root?.storage);
  const availability = record(root?.availability);
  const status = availability?.status;
  if (!root || !daily || !lifetime || !storage || !availability || !isDate(root.asOf)
    || (root.expiresAt !== null && !isDate(root.expiresAt))
    || (status !== 'available' && status !== 'exhausted' && status !== 'paused' && status !== 'unknown')
    || typeof availability.canSubmit !== 'boolean'
    || (availability.reason !== null && typeof availability.reason !== 'string')) throw invalidResponse();
  const dailyUsage = normalizeCredit(daily);
  const lifetimeUsage = normalizeCredit(lifetime);
  if (!dailyUsage || !lifetimeUsage || !isDate(daily.resetAt) || typeof daily.timeZone !== 'string') throw invalidResponse();
  if (availability.canSubmit !== (status === 'available')) throw invalidResponse();
  return {
    asOf: root.asOf,
    expiresAt: root.expiresAt,
    daily: { ...dailyUsage, resetAt: daily.resetAt, timeZone: daily.timeZone },
    lifetime: lifetimeUsage,
    storage,
    availability: { status, reason: availability.reason, canSubmit: availability.canSubmit }
  };
}

function normalizeCredit(value: Record<string, unknown>): CreditUsage | null {
  if (!isDecimalOrNull(value.limitUnits) || !isDecimal(value.settledUnits) || !isDecimal(value.reservedUnits)
    || !isDecimalOrNull(value.remainingUnits)) return null;
  return { limitUnits: value.limitUnits, settledUnits: value.settledUnits, reservedUnits: value.reservedUnits, remainingUnits: value.remainingUnits };
}

function normalizeStorage(value: unknown): AccountStorageUsage | null {
  const storage = record(value);
  if (!storage || (storage.state !== 'ready' && storage.state !== 'reconciling' && storage.state !== 'unavailable')
    || storage.unit !== 'bytes' || storage.unitSystem !== 'decimal-si'
    || !isDecimalOrNull(storage.usedBytes) || !isDecimalOrNull(storage.reservedBytes) || !isDecimalOrNull(storage.limitBytes)
    || !isDecimalOrNull(storage.availableBytes) || (storage.overLimit !== null && typeof storage.overLimit !== 'boolean')
    || (storage.asOf !== null && !isDate(storage.asOf))) return null;
  return storage as unknown as AccountStorageUsage;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isDecimal(value: unknown): value is string { return typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value); }
function isDecimalOrNull(value: unknown): value is string | null { return value === null || isDecimal(value); }
function isDate(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function invalidResponse(): Error { return new Error('The usage response is invalid.'); }
