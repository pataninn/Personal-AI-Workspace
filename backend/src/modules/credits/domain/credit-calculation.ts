export const CREDIT_UNITS_PER_DISPLAYED_CREDIT = 1_000_000n;
export const TOKENS_PER_PRICE_UNIT = 1_000_000n;
export const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

export interface ProviderTokenBounds {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface CreditRates {
  readonly inputUnitsPerMillionTokens: bigint;
  readonly outputUnitsPerMillionTokens: bigint;
}

/** Integer-only pricing; each side is rounded up independently to avoid under-reserving. */
export function maximumCreditUnits(bounds: ProviderTokenBounds, rates: CreditRates): bigint {
  const total = creditUnitsForUsage(bounds, rates);
  if (total > POSTGRES_BIGINT_MAX) throw new RangeError('The calculated credit amount exceeds the supported integer range.');
  return total;
}

/** Calculates valid usage without narrowing the result to a database counter. */
export function creditUnitsForUsage(bounds: ProviderTokenBounds, rates: CreditRates): bigint {
  assertTokenCount(bounds.inputTokens, 'inputTokens');
  assertTokenCount(bounds.outputTokens, 'outputTokens');
  assertPositiveRate(rates.inputUnitsPerMillionTokens, 'inputUnitsPerMillionTokens');
  assertPositiveRate(rates.outputUnitsPerMillionTokens, 'outputUnitsPerMillionTokens');

  const inputCost = roundUp(BigInt(bounds.inputTokens) * rates.inputUnitsPerMillionTokens, TOKENS_PER_PRICE_UNIT);
  const outputCost = roundUp(BigInt(bounds.outputTokens) * rates.outputUnitsPerMillionTokens, TOKENS_PER_PRICE_UNIT);
  return inputCost + outputCost;
}

export function parseCreditRate(value: string): bigint {
  if (!/^[1-9][0-9]{0,18}$/u.test(value)) throw new RangeError('Credit rates must be positive integer decimal strings.');
  const parsed = BigInt(value);
  if (parsed > POSTGRES_BIGINT_MAX) throw new RangeError('Credit rates exceed the supported integer range.');
  return parsed;
}

export function parseTokenLimit(value: string): number {
  if (!/^[1-9][0-9]{0,8}$/u.test(value)) throw new RangeError('Token limits must be positive integer decimal strings.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RangeError('Token limits exceed the supported integer range.');
  return parsed;
}

function roundUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function assertTokenCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative safe integer.`);
}

function assertPositiveRate(value: bigint, name: string): void {
  if (value < 1n || value > POSTGRES_BIGINT_MAX) throw new RangeError(`${name} must be a positive PostgreSQL bigint.`);
}
