import type { CommandLimits, CommandResult } from '@/modules/ai-runs/domain/command-types';
import { redactCommandOutputText } from '@/shared/egress/redaction';

const MAX_PREVIEW_BYTES = 4 * 1024;
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

export function sanitizeCommandResult(result: CommandResult, limits: CommandLimits): CommandResult {
  const outputBytes = clampNumber(result.outputBytes, 0, limits.maxOutputBytes);
  const outputTruncated = result.outputTruncated || result.outputBytes > limits.maxOutputBytes;
  const termination = result.termination === 'completed' && outputTruncated ? 'output_truncated' : result.termination;
  const preview = typeof result.outputPreview === 'string' ? sanitizePreview(result.outputPreview) : undefined;
  return {
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
    termination,
    durationMs: clampNumber(result.durationMs, 0, limits.wallTimeMs),
    outputBytes,
    outputLineCount: clampNumber(result.outputLineCount, 0, limits.maxOutputBytes + 1),
    outputTruncated,
    outputSha256: result.outputSha256,
    ...(preview === undefined ? {} : { outputPreview: preview })
  };
}

function sanitizePreview(value: string): string {
  const plainText = redactCommandOutputText(value.replace(ANSI_PATTERN, '')).replace(CONTROL_PATTERN, '');
  return truncateUtf8(plainText, MAX_PREVIEW_BYTES);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value;
  }
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

function clampNumber(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.max(minimum, Math.min(Math.floor(value), maximum));
}
