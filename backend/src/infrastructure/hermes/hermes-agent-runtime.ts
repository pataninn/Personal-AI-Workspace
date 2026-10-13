import { randomBytes } from 'node:crypto';

import type { IAgentRuntime, RuntimeInferenceEvent, RuntimeRunInput, RuntimeCommandInput, RuntimeCommandProposalInput, RuntimeRunCancellationResult } from '@/modules/ai-runs/repositories/agent-runtime';
import type { CommandResult } from '@/modules/ai-runs/domain/command-types';
import { AiRunRuntimeUnavailableError } from '@/modules/ai-runs/domain/ai-run-errors';
import { ApprovedContextReader, hash } from '@/infrastructure/hermes/approved-context-reader';
import { HermesBridgeClient, isRecord } from '@/infrastructure/hermes/hermes-bridge-client';
import { collectHermesChanges } from '@/infrastructure/hermes/hermes-file-changes';
import { redactEgressText } from '@/shared/egress/redaction';
import type { HermesProjectTaskTools } from '@/infrastructure/hermes/hermes-project-task-tools';

interface Permission {
  readonly identity: string;
  readonly command: string;
  commandId?: string;
  decided?: boolean;
  toolId?: string;
  result?: CommandResult;
}

interface ActiveRun {
  readonly input: RuntimeRunInput;
  readonly taskResults: Map<string, Record<string, unknown>>;
  readonly capability: string;
  readonly permissions: Permission[];
  readonly commandEvents: RuntimeInferenceEvent[];
  cancelled: boolean;
  cursor: number;
  cleaned?: boolean;
  responseReceived?: boolean;
  cancellation?: Promise<RuntimeRunCancellationResult>;
  startup?: Promise<Record<string, unknown>>;
  stage?: string;
  readonly tools: Map<string, { readonly command?: string; readonly title: string; result?: CommandResult }>;
}

interface HermesRuntimeOptions {
  readonly taskTools?: HermesProjectTaskTools;
  readonly providerProfile: string;
  readonly model: string;
  readonly endpoint: string;
  readonly diagnose?: (detail: { readonly runId: string; readonly category: string; readonly stage: string; readonly trace: string }) => void;
}

/** Runs real Hermes on a disposable copy and exports validated proposals to Express. */
export class HermesAgentRuntime implements IAgentRuntime {
  private readonly runs = new Map<string, ActiveRun>();
  public constructor(private readonly bridge: HermesBridgeClient, private readonly context: ApprovedContextReader, private readonly options: HermesRuntimeOptions) {}

  public async checkAvailability(): Promise<void> {
    const { providerProfile, model, endpoint } = this.options;
    const receipt = await this.bridge.call('probe', undefined, undefined, { providerProfile, model, endpoint });
    if (receipt.ready !== true || !isRecord(receipt.profile) || receipt.profile.hermesVersion !== '0.20.6'
      || receipt.profile.providerProfile !== this.options.providerProfile || receipt.profile.model !== this.options.model
      || receipt.profile.endpoint !== this.options.endpoint) throw new AiRunRuntimeUnavailableError();
  }

  public async prepareDirectRun(): Promise<{ readonly kind: 'hermes'; readonly sandboxReady: true }> {
    await this.checkAvailability();
    return { kind: 'hermes', sandboxReady: true };
  }

  public async create(): Promise<{ readonly kind: 'hermes'; readonly sandboxReady: true }> { return this.prepareDirectRun(); }

  public async *startRun(input: RuntimeRunInput): AsyncIterable<RuntimeInferenceEvent> {
    const active: ActiveRun = { input, taskResults: new Map(), capability: randomBytes(32).toString('base64url'), permissions: [], commandEvents: [], tools: new Map(), cancelled: false, cursor: 0 };
    this.runs.set(input.runId, active);
    try {
      const snapshot = await this.context.read(input);
      yield { type: 'started' };
      if (active.cancelled) { yield { type: 'cancelled' }; return; }
      active.startup = this.call(input.runId, 'create', { files: snapshot.files, prompt: snapshot.prompt, model: input.manifest.model, providerProfile: input.manifest.providerProfile, endpoint: this.options.endpoint });
      await active.startup;
      yield* this.follow(input.runId);
      if (active.cancelled) {
        await active.cancellation;
        yield active.cleaned ? { type: 'cancelled' } : { type: 'needs_manual_review', message: 'Hermes shutdown could not be confirmed.' };
        return;
      }
      const status = await this.call(input.runId, 'poll', { cursor: active.cursor });
      if (status.status !== 'completed') return;
      const exported = await this.call(input.runId, 'files');
      const changes = collectHermesChanges(exported.files, snapshot.files);
      await this.call(input.runId, 'delete');
      active.cleaned = true;
      if (changes.length > 0) yield { type: 'changes.proposed', changes };
      yield { type: 'completed', text: '' };
    } catch (error: unknown) {
      this.options.diagnose?.({ runId: input.runId, category: error instanceof Error ? error.name : 'unknown', stage: active.stage ?? 'preparing', trace: error instanceof Error ? (error.stack ?? '').split('\n').filter((line) => /^\s+at /u.test(line)).slice(0, 4).join('\n') : '' });
      if (active.cancelled) {
        await active.cancellation;
        yield active.cleaned ? { type: 'cancelled' } : { type: 'needs_manual_review', message: 'Hermes shutdown could not be confirmed.' };
      }
      else yield { type: 'needs_manual_review', message: 'The isolated Hermes run could not be confirmed. No generated changes were applied.' };
    }
  }

