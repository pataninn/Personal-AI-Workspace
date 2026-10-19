import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { HomeProposal } from '@/entities/home-conversation';
import { HomePlanningRecords } from '@/features/home-chat/ui/HomePlanningRecords';
import type { HomePlanningRecordsController } from '@/features/home-chat/model/use-home-planning-records';

const PROPOSAL_ID = '11111111-1111-4111-8111-111111111111';
const ITEM_ID = '22222222-2222-4222-8222-222222222222';
const TURN_ID = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-10-16T00:00:00.000Z';

function makeProposal(state: HomeProposal['state']): HomeProposal {
  return {
    id: PROPOSAL_ID, sourceTurnId: TURN_ID, scope: { kind: 'home' }, state, revision: 1,
    acceptedRevision: state === 'review_required' ? null : 1,
    acceptanceId: state === 'review_required' ? null : '33333333-3333-4333-8333-333333333333',
    itemCount: 1, createdAt: NOW, updatedAt: NOW,
    items: [{
      id: ITEM_ID, position: 0, action: 'task.create',
      command: { action: 'task.create', taskId: '55555555-5555-4555-8555-555555555555', title: 'Prepare release checklist', details: null, workspaceId: null, importance: 'medium', deadline: null, subtasks: [] },
      deadlineResolution: null, state: state === 'review_required' ? 'ready' : 'executing', receiptId: null, resultCode: null
    }]
  };
}

function renderProposal(proposalState: HomeProposal['state']): void {
  const records: HomePlanningRecordsController = {
    receipts: [],
    proposals: [{ proposal: makeProposal(proposalState), state: 'ready', error: null, busy: false, message: null, itemError: null }],
    proposalsState: 'ready', proposalsError: null,
    refreshReceipt: vi.fn(async () => undefined), undoReceipt: vi.fn(async () => undefined), retryProposals: vi.fn()
  };
  render(<MemoryRouter><HomePlanningRecords records={records} turnId={TURN_ID} allowUndo={false} /></MemoryRouter>);
}

describe('HomePlanningRecords', () => {
  it('keeps saved previews visible without edit, remove, apply, or resume controls', () => {
    renderProposal('review_required');

    expect(screen.getByText('This saved preview is read-only and cannot be applied or resumed.')).toBeInTheDocument();
    expect(screen.getByText('Prepare release checklist')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /apply these changes|save item|remove from plan|resume eligible changes|cancel remaining changes/iu })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('shows previously accepted work as blocked history without continuation controls', () => {
    renderProposal('accepted');

    expect(screen.getByText('Legacy accepted · blocked')).toBeInTheDocument();
    expect(screen.getByText('Legacy action · blocked')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /apply|resume|cancel remaining/iu })).not.toBeInTheDocument();
  });
});
