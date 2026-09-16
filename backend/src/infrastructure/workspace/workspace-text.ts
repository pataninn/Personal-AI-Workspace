import { WorkspaceBinaryFileError, WorkspaceLimitExceededError } from '@/modules/files/domain/workspace-errors';
import { redactEgressText } from '@/shared/egress/redaction';

export interface BoundedText {
  readonly text: string;
  readonly sizeBytes: number;
  readonly truncated: boolean;
}

export function decodeUtf8(buffer: Buffer): string {
  if (hasDisallowedControlBytes(buffer)) {
    throw new WorkspaceBinaryFileError();
  }
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new WorkspaceBinaryFileError();
  }
  const withoutBom = decoded.startsWith('\uFEFF') ? decoded.slice(1) : decoded;
  if (hasDisallowedControlCharacters(withoutBom)) {
    throw new WorkspaceBinaryFileError();
  }
  return withoutBom;
}

export function boundText(
  text: string,
  sizeBytes: number,
  maxLines: number,
  maxOutputBytes: number
): BoundedText {
  const redacted = redactSensitiveText(text);
  const lines = redacted.split(/\r\n|\r|\n/u);
  const lineLimited = lines.length > maxLines;
  const lineText = lines.slice(0, maxLines).join('\n');
  const byteLimited = Buffer.byteLength(lineText, 'utf8') > maxOutputBytes;
  const output = byteLimited ? truncateUtf8(lineText, maxOutputBytes) : lineText;
  return { text: output, sizeBytes, truncated: lineLimited || byteLimited };
}

export function assertQueryLength(query: string, maxLength: number): void {
  if (query.length === 0 || Array.from(query).length > maxLength) {
    throw new WorkspaceLimitExceededError('The workspace search query is empty or too long.');
  }
}

export function redactSensitiveText(text: string): string {
  return redactEgressText(text);
}

function hasDisallowedControlBytes(buffer: Buffer): boolean {
  return Array.from(buffer).some((byte) => {
    if (byte === 9 || byte === 10 || byte === 11 || byte === 12 || byte === 13) {
      return false;
    }
    return byte <= 31 || byte === 127;
  });
}

function hasDisallowedControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)) {
      if (codePoint >= 9 && codePoint <= 13) {
        continue;
      }
      return true;
    }
  }
  return false;
}

export function truncateUtf8(value: string, maxBytes: number): string {
  let output = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    output += character;
    bytes += characterBytes;
  }
  return output;
}
