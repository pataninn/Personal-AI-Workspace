export type SessionExpiryHandler = () => void;

let sessionExpiryHandler: SessionExpiryHandler | undefined;
let sessionGeneration = 0;
const notifiedErrors = new WeakSet<object>();

export function registerSessionExpiryHandler(handler: SessionExpiryHandler): () => void {
  sessionExpiryHandler = handler;
  return () => {
    if (sessionExpiryHandler === handler) {
      sessionExpiryHandler = undefined;
    }
  };
}

export function getRequestSessionGeneration(): number { return sessionGeneration; }

/** Invalidates requests issued before an application session transition. */
export function advanceRequestSessionGeneration(): void { sessionGeneration += 1; }

export function notifySessionExpiry(statusCode: number, code: string, sourceError?: object, requestGeneration = sessionGeneration): void {
  if (sourceError && notifiedErrors.has(sourceError)) {
    return;
  }
  if (sourceError) {
    notifiedErrors.add(sourceError);
  }
  if (requestGeneration !== sessionGeneration) return;
  if (statusCode === 401 || code === 'SESSION_UNAUTHENTICATED') {
    sessionExpiryHandler?.();
  }
}
