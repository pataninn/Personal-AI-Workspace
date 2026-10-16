import { configureStore } from '@reduxjs/toolkit';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { projectReducer } from '@/entities/project';
import type { HomeConversationScope, HomeProposal, HomeProposalCommand, HomeProposalItem } from '@/entities/home-conversation';
import { HomePlanningRecords } from '@/features/home-chat/ui/HomePlanningRecords';
import type { HomePlanningRecordsController } from '@/features/home-chat/model/use-home-planning-records';

const PROPOSAL_ID = '11111111-1111-4111-8111-111111111111';
const ITEM_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';
const TURN_ID = '44444444-4444-4444-8444-444444444444';
const HOME_SCOPE: HomeConversationScope = { kind: 'home' };
const NOW = '2026-10-16T00:00:00.000Z';
const FIELD_PREFIX = `home-proposal-${ITEM_ID}`;

const taskUpdateItem = (command: Extract<HomeProposalCommand, { action: 'task.update' }>): HomeProposalItem => ({
  id: ITEM_ID,
  position: 0,
  action: 'task.update',
  command,
  deadlineResolution: null,
  state: 'ready',
  receiptId: null,
  resultCode: null
});

function renderProposal(command: Extract<HomeProposalCommand, { action: 'task.update' }>) {
  const editItem = vi.fn(async (_proposalId: string, _itemId: string, _changes: Readonly<Record<string, unknown>>) => undefined);
  const proposal: HomeProposal = {
    id: PROPOSAL_ID,
    sourceTurnId: TURN_ID,
    scope: HOME_SCOPE,
    state: 'review_required',
    revision: 1,
    acceptedRevision: null,
    acceptanceId: null,
    itemCount: 1,
    createdAt: NOW,
    updatedAt: NOW,
    items: [taskUpdateItem(command)]
  };
  const records: HomePlanningRecordsController = {
    receipts: [],
    proposals: [{ proposal, state: 'ready', error: null, busy: false, message: null, itemError: null }],
    proposalsState: 'ready',
    proposalsError: null,
    refreshReceipt: async () => undefined,
    undoReceipt: async () => undefined,
    editItem,
    removeItem: async () => undefined,
    acceptProposal: async () => undefined,
    resumeProposal: async () => undefined,
    cancelProposal: async () => undefined,
    retryProposals: () => undefined,
    refreshEvents: async () => undefined
  };
  const store = configureStore({ reducer: { project: projectReducer } });
  render(<Provider store={store}><MemoryRouter><HomePlanningRecords records={records} turnId={TURN_ID} scope={HOME_SCOPE} /></MemoryRouter></Provider>);
  return editItem;
}

describe('HomePlanningRecords task-update editor', () => {
  it.each([
    ['title', `${FIELD_PREFIX}-title`, 'Updated title', { title: 'Updated title' }],
    ['details', `${FIELD_PREFIX}-details`, 'New task details', { details: 'New task details' }],
    ['importance', `${FIELD_PREFIX}-importance`, 'medium', { importance: 'medium' }],
    ['deadline', `${FIELD_PREFIX}-deadline`, '2026-11-02', { deadline: '2026-11-02' }],
    ['subtasks', `${FIELD_PREFIX}-subtasks`, 'First step\nSecond step', { subtasks: [{ title: 'First step', completed: false }, { title: 'Second step', completed: false }] }]
  ])('submits only the changed %s field when it was omitted from the original update', async (_field, testId, value, expectedChanges) => {
    const editItem = renderProposal({ action: 'task.update', taskId: TASK_ID, expectedVersion: 3, title: 'Existing title' });
    const user = userEvent.setup();
    const field = screen.getByTestId(testId);

    if (testId.endsWith('-deadline')) {
      fireEvent.change(field, { target: { value } });
    } else if (testId.endsWith('-importance')) {
      await user.selectOptions(field, value);
    } else {
      if (testId.endsWith('-title')) await user.clear(field);
      await user.type(field, value);
    }
    await user.click(screen.getByTestId(`home-proposal-edit-${ITEM_ID}`));

    expect(editItem).toHaveBeenCalledTimes(1);
    expect(editItem).toHaveBeenCalledWith(PROPOSAL_ID, ITEM_ID, expectedChanges);
  });

  it('shows only Status for a status-only update and submits only the selected status', async () => {
    const editItem = renderProposal({ action: 'task.update', taskId: TASK_ID, expectedVersion: 3, status: 'todo' });
    const user = userEvent.setup();

    expect(screen.getByTestId(`${FIELD_PREFIX}-status`)).toBeInTheDocument();
    for (const field of ['title', 'details', 'importance', 'deadline', 'subtasks']) {
      expect(screen.queryByTestId(`${FIELD_PREFIX}-${field}`)).not.toBeInTheDocument();
    }

    await user.selectOptions(screen.getByTestId(`${FIELD_PREFIX}-status`), 'blocked');
    await user.click(screen.getByTestId(`home-proposal-edit-${ITEM_ID}`));

    expect(editItem).toHaveBeenCalledWith(PROPOSAL_ID, ITEM_ID, { status: 'blocked' });
  });
});
