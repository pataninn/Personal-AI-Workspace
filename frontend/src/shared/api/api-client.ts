import type { ApiEnvelope, ApiErrorDetail } from '@/shared/api/api-response';
import { notifySessionExpiry } from '@/shared/api/session-expiry';

export class ApiClientError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details: readonly ApiErrorDetail[];

  public constructor(statusCode: number, code: string, message: string, details: readonly ApiErrorDetail[] = []) {
    super(message);
    this.name = 'ApiClientError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

async function parseEnvelope<T>(response: Response): Promise<ApiEnvelope<T> | null> {
  if (response.status === 204) {
    return null;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiClientError(response.status, 'INVALID_RESPONSE', 'The local app returned an invalid response.');
  }
  if (!isApiEnvelope<T>(body)) {
    throw new ApiClientError(response.status, 'INVALID_RESPONSE', 'The local app returned an invalid response.');
  }
  return body;
}

function isApiEnvelope<T>(value: unknown): value is ApiEnvelope<T> {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { data?: unknown; error?: unknown };
  return 'data' in candidate && 'error' in candidate;
}

export interface ApiRequestOptions {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  readonly headers?: HeadersInit;
}

export async function requestJson<T>(
  url: string,
  options: ApiRequestOptions,
  fetchImplementation: typeof fetch = fetch
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetchImplementation(url, {
    method: options.method,
    credentials: 'include',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  });
  let body: ApiEnvelope<T> | null;
  try {
    body = await parseEnvelope<T>(response);
  } catch (error: unknown) {
    notifySessionExpiry(response.status, 'INVALID_RESPONSE');
    throw error;
  }
  if (!response.ok || body?.error) {
    const clientError = new ApiClientError(
      response.status,
      body?.error?.code ?? 'HTTP_ERROR',
      body?.error?.message ?? 'The request failed.',
      body?.error?.details ?? []
    );
    notifySessionExpiry(clientError.statusCode, clientError.code, clientError);
    throw clientError;
  }
  if (!body || body.data === null) {
    throw new ApiClientError(response.status, 'EMPTY_RESPONSE', 'The response did not contain data.');
  }
  return body.data;
}

export async function getJson<T>(url: string, fetchImplementation: typeof fetch = fetch): Promise<T> {
  return requestJson<T>(url, { method: 'GET' }, fetchImplementation);
}

export async function postJson<T>(
  url: string,
  requestBody: unknown,
  headers?: HeadersInit,
  fetchImplementation: typeof fetch = fetch
): Promise<T> {
  return requestJson<T>(url, { method: 'POST', body: requestBody, headers }, fetchImplementation);
}

export async function postNoContent(
  url: string,
  headers?: HeadersInit,
  fetchImplementation: typeof fetch = fetch
): Promise<void> {
  return requestNoContent(url, 'POST', headers, fetchImplementation);
}

export async function deleteNoContent(
  url: string,
  headers?: HeadersInit,
  fetchImplementation: typeof fetch = fetch
): Promise<void> {
  return requestNoContent(url, 'DELETE', headers, fetchImplementation);
}

async function requestNoContent(
  url: string,
  method: 'POST' | 'DELETE',
  headers?: HeadersInit,
  fetchImplementation: typeof fetch = fetch
): Promise<void> {
  const response = await fetchImplementation(url, {
    method,
    credentials: 'include',
    headers: new Headers(headers)
  });
  let body: ApiEnvelope<never> | null;
  try {
    body = await parseEnvelope<never>(response);
  } catch (error: unknown) {
    notifySessionExpiry(response.status, 'INVALID_RESPONSE');
    throw error;
  }
  if (!response.ok || body?.error) {
    const clientError = new ApiClientError(
      response.status,
      body?.error?.code ?? 'HTTP_ERROR',
      body?.error?.message ?? 'The request failed.',
      body?.error?.details ?? []
    );
    notifySessionExpiry(clientError.statusCode, clientError.code, clientError);
    throw clientError;
  }
}

export function patchJson<T>(
  url: string,
  requestBody: unknown,
  headers?: HeadersInit,
  fetchImplementation: typeof fetch = fetch
): Promise<T> {
  return requestJson<T>(url, { method: 'PATCH', body: requestBody, headers }, fetchImplementation);
}