  private async *follow(runId: string): AsyncIterable<RuntimeInferenceEvent> {
    const active = this.requireRun(runId);
    const deadline = Date.now() + 15 * 60_000;
    let providerStarted = false;
    while (!active.cancelled && Date.now() < deadline) {
      const reply = await this.call(runId, 'poll', { cursor: active.cursor });
      if (reply.status === 'running' && !providerStarted) { providerStarted = true; yield { type: 'provider.request_started' }; }
      for (const event of active.commandEvents.splice(0)) yield event;
      if (!Array.isArray(reply.events)) throw new AiRunRuntimeUnavailableError();
      for (const value of reply.events) {
        if (!isRecord(value) || typeof value.sequence !== 'number' || value.sequence <= active.cursor) throw new AiRunRuntimeUnavailableError();
        active.cursor = value.sequence;
        if (value.type === 'project-task-request' && typeof value.id === 'string' && isRecord(value.params)) {
          yield* this.handleTaskRequest(runId, value.id, value.params);
          continue;
        }
        active.stage = value.type === 'permission' ? 'command-permission' : 'event-stream';
        yield* this.projectBridgeEvent(runId, value);
      }
      // Completion can precede delivery of the last bounded event pages.
      if (reply.status === 'completed' && reply.hasMore !== true) return;
      if (reply.status === 'failed' || reply.status === 'cancelled') throw new AiRunRuntimeUnavailableError();
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
    }
    if (!active.cancelled) throw new AiRunRuntimeUnavailableError();
  }

