export interface ApiErrorDetail {
  readonly field: string;
  readonly message: string;
}

export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly details?: readonly ApiErrorDetail[];
}

export interface ApiEnvelope<T> {
  readonly data: T | null;
  readonly error: ApiError | null;
}
