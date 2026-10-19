import type { DataSource, EntityManager } from 'typeorm';

import { TypeOrmDemoAdmissionRepository } from '@/infrastructure/database/repositories/typeorm-demo-admission-repository';

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
