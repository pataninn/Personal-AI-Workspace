export type LoadStatus = 'idle' | 'loading' | 'success' | 'error';
export type OlderHistoryStatus = 'idle' | 'loading' | 'error';

export interface ListError {
  readonly kind: 'project-not-found' | 'retryable' | 'conversation-not-found';
  readonly title: string;
  readonly detail: string;
}

export interface HistoryError extends ListError {
  readonly kind: 'project-not-found' | 'retryable' | 'conversation-not-found';
}
