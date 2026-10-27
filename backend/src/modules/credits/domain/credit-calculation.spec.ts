import { maximumCreditUnits, parseCreditRate, parseTokenLimit } from '@/modules/credits/domain/credit-calculation';

describe('credit calculation', () => {
  it('rounds input and output costs up independently with integer arithmetic', () => {
    expect(maximumCreditUnits(
      { inputTokens: 1, outputTokens: 1 },
      { inputUnitsPerMillionTokens: 1n, outputUnitsPerMillionTokens: 1n }
    )).toBe(2n);
  });

  it('calculates large amounts without floating-point precision loss', () => {
    expect(maximumCreditUnits(
      { inputTokens: 2_000_000, outputTokens: 1_000_000 },
      { inputUnitsPerMillionTokens: 1_000_001n, outputUnitsPerMillionTokens: 1_000_003n }
    )).toBe(3_000_005n);
  });

  it.each([
    { bounds: { inputTokens: -1, outputTokens: 1 }, rates: { inputUnitsPerMillionTokens: 1n, outputUnitsPerMillionTokens: 1n } },
    { bounds: { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 1 }, rates: { inputUnitsPerMillionTokens: 1n, outputUnitsPerMillionTokens: 1n } },
    { bounds: { inputTokens: 1, outputTokens: 1 }, rates: { inputUnitsPerMillionTokens: 0n, outputUnitsPerMillionTokens: 1n } }
  ])('rejects invalid bounds or rates', ({ bounds, rates }) => {
    expect(() => maximumCreditUnits(bounds, rates)).toThrow(RangeError);
  });

  it('parses only canonical positive integer configuration', () => {
    expect(parseCreditRate('1000000')).toBe(1_000_000n);
    expect(parseTokenLimit('16384')).toBe(16_384);
    for (const value of ['', '0', '01', '-1', '1.2', ' 2']) {
      expect(() => parseCreditRate(value)).toThrow(RangeError);
      expect(() => parseTokenLimit(value)).toThrow(RangeError);
    }
  });
});
