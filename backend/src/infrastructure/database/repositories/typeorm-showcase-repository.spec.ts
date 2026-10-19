import type { DataSource } from 'typeorm';

import { TypeOrmShowcaseRepository } from '@/infrastructure/database/repositories/typeorm-showcase-repository';

const VERSION_ID = '11111111-1111-4111-8111-111111111111';
const SKILL_ID = '22222222-2222-4222-8222-222222222222';
const publicSkill = {
  id: SKILL_ID,
  title: 'Plan my day',
  instructions: 'Review the task list.',
  declaredTools: ['home_task_read'] as const
};

describe('TypeOrmShowcaseRepository skill projection', () => {
  it('returns the sanitized persisted skill fields in the public current DTO', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{
        id: VERSION_ID,
        project_display: { name: 'Public project', objective: null },
        tasks: [],
        facts: [],
        skills: [publicSkill],
        published_at: '2026-10-19T00:00:00.000Z'
      }])
      .mockResolvedValueOnce([]);
    const repository = new TypeOrmShowcaseRepository({ query } as unknown as DataSource);

    await expect(repository.getCurrent()).resolves.toMatchObject({ skills: [publicSkill] });
  });

  it('persists only the generated public skill projection in the immutable showcase version', async () => {
    const manager = {
      query: jest.fn(async (sql: string, _parameters?: readonly unknown[]) => {
        if (sql.includes('SELECT "request_fingerprint"')) return [];
        if (sql.includes('count(DISTINCT "pinned_version_id")')) return [{ count: '0' }];
        if (sql.includes('INSERT INTO "showcase_versions"')) return [{ published_at: '2026-10-19T00:00:00.000Z' }];
        return [];
      })
    };
    const dataSource = {
      transaction: jest.fn(async (action: (transaction: typeof manager) => Promise<unknown>) => await action(manager))
    } as unknown as DataSource;
    const repository = new TypeOrmShowcaseRepository(dataSource, () => VERSION_ID);

    await repository.publish({
      adminId: '33333333-3333-4333-8333-333333333333',
      idempotencyDigest: 'a'.repeat(64),
      requestFingerprint: 'b'.repeat(64),
      snapshot: {
        project: { name: 'Public project', objective: null },
        tasks: [], facts: [], skills: [publicSkill], files: []
      },
      contentDigest: 'c'.repeat(64),
      snapshotBytes: 120,
      itemCount: 1,
      maxRetainedVersions: 3
    });

    const insert = manager.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO "showcase_versions"'));
    expect(insert?.[0]).toContain('"skills"');
    expect(insert?.[1]?.[4]).toBe(JSON.stringify([publicSkill]));
  });
});
