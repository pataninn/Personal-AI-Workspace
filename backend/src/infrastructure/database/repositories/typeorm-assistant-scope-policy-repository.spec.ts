import type { DataSource } from 'typeorm';

import { TypeOrmAssistantScopePolicyRepository } from '@/infrastructure/database/repositories/typeorm-assistant-scope-policy-repository';

describe('TypeOrmAssistantScopePolicyRepository', () => {
  it('synchronizes trusted deployment config, fills only empty live policies, and leaves prior non-null grants pinned', async () => {
    const managerQuery = jest.fn().mockResolvedValue([]);
    const dataSource = {
      transaction: jest.fn(async (action: (manager: { query: typeof managerQuery }) => Promise<void>) => action({ query: managerQuery }))
    };
    const repository = new TypeOrmAssistantScopePolicyRepository(dataSource as unknown as DataSource);

    await repository.synchronizeProviderConfiguration({ providerProfile: 'nim', model: 'model-a' });

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(managerQuery).toHaveBeenCalledTimes(2);
    expect(managerQuery.mock.calls[0]?.[0]).toContain('UPDATE "assistant_policy_provider_configuration"');
    expect(managerQuery.mock.calls[1]?.[0]).toContain('"provider_profile" IS NULL AND "model" IS NULL');
    expect(managerQuery.mock.calls[1]?.[0]).toContain('"enabled" = true AND "revoked_at" IS NULL');
  });

  it('reads only the authenticated owner and exact scope', async () => {
    const query = jest.fn().mockResolvedValueOnce([policyRow({
      scope_kind: 'project',
      project_id: 'project-a',
      policy_profile: 'workspace_in_scope_v1'
    })]);
    const repository = new TypeOrmAssistantScopePolicyRepository({ query } as unknown as DataSource);

    const result = await repository.find({ ownerId: 'owner-a', scopeKind: 'project', projectId: 'project-a' });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('"owner_id" = $1 AND "scope_kind" = $2'), ['owner-a', 'project', 'project-a']);
    expect(result).toMatchObject({ ownerId: 'owner-a', projectId: 'project-a', revision: '9', enabled: true });
  });

  it('fills a provider pair only for an enabled, unrevoked row that is still unconfigured', async () => {
    const query = jest.fn().mockResolvedValueOnce([policyRow({ revision: '10', provider_profile: 'nim', model: 'model-a' })]);
    const repository = new TypeOrmAssistantScopePolicyRepository({ query } as unknown as DataSource);

    const result = await repository.fillConfiguredProvider({
      scope: { ownerId: 'owner-a', scopeKind: 'home', projectId: null },
      providerProfile: 'nim',
      model: 'model-a'
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('AND "enabled" = true AND "revoked_at" IS NULL');
    expect(query.mock.calls[0]?.[0]).toContain('AND "provider_profile" IS NULL AND "model" IS NULL');
    expect(query.mock.calls[0]?.[0]).toContain('"revision" = "revision" + 1');
    expect(result).toMatchObject({ providerProfile: 'nim', model: 'model-a', revision: '10' });
  });

  it('maps TypeORM PostgreSQL UPDATE RETURNING tuples for provider fill and revocation', async () => {
    const filled = policyRow({ provider_profile: 'nim', model: 'model-a', revision: '10' });
    const fillQuery = jest.fn().mockResolvedValueOnce([[filled], 1]);
    const fillRepository = new TypeOrmAssistantScopePolicyRepository({ query: fillQuery } as unknown as DataSource);
    await expect(fillRepository.fillConfiguredProvider({
      scope: { ownerId: 'owner-a', scopeKind: 'home', projectId: null },
      providerProfile: 'nim', model: 'model-a'
    })).resolves.toMatchObject({ providerProfile: 'nim', model: 'model-a', revision: '10' });

    const revoked = policyRow({ enabled: false, revoked_at: new Date('2026-10-19T00:00:00Z'), revision: '11' });
    const revokeQuery = jest.fn().mockResolvedValueOnce([[revoked], 1]);
    const revokeRepository = new TypeOrmAssistantScopePolicyRepository({ query: revokeQuery } as unknown as DataSource);
    await expect(revokeRepository.revoke({ ownerId: 'owner-a', scopeKind: 'home', projectId: null }))
      .resolves.toMatchObject({ enabled: false, revision: '11' });
  });

  it('does not fill an already configured policy or revive a revoked policy', async () => {
    const query = jest.fn().mockResolvedValueOnce([])
      .mockResolvedValueOnce([policyRow({ provider_profile: 'nim', model: 'old-model' })]);
    const repository = new TypeOrmAssistantScopePolicyRepository({ query } as unknown as DataSource);

    const result = await repository.fillConfiguredProvider({
      scope: { ownerId: 'owner-a', scopeKind: 'home', projectId: null },
      providerProfile: 'nim',
      model: 'new-model'
    });

    expect(result).toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('revokes once, increments the revision, and leaves repeated calls idempotent', async () => {
    const revoked = policyRow({ enabled: false, revoked_at: new Date('2026-10-19T00:00:00Z'), revision: '10' });
    const query = jest.fn().mockResolvedValueOnce([revoked]);
    const repository = new TypeOrmAssistantScopePolicyRepository({ query } as unknown as DataSource);

    const result = await repository.revoke({ ownerId: 'owner-a', scopeKind: 'home', projectId: null });

    expect(query.mock.calls[0]?.[0]).toContain('"revision" + 1 ELSE "revision" END');
    expect(result).toMatchObject({ enabled: false, revision: '10', revokedAt: new Date('2026-10-19T00:00:00Z') });
  });
});

function policyRow(overrides: Partial<{
  id: string; owner_id: string; scope_kind: 'home' | 'project'; project_id: string | null;
  policy_profile: 'home_in_scope_v1' | 'workspace_in_scope_v1'; provider_profile: string | null;
  model: string | null; enabled: boolean; revoked_at: Date | string | null; revision: string | number;
}> = {}) {
  const now = new Date('2026-10-19T00:00:00Z');
  return {
    id: 'policy-a', owner_id: 'owner-a', scope_kind: 'home' as const, project_id: null,
    policy_profile: 'home_in_scope_v1' as const, provider_profile: null, model: null,
    enabled: true, revoked_at: null, revision: '9', created_at: now, updated_at: now,
    ...overrides
  };
}
