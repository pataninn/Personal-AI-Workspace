import { AppError } from '@/shared/errors/app-error';

export interface NimReadiness {
  readonly ready: boolean;
  readonly provider: string;
  readonly model: string;
}

export interface FetchImplementation {
  (input: string, init?: RequestInit): Promise<Response>;
}

export interface OpenShellGatewayClientOptions {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientToken: string;
  readonly healthPath: string;
  readonly nimReadinessPath: string;
  readonly timeoutMs: number;
  readonly fetchImplementation?: FetchImplementation;
}

export class OpenShellGatewayRequestError extends AppError {
  public constructor(code: string, message: string) {
    super(code, 503, message);
    this.name = 'OpenShellGatewayRequestError';
  }
}

interface JsonRecord {
  readonly [key: string]: unknown;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNimReadiness(value: unknown): value is NimReadiness {
  if (!isJsonRecord(value)) {
    return false;
  }
  return (
    typeof value.ready === 'boolean' &&
    typeof value.provider === 'string' &&
    typeof value.model === 'string'
  );
}

export class OpenShellGatewayClient {
  private readonly options: OpenShellGatewayClientOptions;
  private readonly fetchImplementation: FetchImplementation;

  public constructor(options: OpenShellGatewayClientOptions) {
    this.options = options;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public async checkHealth(): Promise<void> {
    await this.request(this.options.healthPath);
  }

  public async getNimReadiness(): Promise<NimReadiness> {
    const response = await this.request(this.options.nimReadinessPath);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new OpenShellGatewayRequestError('OPENSHELL_INVALID_RESPONSE', 'OpenShell returned invalid readiness data.');
    }
    if (!isNimReadiness(body)) {
      throw new OpenShellGatewayRequestError('OPENSHELL_INVALID_RESPONSE', 'OpenShell returned invalid readiness data.');
    }
    return body;
  }

  private async request(path: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.fetchImplementation(this.buildUrl(path), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.options.clientToken}`,
          'X-OpenShell-Client-Id': this.options.clientId
        },
        signal: controller.signal
      });
      if (!response.ok) {
        throw new OpenShellGatewayRequestError(
          response.status === 401 || response.status === 403 ? 'OPENSHELL_UNAUTHORIZED' : 'OPENSHELL_UNAVAILABLE',
          'OpenShell gateway did not accept the readiness request.'
        );
      }
      return response;
    } catch (error: unknown) {
      if (error instanceof OpenShellGatewayRequestError) {
        throw error;
      }
      throw new OpenShellGatewayRequestError('OPENSHELL_UNAVAILABLE', 'OpenShell gateway is unreachable.');
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildUrl(path: string): string {
    return new URL(path, this.options.baseUrl).toString();
  }
}
