import {
  ModelProviderConfigurationError,
  ModelProviderOutputError,
  ModelProviderTimeoutError,
  ModelProviderUnavailableError
} from '@/modules/ai-runs/domain/model-provider-errors';
import { EXPECTED_NIM_MODEL } from '@/infrastructure/config/app-config';
import type {
  IModelProvider,
  ModelProviderEvent,
  ModelProviderRequest,
  ProviderCancellationResult
} from '@/modules/ai-runs/repositories/model-provider';
import { maxProviderOutputBytes, parseProviderOutput } from '@/infrastructure/ai-provider/provider-output';

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 192 * 1024;
const SAFE_DELTA_CHARS = 32;

export interface NvidiaHostedNimProviderOptions {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly fetchImplementation?: typeof fetch;
}

export class NvidiaHostedNimProvider implements IModelProvider {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;
  private readonly controllers = new Map<string, AbortController>();

  public constructor(options: NvidiaHostedNimProviderOptions) {
    this.endpoint = normalizeEndpoint(options.endpoint);
    this.model = options.model.trim();
    this.apiKey = options.apiKey.trim();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public async checkAvailability(): Promise<void> {
    if (!this.endpoint || this.model !== EXPECTED_NIM_MODEL || !this.apiKey || !Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new ModelProviderConfigurationError();
    }
    try {
      const parsed = new URL(this.endpoint);
      if (parsed.protocol !== 'https:' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
        throw new ModelProviderConfigurationError();
      }
    } catch (error: unknown) {
      if (error instanceof ModelProviderConfigurationError) {
        throw error;
      }
      throw new ModelProviderConfigurationError();
    }
  }

  public async *stream(input: ModelProviderRequest): AsyncIterable<ModelProviderEvent> {
    await this.checkAvailability();
    const controller = new AbortController();
    this.controllers.set(input.runId, controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const body = buildRequestBody(input, this.model);
      const encoded = JSON.stringify(body);
      if (Buffer.byteLength(encoded, 'utf8') > MAX_REQUEST_BYTES) {
        yield { type: 'failed', message: 'The approved provider request exceeded the safe size limit.' };
        return;
      }
      yield { type: 'started' };
      yield { type: 'provider.request_started' };
      const response = await this.fetchImplementation(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: encoded,
        signal: controller.signal
      });
      yield { type: 'provider.response_received' };
      if (!response.ok || response.status === 202) {
        yield { type: 'failed', message: 'The NVIDIA provider rejected the request.' };
        return;
      }
      if (!response.body) {
        yield* this.parseJsonResponse(await response.text());
        return;
      }
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        yield* this.parseStream(response.body, controller.signal);
        return;
      }
      yield* this.parseJsonResponse(await readBoundedBody(response.body, controller.signal));
    } catch (error: unknown) {
      if (controller.signal.aborted && !timedOut) {
        yield { type: 'cancelled' };
      } else if (timedOut) {
        yield { type: 'needs_manual_review', message: new ModelProviderTimeoutError().message };
      } else if (error instanceof ModelProviderOutputError) {
        yield { type: 'failed', message: error.message };
      } else {
        yield { type: 'needs_manual_review', message: new ModelProviderUnavailableError().message };
      }
    } finally {
      clearTimeout(timer);
      this.controllers.delete(input.runId);
    }
  }

  public async cancel(runId: string): Promise<ProviderCancellationResult> {
    const controller = this.controllers.get(runId);
    if (!controller) {
      return { outcome: 'unknown' };
    }
    controller.abort();
    return { outcome: 'confirmed' };
  }

  private async *parseJsonResponse(raw: string): AsyncIterable<ModelProviderEvent> {
    if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) {
      yield { type: 'failed', message: new ModelProviderOutputError().message };
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      yield { type: 'failed', message: new ModelProviderOutputError().message };
      return;
    }
    let text: string;
    try {
      text = extractCompletionText(payload);
    } catch (error: unknown) {
      if (error instanceof ModelProviderUnavailableError) {
        yield { type: 'needs_manual_review', message: error.message };
        return;
      }
      yield { type: 'failed', message: error instanceof Error ? error.message : new ModelProviderOutputError().message };
      return;
    }
    yield* this.outputEvents(text);
  }

  private async *parseStream(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<ModelProviderEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalBytes = 0;
    let accumulated = '';
    const deltas: string[] = [];
    let structured = false;
    let sawDone = false;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        signal.throwIfAborted();
        totalBytes += chunk.value.byteLength;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          throw new ModelProviderOutputError();
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split(/\r?\n/u);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const parsed = parseStreamLine(line, sawDone);
          if (parsed.done) {
            sawDone = true;
          } else if (parsed.text) {
            accumulated += parsed.text;
            deltas.push(parsed.text);
            if (!structured && accumulated.trimStart().startsWith('{')) {
              structured = true;
            }
          }
        }
      }
      buffer += decoder.decode();
      if (buffer.length > 0) {
        const parsed = parseStreamLine(buffer, sawDone);
        if (parsed.done) {
          sawDone = true;
        } else if (parsed.text) {
          accumulated += parsed.text;
          deltas.push(parsed.text);
          if (!structured && accumulated.trimStart().startsWith('{')) {
            structured = true;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (!sawDone) {
      yield { type: 'failed', message: new ModelProviderOutputError().message };
      return;
    }
    yield* this.outputEvents(accumulated, structured, deltas);
  }

  private async *outputEvents(text: string, structured = text.trimStart().startsWith('{'), rawDeltas: readonly string[] = []): AsyncIterable<ModelProviderEvent> {
    if (Buffer.byteLength(text, 'utf8') > maxProviderOutputBytes()) {
      yield { type: 'failed', message: new ModelProviderOutputError().message };
      return;
    }
    let parsed;
    try {
      parsed = parseProviderOutput(text);
    } catch (error: unknown) {
      yield { type: 'failed', message: error instanceof Error ? error.message : new ModelProviderOutputError().message };
      return;
    }
    if (parsed.changes.length === 0 && parsed.text.length === 0) {
      yield { type: 'failed', message: new ModelProviderOutputError().message };
      return;
    }
    if (parsed.text) {
      if (!structured && rawDeltas.length > 0) {
        const rawText = rawDeltas.join('');
        if (rawText === text && parsed.text === text) {
          for (const delta of rawDeltas) {
            yield { type: 'assistant.delta', text: delta };
          }
        } else {
          for (const delta of safeChunks(parsed.text, SAFE_DELTA_CHARS)) {
            yield { type: 'assistant.delta', text: delta };
          }
        }
      }
      yield { type: 'assistant.message.completed', text: parsed.text };
    }
    if (parsed.changes.length > 0) {
      yield { type: 'changes.proposed', changes: parsed.changes };
    }
    yield { type: 'completed', text: parsed.text };
  }
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/u, '');
}

