export type SessionExpiryHandler = () => void;

let sessionExpiryHandler: SessionExpiryHandler | undefined;
const notifiedErrors = new WeakSet<object>();

export function registerSessionExpiryHandler(handler: SessionExpiryHandler): () => void {
  sessionExpiryHandler = handler;
  return () => {
    if (sessionExpiryHandler === handler) {
      sessionExpiryHandler = undefined;
    }
  };
}

export function notifySessionExpiry(statusCode: number, code: string, sourceError?: object): void {
  if (sourceError && notifiedErrors.has(sourceError)) {
    return;
  }
  if (sourceError) {
    notifiedErrors.add(sourceError);
  }
  if (statusCode === 401 || code === 'SESSION_UNAUTHENTICATED') {
    sessionExpiryHandler?.();
  }
}
