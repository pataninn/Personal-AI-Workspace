import { describe, expect, it } from 'vitest';

import { ApiClientError } from '@/shared/api';
import { normalizeSandboxCommand, normalizeSandboxCommandList } from '@/entities/ai-run/api/sandbox-command-api';

const RUN_ID = '77777777-7777-4777-8777-000000000001';
const COMMAND_ID = '88888888-8888-4888-8888-000000000001';
const HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const limits = {
  wallTimeMs: 10_000,
  idleTimeMs: 5_000,
  maxOutputBytes: 32_768,
  maxProcesses: 4,
  memoryBytes: 134_217_728,
  cpuTimeMs: 5_000,
  network: 'denied'
};

describe('sandbox command API normalizers', () => {
  it('normalizes a safe fake proposal without exposing a raw shell contract', () => {
    const command = normalizeSandboxCommand({
      commandId: COMMAND_ID,
      runId: RUN_ID,
      proposalHash: HASH,
      command: 'rg',
      summary: 'Search the staged source tree',
      argumentCount: 2,
      argumentSummaries: ['TODO', 'src'],
      cwd: '.',
      classification: 'safe',
      decision: 'pending',
      status: 'awaiting_approval',
      limits,
      safeMessage: 'Review this command before it runs.'
    });

    expect(command).toMatchObject({ commandId: COMMAND_ID, command: 'rg', argumentSummaries: ['TODO', 'src'], status: 'awaiting_approval' });
    expect(command).not.toHaveProperty('args');
  });

  it('keeps bounded output as text and preserves truncation metadata', () => {
    const command = normalizeSandboxCommand({
      commandId: COMMAND_ID,
      runId: RUN_ID,
      proposalHash: HASH,
      command: 'rg',
      argumentSummaries: [],
      cwd: '.',
      classification: 'safe',
      decision: 'approved',
      status: 'output_truncated',
      limits,
      result: {
        exitCode: 0,
        termination: 'output_truncated',
        durationMs: 10,
        outputBytes: 32_768,
        outputLineCount: 3,
        outputTruncated: true,
        outputSha256: HASH,
        outputPreview: '<not markup>\u001b[31mplain text'
      }
    });

    expect(command.result?.outputPreview).toContain('<not markup>');
    expect(command.result?.outputPreview).not.toContain('\u001b');
    expect(command.result?.outputTruncated).toBe(true);
  });

  it('normalizes the private policy authorization provenance without changing the decision request contract', () => {
    const command = normalizeSandboxCommand({
      commandId: COMMAND_ID,
      runId: RUN_ID,
      proposalHash: HASH,
      command: 'hermes-terminal',
      summary: 'Read selected workspace files',
      argumentCount: 1,
      argumentSummaries: ['pwd'],
      cwd: '.',
      classification: 'safe',
      decision: 'policy_authorized',
      status: 'running',
      limits,
      safeMessage: 'The stored workspace policy authorized this bounded command.'
    });

    expect(command).toMatchObject({ decision: 'policy_authorized', status: 'running' });
  });

  it('redacts generic assignments, service-account values, and embedded paths', () => {
    const command = normalizeSandboxCommand({
      commandId: COMMAND_ID,
      runId: RUN_ID,
      proposalHash: HASH,
      command: 'rg',
      argumentSummaries: ['FOO=bar', 'prefix C:\\Users\\person\\workspace\\src'],
      cwd: 'prefix C:\\Users\\person\\workspace\\src',
      summary: 'GCP_SERVICE_ACCOUNT_KEY=leak',
      classification: 'blocked',
      decision: 'not_applicable',
      status: 'blocked',
      limits,
      result: {
        exitCode: null,
        termination: 'failed',
        durationMs: 1,
        outputBytes: 32,
        outputLineCount: 1,
        outputTruncated: false,
        outputSha256: HASH,
        outputPreview: 'GCP_SERVICE_ACCOUNT_KEY=leak foo=bar Foo = "mixed-value" prefix C:\\Users\\person\\workspace\\src'
      }
    });

    expect(command.argumentSummaries).toEqual(['[redacted]', '[redacted]']);
    expect(command.summary).not.toContain('leak');
    expect(command.cwd).not.toContain('C:\\Users');
    expect(command.result?.outputPreview).not.toContain('leak');
    expect(command.result?.outputPreview).not.toContain('bar');
    expect(command.result?.outputPreview).not.toContain('mixed-value');
    expect(command.result?.outputPreview).not.toContain('C:\\Users');
  });

  it('rejects an invalid hash or network policy instead of inventing a command', () => {
    expect(() => normalizeSandboxCommand({ commandId: COMMAND_ID, runId: RUN_ID, proposalHash: 'not-a-hash' })).toThrow(ApiClientError);
    expect(() => normalizeSandboxCommandList({ commands: [{ commandId: COMMAND_ID, runId: RUN_ID, proposalHash: HASH, command: 'rg', classification: 'safe', decision: 'pending', status: 'awaiting_approval', limits: { ...limits, network: 'allowed' } }] })).toThrow(ApiClientError);
  });
});
