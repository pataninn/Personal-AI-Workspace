import type { DataSource, EntityManager } from 'typeorm';

import { TypeOrmDemoAdmissionRepository } from '@/infrastructure/database/repositories/typeorm-demo-admission-repository';
import { DEFAULT_DEMO_STORAGE_LIMIT_BYTES } from '@/modules/demo/domain/demo-storage-policy';
import { assertStorageAdmission } from '@/modules/storage-quotas/domain/storage-quota-policy';

function fixture() {
  let bootstrapped = false;
  const query = jest.fn(async (sql: string, parameters?: readonly unknown[]) => {
    if (sql.includes('SELECT "demo_settings_bootstrapped"')) return [{ demo_settings_bootstrapped: bootstrapped }];
    if (sql.includes('UPDATE "credit_runtime_policy"')) {
      bootstrapped = true;
      return [];
    }
    return [];
  });
  const manager = { query } as unknown as EntityManager;
  const dataSource = { transaction: jest.fn(async (action: (value: EntityManager) => Promise<unknown>) => action(manager)) } as unknown as DataSource;
  return { repository: new TypeOrmDemoAdmissionRepository(dataSource), query };
}

describe('TypeOrmDemoAdmissionRepository bootstrap', () => {
  it('persists a finite storage allowance even when demo AI credit defaults are zero', async () => {
    const ownerId = '11000000-0000-4000-8000-000000000001';
    const expiresAt = new Date(Date.now() + 86_400_000);
    const query = jest.fn(async (sql: string, _parameters?: readonly unknown[]) => {
      if (sql.includes('SELECT * FROM "credit_runtime_policy"')) return [{
        demo_settings_bootstrapped: true, demo_session_ttl_hours: 24,
        demo_global_admission_max: 40, demo_global_admission_window_seconds: 3600,
        demo_network_admission_max: 5, demo_network_admission_window_seconds: 3600,
        demo_run_start_max: 10, demo_run_start_window_seconds: 3600,
        demo_default_daily_limit_units: '0', demo_default_lifetime_limit_units: '0'
      }];
      if (sql.includes('FROM "showcase_publication"')) return [{ version_id: '11000000-0000-4000-8000-000000000003' }];
      if (sql.includes('INSERT INTO "demo_admission_counters"')) return [{ count: 0, max_count: 40, window_start: new Date() }];
      if (sql.includes('AS "mismatched"')) return [{ mismatched: false }];
      if (sql.includes('AS "exists"')) return [{ exists: false }];
      if (sql.includes('UPDATE "demo_admission_counters"')) return [{ count: 1 }];
      if (sql.includes('INSERT INTO "users"')) return [{ id: ownerId, display_name: 'Demo workspace', expires_at: expiresAt }];
      if (sql.includes('UPDATE "demo_admissions"')) return [{ id: '11000000-0000-4000-8000-000000000002', owner_id: ownerId, status: 'pending', expires_at: expiresAt }];
      return [];
    });
    const manager = { query } as unknown as EntityManager;
    const dataSource = { transaction: async (action: (value: EntityManager) => Promise<unknown>) => action(manager) } as unknown as DataSource;
    const result = await new TypeOrmDemoAdmissionRepository(dataSource).beginAdmission({
      requestDigest: 'a'.repeat(64), networkHash: 'b'.repeat(64), networkKeyId: 'c'.repeat(16)
    });
    expect(result.kind).toBe('created');
    const write = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO "account_limits"'));
    expect(write?.[0]).toContain('"storage_limit_bytes"');
    expect(write?.[1]).toEqual([ownerId, '0', '0', true, DEFAULT_DEMO_STORAGE_LIMIT_BYTES.toString()]);
    expect(() => assertStorageAdmission({ state: 'ready', usedBytes: DEFAULT_DEMO_STORAGE_LIMIT_BYTES,
      reservedBytes: 0n, limitBytes: DEFAULT_DEMO_STORAGE_LIMIT_BYTES, requestedGrowthBytes: 1n })).toThrow();
  });

  it('copies validated admission windows and TTL into persisted policy only once', async () => {
    const { repository, query } = fixture();
    const config = {
      lifetimeHours: 24,
      limits: {
        globalAdmissionMax: 100, globalAdmissionWindowSeconds: 3600,
        networkAdmissionMax: 20, networkAdmissionWindowSeconds: 900,
        runStartMax: 30, runStartWindowSeconds: 3600
      }
    } as const;

    await repository.bootstrapSettings(config);
    await repository.bootstrapSettings({ ...config, lifetimeHours: 12 });

    const writes = query.mock.calls.filter(([sql]) => sql.includes('UPDATE "credit_runtime_policy"'));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[1]).toEqual([24, 100, 3600, 20, 900, 30, 3600]);
  });

  it('persists invalid deployment defaults as unavailable instead of silently inventing limits', async () => {
    const { repository, query } = fixture();

    await repository.bootstrapSettings({
      lifetimeHours: 100,
      limits: {
        globalAdmissionMax: 10, globalAdmissionWindowSeconds: 60,
        networkAdmissionMax: 5, networkAdmissionWindowSeconds: 120,
        runStartMax: 8, runStartWindowSeconds: 60
      }
    });

    const write = query.mock.calls.find(([sql]) => sql.includes('UPDATE "credit_runtime_policy"'));
    expect(write?.[1]).toEqual([null, null, null, null, null, null, null]);
  });
});
