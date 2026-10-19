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
  const application = await createApplication();
  const server = createListener(application);
  let closing = false;

  const close = async (signal: string): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    application.logger.info({ signal }, 'Shutting down application');
    await closeServer(server);
    await application.stopMaintenance();
    if (application.dataSource.isInitialized) {
      await application.dataSource.destroy();
    }
  };

  process.once('SIGINT', () => { void close('SIGINT'); });
  process.once('SIGTERM', () => { void close('SIGTERM'); });

  await new Promise<void>((resolve) => {
    server.listen(application.config.port, application.config.host, () => {
      application.logger.info({ port: application.config.port }, 'Application listening');
      resolve();
    });
  });
}

if (require.main === module) {
  const logger = createLogger(process.env.LOG_LEVEL ?? 'error');
  void startServer().catch((error: unknown) => {
    logger.error({ error }, 'Application failed to start');
    process.exitCode = 1;
  });
}
