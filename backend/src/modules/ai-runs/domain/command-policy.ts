import { createHash } from 'node:crypto';

import { SandboxCommandValidationError } from '@/modules/ai-runs/domain/command-errors';
import type { CommandClassification, CommandLimits } from '@/modules/ai-runs/domain/command-types';

export const COMMAND_LIMITS: CommandLimits = {
  wallTimeMs: 10_000,
  idleTimeMs: 5_000,
  maxOutputBytes: 32 * 1024,
  maxProcesses: 4,
  memoryBytes: 128 * 1024 * 1024,
  cpuTimeMs: 5_000,
  network: 'denied'
};

const SAFE_COMMANDS = new Set(['cat', 'head', 'ls', 'pwd', 'rg', 'tail']);
const BARE_COMMAND_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const SHELL_PATTERN = /[;&|><`$(){}]/u;
const OPTION_PATTERN = /^-/u;
const ENV_ASSIGNMENT_PATTERN = /(?:^|\s)[a-z_][a-z0-9_]*\s*=/iu;
const SECRET_ASSIGNMENT_PATTERN = /(?:api[_-]?key|access[_-]?(?:key|token)(?:[_-]?id)?|refresh[_-]?token|token|secret(?:[_-]?key)?|password|credential|private[_-]?key|(?:gcp|google)[_-]?service[_-]?account(?:[_-]?key)?|service[_-]?account(?:[_-]?key)?|(?:aws|azure|nvidia)[_-]?(?:access[_-]?)?(?:key|token|secret))\s*[:=]/iu;
const SECRET_IDENTIFIER_PATTERN = /(?:api[_-]?key|access[_-]?(?:key|token)(?:[_-]?id)?|refresh[_-]?token|token|secret(?:[_-]?key)?|password|credential|private[_-]?key|(?:gcp|google)[_-]?service[_-]?account(?:[_-]?key)?|service[_-]?account(?:[_-]?key)?|(?:aws|azure|nvidia)[_-]?(?:access[_-]?)?(?:key|token|secret))/iu;
const ABSOLUTE_PATH_PATTERN = /^(?:[a-z]:[\\/]|[\\/]{1,2})/iu;
const EMBEDDED_ABSOLUTE_PATH_PATTERN = /(?:^|[\s"'=:(])(?:[a-z]:[\\/]|[\\/]{1,2})/iu;
const SECRET_PATH_PATTERN = /(?:^|[\\/])(?:\.env(?:\..*)?|.*(?:secret|credential|token|password|private[_-]?key|id[_-]?rsa).*|node_modules|\.git|.*(?:lock|auth|ci|config))(?:[\\/]|$)/iu;

export interface CommandProposalInput {
  readonly command: unknown;
  readonly args: unknown;
  readonly cwd?: unknown;
  readonly summary?: unknown;
}

export interface NormalizedCommandProposal {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly summary: string;
  readonly classification: CommandClassification;
  readonly blockedReason?: string;
  readonly proposalHash: string;
  readonly limits: CommandLimits;
  readonly createFingerprint: string;
}

export function normalizeCommandProposal(input: CommandProposalInput): NormalizedCommandProposal {
  const command = readCommand(input.command);
  const args = readArguments(input.args);
  const cwd = readCwd(input.cwd);
  const summary = readSummary(input.summary, command);
  const blockedReason = policyBlockReason(command, args, cwd);
  const classification: CommandClassification = blockedReason ? 'blocked' : 'safe';
  const canonical = JSON.stringify({ command, args, cwd, classification, limits: COMMAND_LIMITS });
  const proposalHash = hash(canonical);
  return {
    command,
    args,
    cwd,
    summary,
    classification,
    ...(blockedReason ? { blockedReason } : {}),
    proposalHash,
    limits: COMMAND_LIMITS,
    createFingerprint: hash(JSON.stringify({ proposalHash, summary }))
  };
}

export function summarizeArgument(value: string): string {
  if (isUnsafePath(value) || ENV_ASSIGNMENT_PATTERN.test(value) || SECRET_ASSIGNMENT_PATTERN.test(value) || SECRET_IDENTIFIER_PATTERN.test(value)) {
    return '[redacted path]';
  }
  const bounded = value.length > 64 ? `${value.slice(0, 61)}...` : value;
  return CONTROL_PATTERN.test(bounded) ? '[redacted]' : bounded;
}

export function hashCommandText(value: string): string {
  return hash(value);
}

function readCommand(value: unknown): string {
  if (typeof value !== 'string' || !BARE_COMMAND_PATTERN.test(value)) {
    throw new SandboxCommandValidationError([{ field: 'command', message: 'Use one bare command name.' }]);
  }
  return value;
}

function readArguments(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 32 || value.some((item) => typeof item !== 'string')) {
    throw new SandboxCommandValidationError([{ field: 'args', message: 'Use at most 32 string arguments.' }]);
  }
  const args = value.filter((item): item is string => typeof item === 'string');
  if (args.some((item) => Buffer.byteLength(item, 'utf8') > 256) || Buffer.byteLength(args.join('\u0000'), 'utf8') > 4_096) {
    throw new SandboxCommandValidationError([{ field: 'args', message: 'Command arguments exceed the safe bound.' }]);
  }
  if (args.some((item) => CONTROL_PATTERN.test(item))) {
    throw new SandboxCommandValidationError([{ field: 'args', message: 'Control characters are not allowed.' }]);
  }
  return args;
}

function readCwd(value: unknown): string {
  if (value === undefined) {
    return '.';
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048 || CONTROL_PATTERN.test(value)) {
    throw new SandboxCommandValidationError([{ field: 'cwd', message: 'cwd must be a bounded relative path.' }]);
  }
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '') || '.';
  return isUnsafePath(normalized) ? '[redacted path]' : normalized;
}

function readSummary(value: unknown, command: string): string {
  if (value === undefined) {
    return `Run ${command} in the private staging area.`;
  }
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 160 || CONTROL_PATTERN.test(value)) {
    throw new SandboxCommandValidationError([{ field: 'summary', message: 'Summary must be bounded plain text.' }]);
  }
  const summary = value.trim();
  if (ENV_ASSIGNMENT_PATTERN.test(summary) || SECRET_ASSIGNMENT_PATTERN.test(summary) || SECRET_IDENTIFIER_PATTERN.test(summary) || isUnsafePath(summary)) {
    return 'The server redacted sensitive command summary details.';
  }
  return summary;
}

function policyBlockReason(command: string, args: readonly string[], cwd: string): string | undefined {
  if (!SAFE_COMMANDS.has(command)) {
    return 'command_not_allowlisted';
  }
  if (isUnsafePath(cwd) || cwd === '[redacted path]') {
    return 'cwd_not_staging_relative';
  }
  if (args.some((argument) => SHELL_PATTERN.test(argument) || OPTION_PATTERN.test(argument) || ENV_ASSIGNMENT_PATTERN.test(argument) || SECRET_ASSIGNMENT_PATTERN.test(argument) || SECRET_IDENTIFIER_PATTERN.test(argument))) {
    return 'shell_composition_denied';
  }
  if (args.some(isUnsafePath)) {
    return 'path_or_secret_denied';
  }
  return undefined;
}

function isUnsafePath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return ABSOLUTE_PATH_PATTERN.test(normalized) || EMBEDDED_ABSOLUTE_PATH_PATTERN.test(normalized) || normalized.split('/').includes('..') || SECRET_PATH_PATTERN.test(normalized);
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
