import { isValidAccountIdentifier, normalizeAccountIdentifier } from '@/modules/auth/domain/account-identifier';

describe('account identifier', () => {
  it('normalizes spaces and case before lookup', () => {
    expect(normalizeAccountIdentifier('  My.User_2  ')).toBe('my.user_2');
  });

  it.each(['owner', 'a.b_2', 'user-name-9'])('accepts %s', (identifier) => {
    expect(isValidAccountIdentifier(identifier)).toBe(true);
  });

  it.each(['', 'ab', '-owner', 'has space', 'ümlaut'])('rejects invalid identifier %s', (identifier) => {
    expect(isValidAccountIdentifier(identifier)).toBe(false);
  });
});
