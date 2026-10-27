import { promises as fs } from 'node:fs';

import type { DataSource } from 'typeorm';

import {
  StartupChecksError,
  type StartupCheckFailure
} from '@/shared/errors/app-error';

export interface StartupCheckOptions {
  readonly dataSource: DataSource;
  readonly workspaceRoot: string;
  readonly workspaceIdentityFile: string;
  readonly workspaceIdentity: string;

}

async function checkDatabase(dataSource: DataSource): Promise<StartupCheckFailure | null> {
  try {
    await dataSource.query('SELECT 1');
    if (await dataSource.showMigrations()) {
      return {
        check: 'database',
        code: 'DATABASE_MIGRATIONS_PENDING',
        message: 'Database migrations are not complete.'
      };
    }
    return null;
  } catch {
    return {
      check: 'database',
      code: 'DATABASE_UNAVAILABLE',
      message: 'PostgreSQL is unavailable or not ready.'
    };
  }
}

async function checkWorkspaceIdentity(options: StartupCheckOptions): Promise<StartupCheckFailure | null> {
  try {
    const workspace = await fs.lstat(options.workspaceRoot);
    if (workspace.isSymbolicLink()) {
      return {
        check: 'workspace',
        code: 'WORKSPACE_REPARSE_POINT',
        message: 'The configured workspace mount is a link or reparse point.'
      };
    }
    if (!workspace.isDirectory()) {
      return {
        check: 'workspace',
        code: 'WORKSPACE_NOT_DIRECTORY',
        message: 'The configured workspace mount is not a directory.'
      };
    }
    if (await fs.realpath(options.workspaceRoot) !== options.workspaceRoot) {
      return {
        check: 'workspace',
        code: 'WORKSPACE_REPARSE_POINT',
        message: 'The configured workspace mount does not resolve to its configured identity.'
      };
    }
    const markerStats = await fs.lstat(options.workspaceIdentityFile);
    if (markerStats.isSymbolicLink() || !markerStats.isFile()) {
      return {
        check: 'workspace',
        code: 'WORKSPACE_IDENTITY_UNAVAILABLE',
        message: 'The workspace identity marker is unavailable.'
      };
    }
    const marker = (await fs.readFile(options.workspaceIdentityFile, 'utf8')).trim();
    if (marker !== options.workspaceIdentity) {
      return {
        check: 'workspace',
        code: 'WORKSPACE_IDENTITY_MISMATCH',
        message: 'The workspace identity marker does not match the configured host identity.'
      };
    }
    return null;
  } catch {
    return {
      check: 'workspace',
      code: 'WORKSPACE_IDENTITY_UNAVAILABLE',
      message: 'The dedicated workspace mount or identity marker is unavailable.'
    };
  }
}

/** Local data remains usable when the optional AI bridge is offline. */
export async function runStartupChecks(options: StartupCheckOptions): Promise<void> {
  const failures = (await Promise.all([
    checkDatabase(options.dataSource),
    checkWorkspaceIdentity(options)
  ])).filter((failure): failure is StartupCheckFailure => failure !== null);
  if (failures.length > 0) throw new StartupChecksError(failures);
}
