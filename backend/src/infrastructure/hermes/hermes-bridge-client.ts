import { promises as fs } from 'node:fs';
import https from 'node:https';

import { AiRunRuntimeUnavailableError } from '@/modules/ai-runs/domain/ai-run-errors';

export type HermesBridgeAcceptance = 'not-sent' | 'rejected' | 'unknown';

/** Adds only the bridge-call certainty needed to avoid retrying an accepted Home turn. */
export class HermesBridgeCallError extends AiRunRuntimeUnavailableError {
  public constructor(public readonly acceptance: HermesBridgeAcceptance) {
    super();
    this.name = 'HermesBridgeCallError';
  }
}

export interface HermesBridgeOptions {
  readonly endpoint: string;
  readonly caFile: string;
  readonly certFile: string;
  readonly keyFile: string;
}

/** Authenticates only to the private application bridge, never the vendor gateway. */
export class HermesBridgeClient {
  public constructor(private readonly options: HermesBridgeOptions) {}

  public async call(operation: string, runId = 'run-probe', capability = '', payload: unknown = {}): Promise<Record<string, unknown>> {
    let ca: Buffer;
    let cert: Buffer;
    let key: Buffer;
    try {
      [ca, cert, key] = await Promise.all([fs.readFile(this.options.caFile), fs.readFile(this.options.certFile), fs.readFile(this.options.keyFile)]);
    } catch {
      throw new HermesBridgeCallError('not-sent');
    }
    const body = JSON.stringify({ operation, runId, capability, payload });
    if (Buffer.byteLength(body) > 1024 * 1024) throw new HermesBridgeCallError('not-sent');
    let endpoint: URL;
    try {
      endpoint = new URL('/v1/runtime', this.options.endpoint);
    } catch {
      throw new HermesBridgeCallError('not-sent');
    }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new HermesBridgeCallError('not-sent');
    return exchange({ endpoint, ca, cert, key, body });
  }
}

interface ExchangeInput {
  readonly endpoint: URL;
  readonly ca: Buffer;
  readonly cert: Buffer;
  readonly key: Buffer;
  readonly body: string;
}

function exchange(input: ExchangeInput): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const request = https.request(input.endpoint, { method: 'POST', ca: input.ca, cert: input.cert, key: input.key, minVersion: 'TLSv1.3', rejectUnauthorized: true,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(input.body) } }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024 * 1024) request.destroy(); else chunks.push(chunk); });
      response.on('error', () => reject(new HermesBridgeCallError(response.statusCode === 200 ? 'unknown' : 'rejected')));
      response.on('end', () => resolveResponse(response.statusCode, Buffer.concat(chunks), resolve, reject));
    });
    request.setTimeout(150_000, () => request.destroy());
    request.on('error', () => reject(new HermesBridgeCallError('unknown')));
    try {
      request.end(input.body);
    } catch {
      reject(new HermesBridgeCallError('not-sent'));
    }
  });
}

function resolveResponse(status: number | undefined, body: Buffer, resolve: (value: Record<string, unknown>) => void, reject: (error: Error) => void): void {
  if (status !== 200) {
    reject(new HermesBridgeCallError('rejected'));
    return;
  }
  try {
    const value: unknown = JSON.parse(body.toString('utf8'));
    if (!isRecord(value) || !isRecord(value.data)) throw new HermesBridgeCallError('unknown');
    resolve(value.data);
  } catch (error: unknown) {
    reject(error instanceof HermesBridgeCallError ? error : new HermesBridgeCallError('unknown'));
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
