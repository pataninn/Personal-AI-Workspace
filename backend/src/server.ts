import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';

import { createApplication } from '@/composition-root';
import { ConfigurationError } from '@/shared/errors/app-error';
import { createLogger } from '@/shared/logging/logger';

type ApplicationServer = HttpServer | HttpsServer;

function createListener(application: Awaited<ReturnType<typeof createApplication>>): ApplicationServer {
  const { config, app } = application;
  if (config.protocol === 'https') {
    if (!config.tlsCertFile || !config.tlsKeyFile) {
      throw new ConfigurationError('HTTPS certificate configuration is missing.');
    }
    return createHttpsServer({
      cert: readFileSync(config.tlsCertFile),
      key: readFileSync(config.tlsKeyFile)
    }, app);
  }
  if (!config.allowInsecureHttp) {
    throw new ConfigurationError('Insecure HTTP is disabled.');
  }
  return createHttpServer(app);
}

function closeServer(server: ApplicationServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function startServer(): Promise<void> {
  const application = await createApplication(process.env);
  let server: ApplicationServer;
  const stopApplication = async (): Promise<void> => {
    try { await application.stopMaintenance(); }
    finally { if (application.dataSource.isInitialized) await application.dataSource.destroy(); }
  };
  try { server = createListener(application); }
  catch (error: unknown) { await stopApplication(); throw error; }
  let closing = false;

  const close = async (signal: string): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    application.logger.info({ signal }, 'Shutting down application');
    // Long-lived streams or an unreachable runtime must not keep an old owner alive forever.
    // On timeout, exit before releasing the lock; the next process recovers saved work.
    const deadline = setTimeout(() => process.exit(1), 30_000);
    deadline.unref();
    try { await closeServer(server); await stopApplication(); }
    catch (error: unknown) { application.logger.error({ error }, 'Shutdown failed'); process.exit(1); }
    finally { clearTimeout(deadline); }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(application.config.port, application.config.host, () => {
        server.removeListener('error', reject);
        application.logger.info({ port: application.config.port }, 'Application listening');
        resolve();
      });
    });
  } catch (error: unknown) {
    await stopApplication();
    throw error;
  }
  process.once('SIGINT', () => { void close('SIGINT'); });
  process.once('SIGTERM', () => { void close('SIGTERM'); });
}

if (require.main === module) {
  const logger = createLogger(process.env.LOG_LEVEL ?? 'error');
  void startServer().catch((error: unknown) => {
    logger.error({ error }, 'Application failed to start');
    process.exitCode = 1;
  });
}
