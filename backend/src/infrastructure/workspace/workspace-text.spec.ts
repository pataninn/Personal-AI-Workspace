import { WorkspaceBinaryFileError } from '@/modules/files/domain/workspace-errors';
import { boundText, decodeUtf8, redactSensitiveText } from '@/infrastructure/workspace/workspace-text';

describe('workspace text safety', () => {
  it.each([
    Buffer.from([1]),
    Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
    Buffer.from([9, 10, 13, 31]),
    Buffer.from([0xc2, 0x81])
  ])('rejects a control-only payload as binary', (payload) => {
    expect(() => decodeUtf8(payload)).toThrow(WorkspaceBinaryFileError);
  });

  it('allows ordinary UTF-8 whitespace and Unicode text', () => {
    expect(decodeUtf8(Buffer.from('hello\tworld\n世界\r\n', 'utf8'))).toBe('hello\tworld\n世界\r\n');
  });

  it('redacts a complete private-key block while preserving line boundaries', () => {
    const value = 'before\n-----BEGIN RSA PRIVATE KEY-----\nSECRET_BODY_123456\n-----END RSA PRIVATE KEY-----\nafter';
    const redacted = redactSensitiveText(value);

    expect(redacted).not.toContain('SECRET_BODY_123456');
    expect(redacted.split('\n')).toHaveLength(value.split('\n').length);
    expect(redacted).toContain('[REDACTED PRIVATE KEY]');
  });

  it('redacts private-key material before applying a line bound', () => {
    const value = '-----BEGIN RSA PRIVATE KEY-----\nSECRET_BODY_123456\n-----END RSA PRIVATE KEY-----\n';
    const result = boundText(value, Buffer.byteLength(value, 'utf8'), 2, 1024);

    expect(result.text).not.toContain('SECRET_BODY_123456');
  });
});
