import { promises as fs } from 'node:fs';
import https from 'node:https';

import { AiRunRuntimeUnavailableError } from '@/modules/ai-runs/domain/ai-run-errors';

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
    const [ca, cert, key] = await Promise.all([fs.readFile(this.options.caFile), fs.readFile(this.options.certFile), fs.readFile(this.options.keyFile)]);
    const body = JSON.stringify({ operation, runId, capability, payload });
    if (Buffer.byteLength(body) > 1024 * 1024) throw new AiRunRuntimeUnavailableError();
    const endpoint = new URL('/v1/runtime', this.options.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new AiRunRuntimeUnavailableError();
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
      response.on('error', () => reject(new AiRunRuntimeUnavailableError()));
      response.on('end', () => resolveResponse(response.statusCode, Buffer.concat(chunks), resolve, reject));
    });
    request.setTimeout(150_000, () => request.destroy());
    request.on('error', () => reject(new AiRunRuntimeUnavailableError()));
    request.end(input.body);
  });
}

function resolveResponse(status: number | undefined, body: Buffer, resolve: (value: Record<string, unknown>) => void, reject: (error: Error) => void): void {
  try {
    const value: unknown = JSON.parse(body.toString('utf8'));
    if (status !== 200 || !isRecord(value) || !isRecord(value.data)) throw new AiRunRuntimeUnavailableError();
    resolve(value.data);
  } catch { reject(new AiRunRuntimeUnavailableError()); }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