  private *projectBridgeEvent(runId: string, event: Record<string, unknown>): Iterable<RuntimeInferenceEvent> {
    if (event.type === 'permission' && typeof event.id === 'string' && isRecord(event.params)) {
      const tool = event.params.toolCall;
      if (!isRecord(tool) || !isRecord(tool.rawInput) || typeof tool.rawInput.command !== 'string') throw new AiRunRuntimeUnavailableError();
      const command = tool.rawInput.command;
      const active = this.requireRun(runId);
      const matchingTool = [...active.tools.entries()].reverse().find(([, item]) => item.command === command && !item.result);
      active.permissions.push({ identity: event.id, command, ...(matchingTool ? { toolId: matchingTool[0] } : {}) });
      yield { type: 'tool.proposed', proposal: { runId, commandId: event.id, command: 'hermes-terminal', args: [command], cwd: '.' } };
      const permission = this.requireRun(runId).permissions.find((item) => item.identity === event.id);
      if (permission?.commandId) yield { type: 'approval.required', commandId: permission.commandId };
      return;
    }
    const update = event.update;
    if (!isRecord(update)) return;
    if (update.sessionUpdate === 'agent_message_chunk' && isRecord(update.content) && typeof update.content.text === 'string') {
      const active = this.requireRun(runId);
      if (!active.responseReceived) { active.responseReceived = true; yield { type: 'provider.response_received' }; }
      const text = redactEgressText(update.content.text);
      for (let offset = 0; offset < text.length; offset += 256) yield { type: 'assistant.delta', text: text.slice(offset, offset + 256) };
    }
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const active = this.requireRun(runId);
      const toolId = String(update.toolCallId ?? '');
      const old = active.tools.get(toolId);
      const title = redactEgressText(String(update.title ?? old?.title ?? 'Hermes tool'));
      const command = isRecord(update.rawInput) && typeof update.rawInput.command === 'string' ? update.rawInput.command : old?.command ?? (title.startsWith('terminal: ') ? title.slice(10) : undefined);
      const item = { title, ...(command ? { command } : {}), ...(old?.result ? { result: old.result } : {}) };
      if (command && ['completed', 'failed'].includes(String(update.status))) {
        item.result = commandResult(update);
        for (const permission of active.permissions) if (permission.toolId === toolId) permission.result = item.result;
      }
      active.tools.set(toolId, item);
      yield { type: 'tool.progress', toolId, title, status: String(update.status ?? 'running') };
    }
  }

  private async *handleTaskRequest(runId: string, requestId: string, params: Record<string, unknown>): AsyncIterable<RuntimeInferenceEvent> {
    const active = this.requireRun(runId);
    let result = active.taskResults.get(requestId);
    if (!result) {
      result = active.cancelled ? { error: 'The run was cancelled. No task change was made.' }
        : await this.options.taskTools?.execute({ run: active.input, requestId, name: params.name, args: params.args }) ?? { error: 'Project task tools are unavailable.' };
      active.taskResults.set(requestId, result);
    }
    await this.call(runId, 'project-task-result', { requestId, result });
    yield { type: 'tool.progress', toolId: `project-task-${requestId}`, title: result.saved === true ? 'Project task saved' : result.error ? 'Project task change failed' : 'Project tasks loaded', status: result.error ? 'failed' : 'completed' };
  }

  public async proposeCommand(input: RuntimeCommandProposalInput): Promise<void> {
    const permission = this.requireRun(input.runId).permissions.find((item) => !item.commandId && item.command === input.args[0]);
    if (!permission) throw new AiRunRuntimeUnavailableError();
    permission.commandId = input.commandId;
  }

  public async decideCommand(input: { readonly runId: string; readonly commandId: string; readonly approved: boolean }): Promise<void> {
    const active = this.requireRun(input.runId);
    const permission = active.permissions.find((item) => item.commandId === input.commandId);
    if (!permission || permission.decided || active.cancelled) throw new AiRunRuntimeUnavailableError();
    await this.call(input.runId, 'permission', { permissionId: permission.identity, approved: input.approved });
    permission.decided = true;
    active.commandEvents.push({ type: 'tool.started', commandId: input.commandId });
  }

  public async executeCommand(input: RuntimeCommandInput): Promise<CommandResult> {
    const start = Date.now();
    const active = this.requireRun(input.runId);
    const permission = active.permissions.find((item) => item.commandId === input.commandId);
    if (!permission?.toolId) throw new AiRunRuntimeUnavailableError();
    await this.decideCommand({ runId: input.runId, commandId: input.commandId, approved: true });
    while (!permission.result && !active.cancelled && Date.now() - start < 90_000) await new Promise<void>((resolve) => setTimeout(resolve, 100));
    if (!permission.result) throw new Error('Hermes command completion could not be confirmed');
    return { ...permission.result, durationMs: Date.now() - start };
  }

  public async cancelCommand(input: { readonly runId: string; readonly commandId: string }): Promise<void> {
    const result = await this.cancelRun(input);
    if (result.outcome !== 'confirmed') throw new AiRunRuntimeUnavailableError();
  }

  public async cancelRun(input: { readonly runId: string }): Promise<RuntimeRunCancellationResult> {
    const active = this.runs.get(input.runId);
    if (!active) return { outcome: 'unknown' };
    if (active.cancellation) return active.cancellation;
    active.cancelled = true;
    if (active.cleaned || !active.startup) { active.cleaned = true; return { outcome: 'confirmed' }; }
    active.cancellation = active.startup.catch(() => undefined).then(() => this.call(input.runId, 'cancel')).then(() => { active.cleaned = true; return { outcome: 'confirmed' as const }; }).catch(() => ({ outcome: 'unknown' as const }));
    return active.cancellation;
  }

  public async destroy(runId: string): Promise<void> {
    const active = this.runs.get(runId);
    if (!active) return;
    await active.cancellation;
    if (!active.cleaned) await this.call(runId, 'delete');
    this.runs.delete(runId);
  }

  private requireRun(runId: string): ActiveRun {
    const run = this.runs.get(runId);
    if (!run) throw new AiRunRuntimeUnavailableError();
    return run;
  }

  private call(runId: string, operation: string, payload: unknown = {}): Promise<Record<string, unknown>> {
    this.requireRun(runId).stage = operation;
    return this.bridge.call(operation, runId, this.requireRun(runId).capability, payload);
  }
}

function commandResult(update: Record<string, unknown>): CommandResult {
  let raw: unknown = update.rawOutput;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw) as unknown; } catch { /* The ACP result can also be plain text. */ } }
  const data = isRecord(raw) ? raw : {};
  const text = redactEgressText(typeof data.output === 'string' ? data.output : typeof update.rawOutput === 'string' ? update.rawOutput : 'Hermes confirmed tool completion.');
  const preview = Buffer.from(text).subarray(0, 4096).toString('utf8');
  const failed = update.status === 'failed';
  return { exitCode: typeof data.exit_code === 'number' ? data.exit_code : null, termination: failed ? 'failed' : 'completed', durationMs: 0, outputBytes: Buffer.byteLength(text), outputLineCount: text.split('\n').length, outputTruncated: Buffer.byteLength(text) > 4096, outputSha256: hash(text), outputPreview: preview };
}
