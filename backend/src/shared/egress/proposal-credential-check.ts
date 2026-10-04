const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u;
const RECOGNIZABLE_ACCESS_KEY = /\b(?:AKIA[A-Z0-9]{16}|nvapi-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9_-]{24,})\b/u;
const ASSIGNMENT = /(?<![\w$])(["']?)([A-Za-z_$][\w$]*)\1\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`\r\n]*)`|([^\s,;}]+))/gu;
const CREDENTIAL_NAME = /(?:^|_)(?:api_?key|access_?key(?:_?id)?|access_?token|refresh_?token|client_?secret|secret_?key|private_?key|password|passwd)$/u;
const PLACEHOLDER = /^(?:\[redacted(?:[ _-][^\]]*)?\]|<[^>]+>|(?:your|example|sample|dummy|test|fake|placeholder|replace|change)[ _-]|changeme$|not[_-]?set$)/iu;

/** Favor ordinary generated code; this is a limited credential guard, not a secret scanner. */
export function containsProposalCredential(text: string): boolean {
  if (PRIVATE_KEY_BLOCK.test(text) || RECOGNIZABLE_ACCESS_KEY.test(text)) return true;
  for (const match of text.matchAll(ASSIGNMENT)) {
    const name = (match[2] ?? '').replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase();
    if (!CREDENTIAL_NAME.test(name)) continue;
    const value = match[3] ?? match[4] ?? match[5] ?? match[6] ?? '';
    if (isCredentialLiteral(value, match[6] !== undefined)) return true;
  }
  return false;
}

function isCredentialLiteral(value: string, unquoted: boolean): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 12 || PLACEHOLDER.test(trimmed)) return false;
  if (trimmed.includes('${') || trimmed.includes('[REDACTED')) return false;
  // Expressions and references are common in authentication UI and config examples.
  if (unquoted && (/^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/u.test(trimmed) || /[()[\]]/u.test(trimmed))) return false;
  return /[A-Za-z]/u.test(trimmed) && !/^\s*(?:null|undefined|true|false)\s*$/iu.test(trimmed);
}
