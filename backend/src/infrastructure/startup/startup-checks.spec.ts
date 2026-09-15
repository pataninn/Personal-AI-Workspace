import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DataSource } from 'typeorm';

import { OpenShellGatewayClient } from '@/infrastructure/sandbox/openshell-gateway-client';
import { runStartupChecks, type StartupCheckOptions } from '@/infrastructure/startup/startup-checks';
import { StartupChecksError } from '@/shared/errors/app-error';

describe('runStartupChecks', () => {
  let workspaceDirectory: string;
  let dataSource: DataSource;
  let gatewayClient: OpenShellGatewayClient;

  beforeEach(async () => {
    workspaceDirectory = await mkdtemp(path.join(os.tmpdir(), 'pai-startup-'));
    await writeFile(path.join(workspaceDirectory, 'identity'), 'fixture-identity\n', 'utf8');
    dataSource = {
      query: jest.fn().mockResolvedValue([{ result: 1 }]),
      showMigrations: jest.fn().mockResolvedValue(false)
    } as unknown as DataSource;
    gatewayClient = {
      checkHealth: jest.fn().mockResolvedValue(undefined),
      getNimReadiness: jest.fn().mockResolvedValue({
        ready: true,
        provider: 'nvidia-hosted-nim',
        model: 'nvidia/nemotron-3-super-120b-a12b'
      })
    } as unknown as OpenShellGatewayClient;
  });

  afterEach(async () => {
    await rm(workspaceDirectory, { recursive: true, force: true });
  });

  function options(overrides: Partial<StartupCheckOptions> = {}): StartupCheckOptions {
    return {
      dataSource,
      workspaceRoot: workspaceDirectory,
      workspaceIdentityFile: path.join(workspaceDirectory, 'identity'),
      workspaceIdentity: 'fixture-identity',
      gatewayClient,
      nimProfile: 'nvidia-hosted-nim',
      nimModel: 'nvidia/nemotron-3-super-120b-a12b',
      ...overrides
    };
  }

  it('passes only when all four foundation checks pass', async () => {
    await expect(runStartupChecks(options())).resolves.toBeUndefined();
    expect(dataSource.query).toHaveBeenCalledWith('SELECT 1');
    expect(gatewayClient.checkHealth).toHaveBeenCalledTimes(1);
    expect(gatewayClient.getNimReadiness).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a workspace identity mismatch', async () => {
    await expect(runStartupChecks(options({ workspaceIdentity: 'different' }))).rejects.toMatchObject({
      failures: expect.arrayContaining([
        expect.objectContaining({ check: 'workspace', code: 'WORKSPACE_IDENTITY_MISMATCH' })
      ])
    });
  });

  it('reports pending migrations and an unavailable NIM profile', async () => {
    (dataSource.showMigrations as jest.Mock).mockResolvedValue(true);
    (gatewayClient.getNimReadiness as jest.Mock).mockResolvedValue({
      ready: false,
      provider: 'nvidia-hosted-nim',
      model: 'nvidia/nemotron-3-super-120b-a12b'
    });

    const error = await runStartupChecks(options()).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(StartupChecksError);
    expect((error as StartupChecksError).failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ check: 'database', code: 'DATABASE_MIGRATIONS_PENDING' }),
      expect.objectContaining({ check: 'nim', code: 'NIM_PROFILE_UNAVAILABLE' })
    ]));
  });

  it('fails closed when the marker cannot be read', async () => {
    await rm(path.join(workspaceDirectory, 'identity'));
    await expect(runStartupChecks(options())).rejects.toMatchObject({
      failures: expect.arrayContaining([
        expect.objectContaining({ check: 'workspace', code: 'WORKSPACE_IDENTITY_UNAVAILABLE' })
      ])
    });
  });
});
