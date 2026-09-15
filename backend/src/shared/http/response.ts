import type { Response } from 'express';

import type { ErrorDetail } from '@/shared/errors/app-error';

export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly details?: readonly ErrorDetail[];
}

export interface ApiEnvelope<T> {
  readonly data: T | null;
  readonly error: ApiError | null;
}

export function sendData<T>(response: Response, data: T, statusCode = 200): void {
  const body: ApiEnvelope<T> = { data, error: null };
  response.status(statusCode).json(body);
}

export function sendError(
  response: Response,
  statusCode: number,
  error: ApiError
): void {
  const body: ApiEnvelope<never> = { data: null, error };
  response.status(statusCode).json(body);
}
