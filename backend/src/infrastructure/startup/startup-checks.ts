import { promises as fs } from 'node:fs';

import type { DataSource } from 'typeorm';

import type { OpenShellGatewayClient } from '@/infrastructure/sandbox/openshell-gateway-client';
import {
  StartupChecksError,
  type StartupCheckFailure
} from '@/shared/errors/app-error';

export interface StartupCheckOptions {
  readonly dataSource: DataSource;
  readonly workspaceRoot: string;
  readonly workspaceIdentityFile: string;
  readonly workspaceIdentity: string;
  readonly gatewayClient: OpenShellGatewayClient;
  readonly nimProfile: string;
  readonly nimModel: string;
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

async function checkOpenShell(gatewayClient: OpenShellGatewayClient): Promise<StartupCheckFailure | null> {
  try {
    await gatewayClient.checkHealth();
    return null;
  } catch (error: unknown) {
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'OPENSHELL_UNAVAILABLE';
    return {
      check: 'openshell',
      code,
      message: 'The authenticated OpenShell gateway is unavailable.'
    };
  }
}

async function checkNim(options: StartupCheckOptions): Promise<StartupCheckFailure | null> {
  try {
    const readiness = await options.gatewayClient.getNimReadiness();
    if (!readiness.ready || readiness.provider !== options.nimProfile || readiness.model !== options.nimModel) {
      return {
        check: 'nim',
        code: 'NIM_PROFILE_UNAVAILABLE',
        message: 'The configured NVIDIA NIM provider profile is not ready.'
      };
    }
    return null;
  } catch (error: unknown) {
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'NIM_PROFILE_UNAVAILABLE';
    return {
      check: 'nim',
      code,
      message: 'The configured NVIDIA NIM provider profile is unavailable.'
    };
  }
}

export async function runStartupChecks(options: StartupCheckOptions): Promise<void> {
  const failures = (await Promise.all([
    checkDatabase(options.dataSource),
    checkWorkspaceIdentity(options),
    checkOpenShell(options.gatewayClient),
    checkNim(options)
  ])).filter((failure): failure is StartupCheckFailure => failure !== null);
  if (failures.length > 0) {
    throw new StartupChecksError(failures);
  }
}
