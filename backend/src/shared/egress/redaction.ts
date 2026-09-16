const SECRET_VALUE_PATTERN = /((?:api[_-]?key|access[_-]?(?:key|token)(?:[_-]?id)?|refresh[_-]?token|password|passwd|secret(?:[_-]?key)?|credential|token|private[_-]?key|(?:gcp|google)[_-]?service[_-]?account(?:[_-]?key)?|service[_-]?account(?:[_-]?key)?|(?:aws|azure|nvidia)[_-]?(?:access[_-]?)?(?:key|token|secret))\s*[:=]\s*["']?)([^\s"'`,;}]+)/giu;
const ENV_VALUE_PATTERN = /((?:^|\s)[A-Z_][A-Z0-9_]*\s*=\s*["']?)([^\s"'`,;}]+)/gu;
const GENERIC_ENV_VALUE_PATTERN = /((?:^|\s)[A-Za-z_][A-Za-z0-9_]*\s*=\s*["']?)([^\s"'`,;}]+)/gu;
const ABSOLUTE_PATH_PATTERN = /(?:[a-z]:[\\/]|\/{1,2})[^\s"'`,;}]+/giu;
const PRIVATE_KEY_PATTERN = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu;

export function redactEgressText(text: string): string {
  return text.replace(PRIVATE_KEY_PATTERN, (privateKey) => {
    const lineBreaks = privateKey.match(/\r\n|\r|\n/gu)?.join('') ?? '';
    return `[REDACTED PRIVATE KEY]${lineBreaks}`;
  }).replace(SECRET_VALUE_PATTERN, '$1[REDACTED]').replace(ENV_VALUE_PATTERN, '$1[REDACTED]').replace(ABSOLUTE_PATH_PATTERN, '[REDACTED_PATH]');
}

export function redactCommandOutputText(text: string): string {
  return redactEgressText(text).replace(GENERIC_ENV_VALUE_PATTERN, '$1[REDACTED]');
}

export function containsPotentialSecret(text: string): boolean {
  return redactEgressText(text) !== text;
}
