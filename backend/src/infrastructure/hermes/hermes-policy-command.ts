import { AiRunRuntimeUnavailableError } from '@/modules/ai-runs/domain/ai-run-errors';
import { COMMAND_LIMITS, normalizePolicyHermesPermission } from '@/modules/ai-runs/domain/command-policy';
import type { CommandResult } from '@/modules/ai-runs/domain/command-types';
import type { RuntimeCommandInput, RuntimeCommandProposalInput, RuntimeRunInput } from '@/modules/ai-runs/repositories/agent-runtime';
import { hash, type SnapshotFile } from '@/infrastructure/hermes/approved-context-reader';
import { isRecord } from '@/infrastructure/hermes/hermes-bridge-client';
import { redactEgressText } from '@/shared/egress/redaction';

export const POLICY_COMMAND_VERSION = 'bounded-read-v1';
export const POLICY_COMMAND_PROFILE_HASH = hash(JSON.stringify({ version: POLICY_COMMAND_VERSION, limits: COMMAND_LIMITS }));

interface PendingCommand {
  readonly requestId: string;
  readonly command: string;
  readonly commandHash: string;
  commandId?: string;
  dispatched?: boolean;
  released?: boolean;
  result?: CommandResult;
}

/** Keeps private bridge permissions one-shot and holds output until the application releases it. */
export class HermesPolicyCommand {
  private readonly pending = new Map<string, PendingCommand>();

  public constructor(private readonly options: {
    readonly run: RuntimeRunInput;
    readonly call: (operation: string, payload: unknown) => Promise<Record<string, unknown>>;
    readonly cancelled: () => boolean;
  }) {}

  public propose(event: Record<string, unknown>): RuntimeCommandProposalInput {
    const params = event.params;
    if (!isRecord(params) || typeof params.command !== 'string' || typeof params.requestId !== 'string'
      || !/^[0-9a-f]{32}$/u.test(params.requestId) || event.id !== params.requestId || this.pending.has(params.requestId)) throw unavailable();
    const normalized = normalizePolicyHermesPermission({ command: 'hermes-terminal', args: [params.command] },
      this.options.run.manifest.files.map((file) => file.relativePath), this.options.run.manifest.manifestHash);
    if (normalized.classification !== 'safe' || params.commandHash !== normalized.proposalHash) throw unavailable();
    const pending: PendingCommand = { requestId: params.requestId, command: params.command, commandHash: normalized.proposalHash };
    this.assertBinding(params, pending, false);
    this.pending.set(pending.requestId, pending);
    return { runId: this.options.run.runId, commandId: pending.requestId, command: 'hermes-terminal', args: [pending.command], cwd: '.' };
  }

  public bind(input: RuntimeCommandProposalInput): void {
    const pending = [...this.pending.values()].find((item) => !item.commandId && item.command === input.args[0]);
    if (!pending || input.command !== 'hermes-terminal' || input.args.length !== 1 || input.cwd !== '.') throw unavailable();
    pending.commandId = input.commandId;
  }

  public boundCommand(requestId: string): string | undefined {
    return this.pending.get(requestId)?.commandId;
  }

  public receive(event: Record<string, unknown>): void {
    const params = event.params;
    if (!isRecord(params) || typeof params.requestId !== 'string' || event.id !== params.requestId) throw unavailable();
    const pending = this.pending.get(params.requestId);
    if (!pending || !pending.dispatched || pending.result || this.options.cancelled()) throw unavailable();
    this.assertBinding(params, pending, true);
    pending.result = parseResult(params.result);
  }

