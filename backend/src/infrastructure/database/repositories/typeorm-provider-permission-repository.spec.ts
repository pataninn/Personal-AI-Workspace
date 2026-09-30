import type { DataSource, QueryRunner } from 'typeorm';

import { TypeOrmProviderPermissionRepository } from '@/infrastructure/database/repositories/typeorm-provider-permission-repository';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const PERMISSION_ID = '33333333-3333-4333-8333-333333333333';
const scope = { ownerId: OWNER_ID, projectId: PROJECT_ID, providerProfile: 'nvidia-hosted-nim', model: 'nvidia/nemotron-3-super-120b-a12b' } as const;

function permissionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PERMISSION_ID,
    owner_id: OWNER_ID,
    project_id: PROJECT_ID,
    provider_profile: scope.providerProfile,
    model: scope.model,
    capability: 'send_selected_context',
    created_at: new Date('2026-09-20T00:00:00.000Z'),
    expires_at: null,
    revoked_at: null,
    ...overrides
  };
}

describe('TypeOrmProviderPermissionRepository', () => {
  it('matches an active grant only for the signed-in owner, project, provider, and model', async () => {
    const query = jest.fn().mockResolvedValue([permissionRow()]);
    const repository = new TypeOrmProviderPermissionRepository({ query } as unknown as DataSource);

    const result = await repository.findActive(scope);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('"owner_id" = $1 AND "project_id" = $2 AND "provider_profile" = $3 AND "model" = $4'), [OWNER_ID, PROJECT_ID, scope.providerProfile, scope.model, 'send_selected_context']);
    expect(query.mock.calls[0]?.[0]).toContain('"revoked_at" IS NULL');
    expect(result).toMatchObject({ ownerId: OWNER_ID, projectId: PROJECT_ID, providerProfile: scope.providerProfile, model: scope.model, capability: 'send_selected_context', expiresAt: null });
  });

  it('creates one active permission per exact scope and reuses a concurrent active grant', async () => {
    const query = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([permissionRow()]);
    const repository = new TypeOrmProviderPermissionRepository({ query } as unknown as DataSource);

    await expect(repository.grant(scope)).resolves.toMatchObject({ id: PERMISSION_ID });

    expect(query.mock.calls[0]?.[0]).toContain('ON CONFLICT ("owner_id", "project_id", "provider_profile", "model", "capability")');
    expect(query.mock.calls[0]?.[0]).toContain('WHERE "revoked_at" IS NULL DO NOTHING');
    expect(query.mock.calls[1]?.[0]).toContain('"owner_id" = $1 AND "project_id" = $2');
  });

  it('revokes the selected permission and returns ready or queued, not-yet-transmitted runs to consent', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([permissionRow()])
      .mockResolvedValueOnce([permissionRow({ revoked_at: new Date('2026-09-21T00:00:00.000Z') })])
      .mockResolvedValueOnce([]);
    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      query,
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      isTransactionActive: true
    } as unknown as QueryRunner;
    const repository = new TypeOrmProviderPermissionRepository({ createQueryRunner: () => queryRunner } as unknown as DataSource);

    await expect(repository.revoke({ ownerId: OWNER_ID, projectId: PROJECT_ID, permissionId: PERMISSION_ID })).resolves.toMatchObject({ revokedAt: expect.any(Date) });

    expect(query.mock.calls[2]?.[0]).toContain('"provider_permission_id" = $3');
    expect(query.mock.calls[2]?.[0]).toContain('"status" IN (\'ready\', \'queued\') AND "provider_transmission" = \'not_started_confirmed\'');
    expect(query.mock.calls[2]?.[0]).toContain('"start_idempotency_key" = NULL');
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('lists only records from the requested owner and project', async () => {
    const query = jest.fn().mockResolvedValue([permissionRow()]);
    const repository = new TypeOrmProviderPermissionRepository({ query } as unknown as DataSource);

    await repository.listForProjectOwner({ ownerId: OWNER_ID, projectId: PROJECT_ID });

    expect(query.mock.calls[0]?.[0]).toContain('WHERE "owner_id" = $1 AND "project_id" = $2');
    expect(query.mock.calls[0]?.[1]).toEqual([OWNER_ID, PROJECT_ID]);
  });
});
