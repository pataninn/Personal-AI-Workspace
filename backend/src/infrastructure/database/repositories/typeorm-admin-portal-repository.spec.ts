import type { DataSource, EntityManager } from 'typeorm';

import { TypeOrmAdminPortalRepository } from '@/infrastructure/database/repositories/typeorm-admin-portal-repository';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';

function transactionalRepository(query: jest.Mock): TypeOrmAdminPortalRepository {
  const manager = { query } as unknown as EntityManager;
  const dataSource = { transaction: jest.fn(async (action: (value: EntityManager) => Promise<unknown>) => action(manager)) } as unknown as DataSource;
  return new TypeOrmAdminPortalRepository(dataSource);
}

describe('TypeOrmAdminPortalRepository', () => {
  it('refuses to disable the last active administrator before changing users or revoking sessions', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('FROM "credit_runtime_policy"')) return [{ revision: '3' }];
      if (sql.includes('FROM "users"') && sql.includes('"role" = \'admin\'') && sql.includes('FOR UPDATE')) return [{ id: ADMIN_ID }];
      if (sql.includes('FROM "users"') && sql.includes('"account_kind"') && sql.includes('FOR UPDATE')) {
        return [{ id: ADMIN_ID, is_active: true, role: 'admin', account_kind: 'regular' }];
      }
      if (sql.includes('SELECT count(*)::text')) return [{ count: '1' }];
      return [];
    });
    const repository = transactionalRepository(query);

    await expect(repository.setAccountEnabled(ADMIN_ID, ADMIN_ID, false)).rejects.toMatchObject({ code: 'LAST_ACTIVE_ADMIN', statusCode: 409 });

    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE "users"'), expect.anything());
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE "sessions"'), expect.anything());
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO "admin_audit_events"'), expect.anything());
  });

  it('keeps existing daily settled and reserved counters unchanged when demo settings are updated', async () => {
    const policy = {
      revision: '4', inference_paused: true, demo_daily_limit_units: '500', demo_campaign_limit_units: '300', demo_campaign_id: 'campaign-a',
      demo_max_concurrent_calls: 1, demo_default_daily_limit_units: '1000', demo_default_lifetime_limit_units: '2500',
      demo_session_ttl_hours: 24, demo_global_admission_max: 100, demo_global_admission_window_seconds: 3600,
      demo_network_admission_max: 20, demo_network_admission_window_seconds: 900, demo_run_start_max: 30,
      demo_run_start_window_seconds: 3600, demo_settings_bootstrapped: true
    };
    let updateParameters: readonly unknown[] = [];
    const query = jest.fn(async (sql: string, parameters?: readonly unknown[]) => {
      if (sql.includes('FROM "credit_runtime_policy"') && sql.includes('FOR UPDATE')) return [policy];
      if (sql.includes('FROM "users"') && sql.includes('"role" = \'admin\'') && sql.includes('FOR UPDATE')) return [{ id: ADMIN_ID }];
      if (sql.includes('UPDATE "credit_runtime_policy"')) {
        updateParameters = parameters ?? [];
        return [{ ...policy, revision: '5', inference_paused: false }];
      }
      if (sql.includes('INSERT INTO "admin_audit_events"')) return [];
      if (sql.includes('FROM "credit_demo_daily_windows"')) return [{ settled_units: '80', reserved_units: '20' }];
      if (sql.includes('FROM "credit_demo_campaign_usage"')) return [{ settled_units: '50', reserved_units: '10' }];
      return [];
    });
    const repository = transactionalRepository(query);

    const result = await repository.updateDemoSettings(ADMIN_ID, {
      expectedRevision: 4, defaultDailyLimitUnits: '1000', defaultLifetimeLimitUnits: '2500', sessionTtlHours: 24,
      globalAdmissionMax: 100, globalAdmissionWindowSeconds: 3600, networkAdmissionMax: 20, networkAdmissionWindowSeconds: 900,
      runStartMax: 30, runStartWindowSeconds: 3600, maxConcurrentCalls: 1, globalDailyLimitUnits: '500',
      campaignId: 'campaign-a', campaignLimitUnits: '300', inferencePaused: false
    }) as { revision: number; inferencePaused: boolean; usage: { dailySettledUnits: string; dailyReservedUnits: string;
      campaignSettledUnits: string; campaignReservedUnits: string } };

    const updateCall = query.mock.calls.find(([sql]) => sql.includes('UPDATE "credit_runtime_policy"'));
    expect(updateCall?.[0]).toContain('WHERE "id" = 1 AND "revision" = $15 RETURNING *');
    expect(updateParameters[14]).toBe(4);
    expect(result).toMatchObject({ revision: 5, inferencePaused: false, usage: {
      dailySettledUnits: '80', dailyReservedUnits: '20', campaignSettledUnits: '50', campaignReservedUnits: '10'
    } });
    expect(query.mock.calls.filter(([sql]) => /(?:UPDATE|DELETE) "credit_(?:demo_daily_windows|demo_campaign_usage|reservations)"/u.test(sql))).toHaveLength(0);
  });

  it.each([
    ['changed', 'campaign-b', '300'],
    ['cleared', null, null]
  ] as const)('rejects a %s configured campaign ID without mutating settings, counters, or audit', async (_change, campaignId, campaignLimitUnits) => {
    const policy = {
      revision: '4', inference_paused: false, demo_daily_limit_units: '500', demo_campaign_limit_units: '300', demo_campaign_id: 'campaign-a',
      demo_max_concurrent_calls: 1, demo_default_daily_limit_units: '1000', demo_default_lifetime_limit_units: '2500',
      demo_session_ttl_hours: 24, demo_global_admission_max: 100, demo_global_admission_window_seconds: 3600,
      demo_network_admission_max: 20, demo_network_admission_window_seconds: 900, demo_run_start_max: 30,
      demo_run_start_window_seconds: 3600, demo_settings_bootstrapped: true
    };
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('FROM "credit_runtime_policy"') && sql.includes('FOR UPDATE')) return [policy];
      if (sql.includes('FROM "users"') && sql.includes('"role" = \'admin\'') && sql.includes('FOR UPDATE')) return [{ id: ADMIN_ID }];
      return [];
    });
    const repository = transactionalRepository(query);

    await expect(repository.updateDemoSettings(ADMIN_ID, {
      expectedRevision: 4, defaultDailyLimitUnits: '1000', defaultLifetimeLimitUnits: '2500', sessionTtlHours: 24,
      globalAdmissionMax: 100, globalAdmissionWindowSeconds: 3600, networkAdmissionMax: 20, networkAdmissionWindowSeconds: 900,
      runStartMax: 30, runStartWindowSeconds: 3600, maxConcurrentCalls: 1, globalDailyLimitUnits: '500',
      campaignId, campaignLimitUnits, inferencePaused: false
    })).rejects.toMatchObject({ code: 'DEMO_CAMPAIGN_ID_IMMUTABLE', statusCode: 409 });

    expect(query.mock.calls.some(([sql]) => /^\s*(?:UPDATE|INSERT|DELETE)\b/u.test(sql))).toBe(false);
    expect(query.mock.calls.some(([sql]) => /credit_demo_(?:daily_windows|campaign_usage|reservations)/u.test(sql))).toBe(false);
  });

  it('allows initial campaign configuration while no campaign identity exists', async () => {
    const policy = {
      revision: '4', inference_paused: false, demo_daily_limit_units: '500', demo_campaign_limit_units: null, demo_campaign_id: null,
      demo_max_concurrent_calls: 1, demo_default_daily_limit_units: '1000', demo_default_lifetime_limit_units: '2500',
      demo_session_ttl_hours: 24, demo_global_admission_max: 100, demo_global_admission_window_seconds: 3600,
      demo_network_admission_max: 20, demo_network_admission_window_seconds: 900, demo_run_start_max: 30,
      demo_run_start_window_seconds: 3600, demo_settings_bootstrapped: true
    };
    let updateParameters: readonly unknown[] = [];
    const query = jest.fn(async (sql: string, parameters?: readonly unknown[]) => {
      if (sql.includes('FROM "credit_runtime_policy"') && sql.includes('FOR UPDATE')) return [policy];
      if (sql.includes('FROM "users"') && sql.includes('"role" = \'admin\'') && sql.includes('FOR UPDATE')) return [{ id: ADMIN_ID }];
      if (sql.includes('UPDATE "credit_runtime_policy"')) {
        updateParameters = parameters ?? [];
        return [{ ...policy, revision: '5', demo_campaign_id: 'campaign-a', demo_campaign_limit_units: '300' }];
      }
      if (sql.includes('INSERT INTO "admin_audit_events"')) return [];
      if (sql.includes('FROM "credit_demo_daily_windows"')) return [{ settled_units: '0', reserved_units: '0' }];
      if (sql.includes('FROM "credit_demo_campaign_usage"')) return [];
      return [];
    });
    const repository = transactionalRepository(query);

    const result = await repository.updateDemoSettings(ADMIN_ID, {
      expectedRevision: 4, defaultDailyLimitUnits: '1000', defaultLifetimeLimitUnits: '2500', sessionTtlHours: 24,
      globalAdmissionMax: 100, globalAdmissionWindowSeconds: 3600, networkAdmissionMax: 20, networkAdmissionWindowSeconds: 900,
      runStartMax: 30, runStartWindowSeconds: 3600, maxConcurrentCalls: 1, globalDailyLimitUnits: '500',
      campaignId: 'campaign-a', campaignLimitUnits: '300', inferencePaused: false
    }) as { campaignId: string; revision: number };

    expect(updateParameters[11]).toBe('campaign-a');
    expect(updateParameters[12]).toBe('300');
    expect(result).toMatchObject({ campaignId: 'campaign-a', revision: 5 });
  });
});
