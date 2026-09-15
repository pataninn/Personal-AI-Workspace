import {
  WorkspaceOperationCancelledError,
  WorkspaceOperationTimeoutError
} from '@/modules/files/domain/workspace-errors';

export class WorkspaceOperationContext {
  private readonly deadline: number;

  public constructor(
    private readonly signal: AbortSignal | undefined,
    timeoutMs: number
  ) {
    this.deadline = Date.now() + timeoutMs;
  }

  public assertActive(): void {
    if (this.signal?.aborted) {
      throw new WorkspaceOperationCancelledError();
    }
    if (Date.now() >= this.deadline) {
      throw new WorkspaceOperationTimeoutError();
    }
  }

  public async run<T>(operation: () => Promise<T>): Promise<T> {
    this.assertActive();
    const remainingMs = Math.max(1, this.deadline - Date.now());
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = (): void => {
        clearTimeout(timer);
        this.signal?.removeEventListener('abort', abort);
      };
      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new WorkspaceOperationTimeoutError());
        }
      }, remainingMs);
      const abort = (): void => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new WorkspaceOperationCancelledError());
        }
      };
      this.signal?.addEventListener('abort', abort, { once: true });
      let pendingOperation: Promise<T>;
      try {
        pendingOperation = operation();
      } catch (error: unknown) {
        settled = true;
        cleanup();
        reject(error);
        return;
      }
      pendingOperation.then((value) => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(value);
        }
      }).catch((error: unknown) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(error);
        }
      });
    });
  }
}
