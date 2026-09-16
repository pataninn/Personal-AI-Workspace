const SECRET_VALUE_PATTERN = /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|token)\s*[:=]\s*["']?)([^\s"'`,;}]{6,})/giu;
const PRIVATE_KEY_PATTERN = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu;

export function redactEgressText(text: string): string {
  return text.replace(PRIVATE_KEY_PATTERN, (privateKey) => {
    const lineBreaks = privateKey.match(/\r\n|\r|\n/gu)?.join('') ?? '';
    return `[REDACTED PRIVATE KEY]${lineBreaks}`;
  }).replace(SECRET_VALUE_PATTERN, '$1[REDACTED]');
}

export function containsPotentialSecret(text: string): boolean {
  return redactEgressText(text) !== text;
}
