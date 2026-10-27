import { toHomeTurn, type HomeTurnRow } from '@/infrastructure/database/repositories/home-conversation-persistence-mappers';

const row: HomeTurnRow = {
  id: '33333333-3333-4333-8333-333333333333', owner_id: '11111111-1111-4111-8111-111111111111',
  conversation_id: '22222222-2222-4222-8222-222222222222', sequence: '2', request_key: 'turn-2', status: 'running',
  home_policy_revision: '9223372036854775807', workspace_policy_revision: '8',
  created_at: '2026-10-19T00:00:00.000Z', updated_at: '2026-10-19T00:00:01.000Z'
};

describe('toHomeTurn', () => {
  it('preserves decimal policy revisions exactly for automatic execution binding', () => {
    expect(toHomeTurn(row)).toMatchObject({
      sequence: 2, homePolicyRevision: '9223372036854775807', workspacePolicyRevision: '8'
    });
  });

  it('maps absent revision columns to an unbound legacy turn', () => {
    const { home_policy_revision: _homePolicyRevision, workspace_policy_revision: _workspacePolicyRevision, ...legacy } = row;

    expect(toHomeTurn(legacy)).toMatchObject({ homePolicyRevision: null, workspacePolicyRevision: null });
  });
});
