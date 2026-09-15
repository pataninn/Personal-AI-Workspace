import { z } from 'zod';

import { ConfigurationError, type ErrorDetail } from '@/shared/errors/app-error';

export interface DatabaseConfig {
  readonly url: string;
}

const databaseEnvironmentSchema = z.object({
  DATABASE_URL: z.string().url().refine(
    (value: string) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
    'DATABASE_URL must use the PostgreSQL protocol'
  )
});

function configurationDetails(error: z.ZodError): readonly ErrorDetail[] {
  return error.issues.map((issue: z.ZodIssue) => ({
    field: issue.path.join('.') || 'DATABASE_URL',
    message: issue.message
  }));
}

export function loadDatabaseConfig(
  environment: NodeJS.ProcessEnv = process.env
): DatabaseConfig {
  const parsed = databaseEnvironmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new ConfigurationError('Database configuration is invalid.', configurationDetails(parsed.error));
  }

  return { url: parsed.data.DATABASE_URL };
}
