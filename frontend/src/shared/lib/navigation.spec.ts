import { describe, expect, it } from 'vitest';

import { getSafeReturnTo, loginPath } from '@/shared/lib/navigation';

describe('getSafeReturnTo', () => {
  it('rejects external and backslash paths', () => {
    const unsafePaths = [
      '//attacker.example',
      '/\\attacker.example',
      '/\\\\attacker.example',
      '/dashboard\\..\\..\\attacker.example',
      'https://attacker.example'
    ];

    for (const path of unsafePaths) {
      expect(getSafeReturnTo(path)).toBeNull();
    }
  });

  it('rejects control characters in paths, queries, and fragments', () => {
    const unsafePaths = [
      '/\u0000dashboard',
      '/dashboard?tab=recent\nnext=external',
      '/dashboard#\u007f',
      '/dashboard?tab=\u0085'
    ];

    for (const path of unsafePaths) {
      expect(getSafeReturnTo(path)).toBeNull();
    }
  });

  it('accepts and preserves a same-origin route, query, and fragment', () => {
    expect(getSafeReturnTo('/dashboard?tab=recent#activity')).toBe('/dashboard?tab=recent#activity');
  });
});

describe('loginPath', () => {
  it('omits an unsafe return path while preserving the login reason', () => {
    expect(loginPath('session-expired', '/\\attacker.example')).toBe('/login?reason=session-expired');
  });
});
