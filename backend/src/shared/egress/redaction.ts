const SECRET_VALUE_PATTERN = /((?:api[_-]?key|access[_-]?(?:key|token)(?:[_-]?id)?|refresh[_-]?token|password|passwd|secret(?:[_-]?key)?|credential|token|private[_-]?key|(?:gcp|google)[_-]?service[_-]?account(?:[_-]?key)?|service[_-]?account(?:[_-]?key)?|(?:aws|azure|nvidia)[_-]?(?:access[_-]?)?(?:key|token|secret))\s*[:=]\s*["']?)([^\s"'`,;}]+)/giu;
const ENV_VALUE_PATTERN = /((?:^|\s)[A-Z_][A-Z0-9_]*\s*=\s*["']?)([^\s"'`,;}]+)/gu;
const GENERIC_ENV_VALUE_PATTERN = /((?:^|\s)[A-Za-z_][A-Za-z0-9_]*\s*=\s*["']?)([^\s"'`,;}]+)/gu;
const ABSOLUTE_PATH_PATTERN = /(?<![A-Za-z0-9])(?:[a-z]:[\\/]|file:\/{2,3})[^\s"'`,;}<>]+|(?<![A-Za-z0-9._<:*\/-])\/{1,2}(?![\s/*])[^\s"'`,;}<>]+/giu;
const PRIVATE_KEY_PATTERN = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu;
const CREDENTIAL_ASSIGNMENT_PATTERN = /(?:api[_-]?key|access[_-]?(?:key|token)(?:[_-]?id)?|refresh[_-]?token|password|passwd|secret(?:[_-]?key)?|credential|token|private[_-]?key|(?:gcp|google)[_-]?service[_-]?account(?:[_-]?key)?|service[_-]?account(?:[_-]?key)?|(?:aws|azure|nvidia)[_-]?(?:access[_-]?)?(?:key|token|secret))\s*[:=]\s*["']?[^\s"'`,;}]+/iu;
const ENV_ASSIGNMENT_PATTERN = /(?:^|\r?\n)\s*(?:export\s+)?[A-Z_][A-Z0-9_]*\s*=\s*["']?[^\s"'`,;}]+/u;

export function redactEgressText(text: string): string {
  return text.replace(PRIVATE_KEY_PATTERN, (privateKey) => {
    const lineBreaks = privateKey.match(/\r\n|\r|\n/gu)?.join('') ?? '';
    return `[REDACTED PRIVATE KEY]${lineBreaks}`;
  }).replace(SECRET_VALUE_PATTERN, '$1[REDACTED]').replace(ENV_VALUE_PATTERN, '$1[REDACTED]').replace(ABSOLUTE_PATH_PATTERN, redactAbsolutePath);
}

function redactAbsolutePath(value: string, offset: number, source: string): string {
  const prefix = source.slice(Math.max(0, offset - 512), offset);
  if (value.startsWith('/') && isWebResourceReference(prefix)) return value;
  // Preserve a JavaScript comment delimiter while hiding any path inside it.
  return value.startsWith('//') ? '//[REDACTED_PATH]' : '[REDACTED_PATH]';
}

function isWebResourceReference(prefix: string): boolean {
  return /<[a-z][^<>]*\b(?:href|src|action|poster|cite|data|srcset)\s*=\s*["']?$/iu.test(prefix)
    || /\b(?:url|fetch)\(\s*["']?$/iu.test(prefix);
}

export function redactCommandOutputText(text: string): string {
  return redactEgressText(text).replace(GENERIC_ENV_VALUE_PATTERN, '$1[REDACTED]');
}

export function containsPotentialSecret(text: string): boolean {
  return redactEgressText(text) !== text;
}

/** Detect credential-like values in untrusted model proposals before persistence. */
export function containsCredentialLikeValue(text: string): boolean {
  if (PRIVATE_KEY_PATTERN.test(text)) {
    PRIVATE_KEY_PATTERN.lastIndex = 0;
    return true;
  }
  PRIVATE_KEY_PATTERN.lastIndex = 0;
  return CREDENTIAL_ASSIGNMENT_PATTERN.test(text) || ENV_ASSIGNMENT_PATTERN.test(text);
}
