import pino, { type Logger } from 'pino';

export type AppLogger = Logger;

export function createLogger(level: string): AppLogger {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'headers.authorization',
        'headers.cookie',
        'req.body.password',
        'req.headers.x-csrf-token',
        'headers.x-csrf-token',
        'nvidiaApiKey',
        'providerSecret',
        'token'
      ],
      censor: '[REDACTED]'
    }
  });
}