  public async execute(input: RuntimeCommandInput): Promise<CommandResult> {
    const pending = this.requireCommand(input.commandId);
    if (pending.dispatched || input.command !== 'hermes-terminal' || input.args.length !== 1 || input.args[0] !== pending.command
      || input.cwd !== '.' || JSON.stringify(input.limits) !== JSON.stringify(COMMAND_LIMITS)) throw unavailable();
    pending.dispatched = true;
    const response = await this.options.call('policy-command-permission', this.binding(pending));
    if (response.accepted !== true) throw unavailable();
    const deadline = Date.now() + COMMAND_LIMITS.wallTimeMs + 5000;
    while (!pending.result && !this.options.cancelled() && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 20));
    if (!pending.result || this.options.cancelled()) throw unavailable();
    return pending.result;
  }

  public async complete(commandId: string): Promise<void> {
    const pending = this.requireCommand(commandId);
    if (!pending.result || pending.released) throw unavailable();
    // Consume before IO: an uncertain acknowledgment must never be retried.
    pending.released = true;
    const response = await this.options.call('policy-command-result-permission', this.binding(pending));
    if (response.accepted !== true) throw unavailable();
  }

  private requireCommand(commandId: string): PendingCommand {
    const pending = [...this.pending.values()].find((item) => item.commandId === commandId);
    if (!pending || this.options.cancelled()) throw unavailable();
    return pending;
  }

  private binding(pending: PendingCommand): Record<string, unknown> {
    return { commandId: pending.commandId, requestId: pending.requestId, commandHash: pending.commandHash,
      profileVersion: POLICY_COMMAND_VERSION, profileHash: POLICY_COMMAND_PROFILE_HASH, manifestHash: this.options.run.manifest.manifestHash };
  }

  private assertBinding(params: Record<string, unknown>, pending: PendingCommand, commandRequired: boolean): void {
    if (params.runId !== this.options.run.runId || params.profileVersion !== POLICY_COMMAND_VERSION
      || params.profileHash !== POLICY_COMMAND_PROFILE_HASH || params.manifestHash !== this.options.run.manifest.manifestHash
      || params.commandHash !== pending.commandHash || (commandRequired && params.commandId !== pending.commandId)) throw unavailable();
  }
}

export function policyCommandReceiptAvailable(value: unknown): boolean {
  return isRecord(value) && value.supported === true && value.profileVersion === POLICY_COMMAND_VERSION
    && value.profileHash === POLICY_COMMAND_PROFILE_HASH && isRecord(value.limits)
    && Object.keys(value.limits).length === Object.keys(COMMAND_LIMITS).length
    && Object.entries(COMMAND_LIMITS).every(([key, limit]) => isRecord(value.limits) && value.limits[key] === limit)
    && Array.isArray(value.unavailableReasons) && value.unavailableReasons.length === 0;
}

export function policySnapshotHash(files: readonly SnapshotFile[]): string {
  if (files.some((file) => !/^[\x21-\x7e]+$/u.test(file.path))) throw unavailable();
  return hash(JSON.stringify(files.map(({ path, sha256 }) => ({ path, sha256 })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)));
}

function parseResult(value: unknown): CommandResult {
  if (!isRecord(value) || typeof value.stdout !== 'string' || typeof value.stderr !== 'string'
    || typeof value.timedOut !== 'boolean' || typeof value.outputTruncated !== 'boolean'
    || typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0
    || value.durationMs > COMMAND_LIMITS.wallTimeMs + 2000
    || !(value.exitCode === null || (typeof value.exitCode === 'number' && Number.isInteger(value.exitCode)))) throw unavailable();
  const raw = value.stdout + value.stderr;
  if (Buffer.byteLength(raw, 'utf8') > COMMAND_LIMITS.maxOutputBytes) throw unavailable();
  const text = redactEgressText(raw);
  return { exitCode: value.exitCode, termination: value.timedOut ? 'timed_out' : value.outputTruncated ? 'output_truncated' : value.exitCode === 0 ? 'completed' : 'failed',
    durationMs: value.durationMs, outputBytes: Buffer.byteLength(raw), outputLineCount: raw ? raw.split('\n').length : 0,
    outputTruncated: value.outputTruncated, outputSha256: hash(raw), outputPreview: Buffer.from(text).subarray(0, 4096).toString('utf8') };
}

function unavailable(): AiRunRuntimeUnavailableError {
  return new AiRunRuntimeUnavailableError();
}

/** Retains the bounded historical result projection for non-policy runtime records. */
export function legacyHermesCommandResult(update: Record<string, unknown>): CommandResult {
  let raw: unknown = update.rawOutput;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw) as unknown; } catch { /* ACP can also return plain text. */ } }
  const data = isRecord(raw) ? raw : {};
  const text = redactEgressText(typeof data.output === 'string' ? data.output : typeof update.rawOutput === 'string' ? update.rawOutput : 'Hermes confirmed tool completion.');
  const preview = Buffer.from(text).subarray(0, 4096).toString('utf8');
  const failed = update.status === 'failed';
  return { exitCode: typeof data.exit_code === 'number' ? data.exit_code : null, termination: failed ? 'failed' : 'completed', durationMs: 0, outputBytes: Buffer.byteLength(text), outputLineCount: text.split('\n').length, outputTruncated: Buffer.byteLength(text) > 4096, outputSha256: hash(text), outputPreview: preview };
}