function buildRequestBody(input: ModelProviderRequest, model: string): Record<string, unknown> {
  const messages = [
    { role: 'system', content: systemInstruction() },
    { role: 'user', content: `${contextPrompt(input)}\n\nUser request:\n${input.request}` }
  ];
  return {
    model,
    messages,
    stream: true,
    temperature: 1.0,
    top_p: 0.95,
    max_tokens: 4096,
    reasoning_effort: 'none',
    chat_template_kwargs: { force_nonempty_content: true }
  };
}

function systemInstruction(): string {
  return 'You are a bounded project assistant. Use only the approved context. Return concise helpful text. If proposing file changes, return only valid JSON with exactly these top-level keys: message and changes. Each changes item must use operation (create, edit, overwrite, rename, or delete), path (normalized relative path), and content for edits; optional summary. Example: {"message":"Updated the file.","changes":[{"operation":"edit","path":"src/app.ts","content":"export const greeting = 1;"}]}. Never propose commands, absolute paths, secrets, or changes outside the project.';
}

function contextPrompt(input: ModelProviderRequest): string {
  const files = input.files.map((file) => `FILE: ${file.relativePath}\n${file.content}`).join('\n\n');
  const messages = input.messages.map((message) => `${message.role}: ${message.content}`).join('\n');
  return `Approved project context:\n${files}\n\nRecent conversation:\n${messages}`;
}

function parseStreamLine(line: string, sawDone: boolean): { readonly done: boolean; readonly text: string } {
  const data = parseSseLine(line);
  if (data === null || data.length === 0) {
    return { done: false, text: '' };
  }
  if (data === '[DONE]') {
    return { done: true, text: '' };
  }
  if (sawDone) {
    throw new ModelProviderOutputError();
  }
  return { done: false, text: extractDelta(data) };
}

function parseSseLine(line: string): string | null {
  if (!line.startsWith('data:')) {
    return null;
  }
  return line.slice(5).trim();
}

function extractDelta(raw: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    throw new ModelProviderOutputError();
  }
  if (isRecord(payload) && 'error' in payload) {
    throw new ModelProviderUnavailableError();
  }
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new ModelProviderOutputError();
  }
  const choice = payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.delta)) {
    throw new ModelProviderOutputError();
  }
  if (choice.delta.content === undefined) {
    return '';
  }
  if (typeof choice.delta.content !== 'string') {
    throw new ModelProviderOutputError();
  }
  return choice.delta.content;
}

function extractCompletionText(payload: unknown): string {
  if (isRecord(payload) && 'error' in payload) {
    throw new ModelProviderUnavailableError();
  }
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new ModelProviderOutputError();
  }
  const choice = payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message) || typeof choice.message.content !== 'string') {
    throw new ModelProviderOutputError();
  }
  return choice.message.content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function readBoundedBody(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      signal.throwIfAborted();
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        throw new ModelProviderOutputError();
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ModelProviderOutputError();
  }
}

function safeChunks(value: string, maxCharacters: number): readonly string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += maxCharacters) {
    chunks.push(value.slice(offset, offset + maxCharacters));
  }
  return chunks;
}
