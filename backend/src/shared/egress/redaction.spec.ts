import { containsCredentialLikeValue, containsPotentialSecret, redactCommandOutputText, redactEgressText } from '@/shared/egress/redaction';

describe('egress redaction', () => {
  it('preserves HTML closing and self-closing tags without exposing real host paths', () => {
    const markup = '<h1>Hello</h1><section /><img src="images/icon.svg" />';
    expect(redactEgressText(markup)).toBe(markup);
    expect(containsPotentialSecret(`Create App.svelte containing ${markup}`)).toBe(false);
    const redacted = redactEgressText(`${markup} /workspace/private/notes.txt C:\\Users\\person\\notes.txt`);
    expect(redacted).toContain(markup);
    expect(redacted).not.toContain('/workspace/private');
    expect(redacted).not.toContain('C:\\Users');
  });

  it('redacts generic assignments, service-account credentials, and embedded paths', () => {
    const redacted = redactEgressText('FOO=bar GCP_SERVICE_ACCOUNT_KEY=leak prefix C:\\Users\\person\\workspace\\src path=/workspace/project/src');

    expect(redacted).not.toContain('bar');
    expect(redacted).not.toContain('leak');
    expect(redacted).not.toContain('C:\\Users');
    expect(redacted).not.toContain('/workspace/project/src');
    expect(containsPotentialSecret('GCP_SERVICE_ACCOUNT_KEY=leak')).toBe(true);
  });

  it('removes ANSI and private key material through the shared result sanitizer', () => {
    const value = '\u001b[31m-----BEGIN PRIVATE KEY-----\\nsecret\\n-----END PRIVATE KEY-----\u001b[0m';

    const redacted = redactEgressText(value);

    expect(redacted).not.toContain('BEGIN PRIVATE KEY');
    expect(redacted).not.toContain('secret');
  });

  it('redacts lowercase and mixed-case assignments in command output', () => {
    const redacted = redactCommandOutputText('foo=bar Foo = "mixed-value" fOo=third-value');

    expect(redacted).not.toContain('bar');
    expect(redacted).not.toContain('mixed-value');
    expect(redacted).not.toContain('third-value');
  });

  it('keeps project-relative paths in ordinary requests', () => {
    expect(containsPotentialSecret('Please edit src/app.ts')).toBe(false);
    expect(redactEgressText('Please edit src/app.ts')).toBe('Please edit src/app.ts');
  });

  it('detects credential-like model proposal values while allowing ordinary assignments', () => {
    expect(containsCredentialLikeValue('NVIDIA_API_KEY=secret-value')).toBe(true);
    expect(containsCredentialLikeValue('token: leaked-value')).toBe(true);
    expect(containsCredentialLikeValue('const replacement = "updated";')).toBe(false);
  });
});
