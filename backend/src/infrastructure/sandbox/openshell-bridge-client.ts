import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as tls from 'node:tls';

import { AppError } from '@/shared/errors/app-error';
import {
  decodeBridgeFrame,
  encodeBridgeFrame,
  type BridgeJsonObject,
  type BridgeOperation,
  type BridgeRequestFrame,
  type BridgeResponseFrame
} from '@/infrastructure/sandbox/openshell-bridge-protocol';
import { BridgeFrameDecoder, OpenShellBridgeProtocolError } from '@/infrastructure/sandbox/openshell-bridge-protocol';
import { OPEN_SHELL_BRIDGE_PROTOCOL_VERSION } from '@/infrastructure/sandbox/openshell-bridge-types';

const DEFAULT_PROBE_RUN_ID = 'run-probe';
const OPERATION_VALUES: readonly BridgeOperation[] = ['probe', 'create', 'upload', 'exec', 'acp.open', 'acp.send', 'acp.cancel', 'status', 'delete'];
const REQUIRED_OPERATIONS: readonly BridgeOperation[] = OPERATION_VALUES;

export interface BridgeTlsCredentials {
  readonly ca: Buffer;
  readonly cert: Buffer;
  readonly key: Buffer;
}

export interface BridgeTransportOptions {
  readonly endpoint: URL;
  readonly credentials: BridgeTlsCredentials;
  readonly frame: Buffer;
  readonly timeoutMs: number;
}

export type BridgeTransport = (options: BridgeTransportOptions) => Promise<BridgeResponseFrame>;

export interface BridgeTlsClientOptions {
  readonly endpoint: string;
  readonly caFile: string;
  readonly clientCertFile: string;
  readonly clientKeyFile: string;
  readonly profileDigest: string;
  readonly requestTimeoutMs: number;
  readonly transport?: BridgeTransport;
  readonly credentialsLoader?: (paths: BridgeCredentialPaths) => Promise<BridgeTlsCredentials>;
}

export interface BridgeCredentialPaths {
  readonly caFile: string;
  readonly clientCertFile: string;
  readonly clientKeyFile: string;
}

export interface BridgeProbeResult {
  readonly protocolVersion: number;
  readonly profileDigest: string;
  readonly operations: readonly BridgeOperation[];
  readonly receiptDigest: string;
}

export class OpenShellBridgeClientError extends AppError {
  public constructor(message: string) {
    super('OPEN_SHELL_BRIDGE_UNAVAILABLE', 503, message);
    this.name = 'OpenShellBridgeClientError';
  }
}

export class OpenShellBridgeClient {
  private readonly endpoint: URL;
  private readonly transport: BridgeTransport;
  private readonly credentialsLoader: (paths: BridgeCredentialPaths) => Promise<BridgeTlsCredentials>;
  private nextRequestId = 1;

  public constructor(private readonly options: BridgeTlsClientOptions) {
    this.endpoint = parseEndpoint(options.endpoint);
    validateClientOptions(options);
    this.transport = options.transport ?? sendTlsFrame;
    this.credentialsLoader = options.credentialsLoader ?? readTlsCredentials;
  }

  public async probe(): Promise<BridgeProbeResult> {
    const response = await this.exchange('probe', DEFAULT_PROBE_RUN_ID, {
      profileDigest: this.options.profileDigest
    });
    if (response.outcome !== 'ok') {
      throw new OpenShellBridgeClientError('The private bridge did not accept its readiness probe.');
    }
    const profileDigest = requireProfileDigest(response.payload.profileDigest);
    if (profileDigest !== this.options.profileDigest) {
      throw new OpenShellBridgeClientError('The private bridge profile does not match the app profile.');
    }
    return {
      protocolVersion: response.protocolVersion,
      profileDigest,
      operations: requireOperations(response.payload.operations),
      receiptDigest: response.receiptDigest
    };
  }

  private async exchange(operation: BridgeOperation, runId: string, payload: BridgeJsonObject): Promise<BridgeResponseFrame> {
    const request: BridgeRequestFrame = {
      kind: 'request',
      protocolVersion: OPEN_SHELL_BRIDGE_PROTOCOL_VERSION,
      operation,
      runId,
      requestId: this.nextRequestId++,
      deadlineEpochMs: Date.now() + this.options.requestTimeoutMs,
      capability: randomBytes(32).toString('base64url'),
      payload
    };
    const frame = encodeBridgeFrame(request);
    try {
      const credentials = await this.credentialsLoader({ caFile: this.options.caFile, clientCertFile: this.options.clientCertFile, clientKeyFile: this.options.clientKeyFile });
      const response = await this.transport({ endpoint: this.endpoint, credentials, frame, timeoutMs: this.options.requestTimeoutMs });
      if (response.kind !== 'response' || response.operation !== operation || response.requestId !== request.requestId || response.runId !== runId) {
        throw new OpenShellBridgeClientError('The private bridge returned a mismatched response.');
      }
      return response;
    } catch (error: unknown) {
      if (error instanceof OpenShellBridgeClientError || error instanceof OpenShellBridgeProtocolError) {
        throw error;
      }
      throw new OpenShellBridgeClientError('The private bridge request could not be confirmed.');
    }
  }
}

function parseEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new OpenShellBridgeClientError('The private bridge endpoint is invalid.');
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.pathname !== '/' && endpoint.pathname !== '')) {
    throw new OpenShellBridgeClientError('The private bridge endpoint must be an HTTPS origin without embedded credentials.');
  }
  return endpoint;
}

function validateClientOptions(options: BridgeTlsClientOptions): void {
  validateAbsolutePath(options.caFile, 'bridge CA file');
  validateAbsolutePath(options.clientCertFile, 'bridge client certificate');
  validateAbsolutePath(options.clientKeyFile, 'bridge client key');
  if (!/^sha256:[0-9a-f]{64}$/u.test(options.profileDigest)) {
    throw new OpenShellBridgeClientError('The bridge profile digest is invalid.');
  }
  if (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1_000 || options.requestTimeoutMs > 300_000) {
    throw new OpenShellBridgeClientError('The bridge request timeout is invalid.');
  }
}

function validateAbsolutePath(value: string, label: string): void {
  if (!value.startsWith('/') || value.includes('\0') || value.includes('\r') || value.includes('\n')) {
    throw new OpenShellBridgeClientError(`The ${label} must be an absolute path.`);
  }
}

async function readTlsCredentials(paths: BridgeCredentialPaths): Promise<BridgeTlsCredentials> {
  try {
    const [ca, cert, key] = await Promise.all([fs.readFile(paths.caFile), fs.readFile(paths.clientCertFile), fs.readFile(paths.clientKeyFile)]);
    return { ca, cert, key };
  } catch {
    throw new OpenShellBridgeClientError('The private bridge mTLS files could not be read.');
  }
}

async function sendTlsFrame(options: BridgeTransportOptions): Promise<BridgeResponseFrame> {
  return new Promise<BridgeResponseFrame>((resolve, reject) => {
    const decoder = new BridgeFrameDecoder();
    const socket = tls.connect({
      host: options.endpoint.hostname,
      port: options.endpoint.port ? Number(options.endpoint.port) : 443,
      servername: options.endpoint.hostname,
      ca: options.credentials.ca,
      cert: options.credentials.cert,
      key: options.credentials.key,
      minVersion: 'TLSv1.3',
      rejectUnauthorized: true
    });
    let settled = false;
    const timeout = setTimeout(() => finish(new OpenShellBridgeClientError('The private bridge request timed out.')), options.timeoutMs);
    const finish = (error?: Error, response?: BridgeResponseFrame): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) {
        reject(error);
      } else if (response) {
        resolve(response);
      } else {
        reject(new OpenShellBridgeClientError('The private bridge closed without a response.'));
      }
    };
    socket.once('secureConnect', () => socket.write(options.frame));
    socket.on('data', (chunk: Buffer) => {
      try {
        const frames = decoder.push(chunk);
        const response = frames[0];
        if (response?.kind === 'response') {
          finish(undefined, response);
        }
      } catch (error: unknown) {
        finish(error instanceof Error ? error : new OpenShellBridgeClientError('The private bridge returned an invalid frame.'));
      }
    });
    socket.once('error', (error: Error) => finish(new OpenShellBridgeClientError(error.message)));
    socket.once('close', () => {
      if (!settled) {
        finish(undefined);
      }
    });
  });
}

function requireProfileDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new OpenShellBridgeClientError('The bridge readiness response omitted a valid profile digest.');
  }
  return value;
}

function requireOperations(value: unknown): readonly BridgeOperation[] {
  if (!Array.isArray(value) || value.some((operation) => !isBridgeOperation(operation))) {
    throw new OpenShellBridgeClientError('The bridge readiness response omitted its supported operation list.');
  }
  const operations = value.filter(isBridgeOperation);
  if (REQUIRED_OPERATIONS.some((operation) => !operations.includes(operation))) {
    throw new OpenShellBridgeClientError('The bridge readiness response does not support the required operation set.');
  }
  return operations;
}

function isBridgeOperation(value: unknown): value is BridgeOperation {
  return typeof value === 'string' && OPERATION_VALUES.some((operation) => operation === value);
}
