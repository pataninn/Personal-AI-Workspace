import { configureStore } from '@reduxjs/toolkit';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { userSessionReducer } from '@/entities/user-session';
import type { ProjectFact } from '@/entities/project-fact';
import { ApiClientError } from '@/shared/api';
import { ProjectMemoryManager } from '@/features/project-memory/ui/ProjectMemoryManager';
const { getContextMock, updateContextMock } = vi.hoisted(() => ({ getContextMock: vi.fn(), updateContextMock: vi.fn() }));
vi.mock('@/entities/project/api/project-chat-context-api', () => ({ getProjectChatContext: getContextMock, updateProjectChatContext: updateContextMock }));

const { listFactsMock, createFactMock, updateFactMock, verifyFactMock, deleteFactMock } = vi.hoisted(() => ({
  listFactsMock: vi.fn(),
  createFactMock: vi.fn(),
  updateFactMock: vi.fn(),
  verifyFactMock: vi.fn(),
  deleteFactMock: vi.fn()
}));

vi.mock('@/entities/project-fact/api/project-fact-api', () => ({
  listProjectFacts: listFactsMock,
  createProjectFact: createFactMock,
  updateProjectFact: updateFactMock,
  verifyProjectFact: verifyFactMock,
  deleteProjectFact: deleteFactMock
}));

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const FACT_ID = '55555555-5555-4555-8555-000000000001';
const baseFact: ProjectFact = {
  id: FACT_ID,
  projectId: PROJECT_ID,
  title: 'Preferred language',
  content: 'This project uses TypeScript.',
  source: { kind: 'user', label: 'Added by you', reference: null },
  createdAt: '2026-09-26T00:00:00.000Z',
  updatedAt: '2026-09-26T00:00:00.000Z',
  version: 1,
  verifiedAt: null,
  verificationStatus: 'needs_review'
};

const session = {
  status: 'authenticated' as const,
  principal: { id: 'user-1', displayName: 'Local user', accountKind: 'regular' as const, role: 'user' as const },
  csrfToken: 'csrf-token',
  expiresAt: '2026-09-26T00:00:00.000Z',
  errorCode: null
};

function renderManager(archived = false, fileAccess = true): void {
  const store = configureStore({ reducer: { userSession: userSessionReducer }, preloadedState: { userSession: session } });
  render(<Provider store={store}><MemoryRouter><ProjectMemoryManager projectId={PROJECT_ID} projectName="Personal AI" archived={archived} fileAccess={fileAccess} /></MemoryRouter></Provider>);
}

describe('ProjectMemoryManager', () => {
  beforeEach(() => {
    getContextMock.mockReset().mockResolvedValue({ relativePaths: ['README.md'], factIds: [], includeProjectConversations: true });
    updateContextMock.mockReset().mockImplementation(async (_project, changes) => ({ relativePaths: ['README.md'], factIds: [], includeProjectConversations: true, ...changes }));
    listFactsMock.mockReset().mockResolvedValue([]);
    createFactMock.mockReset();
    updateFactMock.mockReset();
    verifyFactMock.mockReset();
    deleteFactMock.mockReset();
  });

  it('applies a checked memory fact to every chat without overwriting selected files', async () => {
    listFactsMock.mockResolvedValue([baseFact]);
    renderManager();
    const user = userEvent.setup();
    const checkbox = await screen.findByRole('checkbox', { name: `Use ${baseFact.title} in all chats` });
    await waitFor(() => expect(checkbox).toBeEnabled());
    await user.click(checkbox);
    await waitFor(() => expect(updateContextMock).toHaveBeenCalledWith(PROJECT_ID, { factIds: [FACT_ID] }, 'csrf-token'));
    expect(checkbox).toBeChecked();
  });

  it('keeps rootless project facts available without loading chat context or showing chat-selection controls', async () => {
    listFactsMock.mockResolvedValueOnce([]).mockResolvedValue([baseFact]);
    createFactMock.mockResolvedValue(baseFact);
    renderManager(false, false);
    const user = userEvent.setup();

    expect(await screen.findByTestId('project-memory-empty')).toHaveTextContent('Add a fact to keep useful project information together.');
    expect(screen.getByText('Chat context selection is unavailable in planning workspaces. Saved facts remain available to review and edit.')).toBeInTheDocument();
    expect(getContextMock).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('project-memory-empty-add'));
    await user.type(screen.getByRole('textbox', { name: 'Fact name' }), baseFact.title);
    await user.type(screen.getByRole('textbox', { name: 'What should the assistant know?' }), baseFact.content);
    await user.click(screen.getByTestId('project-fact-save'));

    await waitFor(() => expect(createFactMock).toHaveBeenCalledWith(PROJECT_ID, { title: baseFact.title, content: baseFact.content }, 'csrf-token'));
    expect(await screen.findByText(baseFact.title)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: `Use ${baseFact.title} in all chats` })).not.toBeInTheDocument();
    expect(getContextMock).not.toHaveBeenCalled();
  });

  it('shows a tick while saving and restores the saved selection if the request fails', async () => {
    listFactsMock.mockResolvedValue([baseFact]);
    let rejectSave: (error: Error) => void = () => { throw new Error('Save did not start'); };
    updateContextMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject; }));
    renderManager();
    const checkbox = await screen.findByRole('checkbox', { name: `Use ${baseFact.title} in all chats` });
    await waitFor(() => expect(checkbox).toBeEnabled());
    await userEvent.setup().click(checkbox);
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeDisabled();
    await act(async () => { rejectSave(new Error('Unavailable')); });
    await waitFor(() => expect(checkbox).not.toBeChecked());
    expect(checkbox).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Your previous selection is still in use');
  });

  it('creates a fact through an explicitly submitted form and refreshes server state', async () => {
    listFactsMock.mockResolvedValueOnce([]).mockResolvedValue([baseFact]);
    createFactMock.mockResolvedValue(baseFact);
    renderManager();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('project-memory-empty-add'));
    await user.type(screen.getByRole('textbox', { name: 'Fact name' }), baseFact.title);
    await user.type(screen.getByRole('textbox', { name: 'What should the assistant know?' }), baseFact.content);
    await user.click(screen.getByTestId('project-fact-save'));

    await waitFor(() => expect(createFactMock).toHaveBeenCalledWith(PROJECT_ID, { title: baseFact.title, content: baseFact.content }, 'csrf-token'));
    expect(await screen.findByText(baseFact.title)).toBeInTheDocument();
    expect(screen.getByTestId('project-memory-announcement')).toHaveTextContent('Fact saved');
    expect(listFactsMock).toHaveBeenCalledTimes(2);
  });

  it('shows source and server verification state and applies a versioned review', async () => {
    const reviewed = { ...baseFact, version: 2, verifiedAt: '2026-09-26T00:02:00.000Z', verificationStatus: 'verified' as const };
    listFactsMock.mockResolvedValue([baseFact]);
    verifyFactMock.mockResolvedValue(reviewed);
    renderManager();
    const user = userEvent.setup();

    expect(await screen.findByText('Added by you')).toBeInTheDocument();
    expect(screen.getByText('Needs review')).toBeInTheDocument();
    await user.click(screen.getByTestId(`project-fact-review-${FACT_ID}`));

    await waitFor(() => expect(verifyFactMock).toHaveBeenCalledWith(PROJECT_ID, FACT_ID, 1, 'csrf-token'));
    expect(await screen.findByText(/Verified by you on/u)).toBeInTheDocument();
  });

  it('preserves drafts on a version conflict and requires an explicit choice', async () => {
    const latest = { ...baseFact, version: 2, title: 'Current language', content: 'The project uses TypeScript and React.' };
    const saved = { ...latest, version: 3, title: 'Preferred language', content: 'Keep TypeScript for the frontend.' };
    listFactsMock.mockResolvedValueOnce([baseFact]).mockResolvedValueOnce([latest]).mockResolvedValueOnce([saved]);
    updateFactMock.mockRejectedValueOnce(new ApiClientError(409, 'PROJECT_FACT_VERSION_CONFLICT', 'private details')).mockResolvedValueOnce(saved);
    renderManager();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId(`project-fact-edit-${FACT_ID}`));
    const content = screen.getByRole('textbox', { name: 'What should the assistant know?' });
    await user.clear(content);
    await user.type(content, 'Keep TypeScript for the frontend.');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByTestId('project-fact-version-conflict')).toHaveTextContent(latest.content);
    expect(screen.getByRole('textbox', { name: 'What should the assistant know?' })).toHaveValue('Keep TypeScript for the frontend.');
    await user.click(screen.getByTestId('project-fact-conflict-keep-editing'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateFactMock).toHaveBeenLastCalledWith(PROJECT_ID, FACT_ID, { title: baseFact.title, content: 'Keep TypeScript for the frontend.' }, 2, 'csrf-token'));
    expect(await screen.findByText('Fact saved')).toBeInTheDocument();
  });

  it('keeps unsaved edits open until the user confirms whether to discard them', async () => {
    listFactsMock.mockResolvedValue([baseFact]);
    renderManager();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId(`project-fact-edit-${FACT_ID}`));
    const content = screen.getByRole('textbox', { name: 'What should the assistant know?' });
    await user.clear(content);
    await user.type(content, 'Unsaved change');
    await user.click(screen.getByTestId('project-fact-editor-cancel'));
    await user.click(await screen.findByTestId('project-fact-discard-keep-editing'));

    expect(screen.getByTestId('project-fact-editor-dialog')).toBeInTheDocument();
    expect(content).toHaveValue('Unsaved change');
    await user.click(screen.getByTestId('project-fact-editor-cancel'));
    await user.click(await screen.findByTestId('project-fact-discard-confirm'));
    expect(screen.queryByTestId('project-fact-editor-dialog')).not.toBeInTheDocument();
  });

  it('blocks another save when a conflicted fact is no longer active', async () => {
    listFactsMock.mockResolvedValueOnce([baseFact]).mockResolvedValueOnce([]);
    updateFactMock.mockRejectedValueOnce(new ApiClientError(409, 'PROJECT_FACT_VERSION_CONFLICT', 'private details'));
    renderManager();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId(`project-fact-edit-${FACT_ID}`));
    const content = screen.getByRole('textbox', { name: 'What should the assistant know?' });
    await user.clear(content);
    await user.type(content, 'Updated value');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByTestId('project-fact-missing-conflict')).toBeInTheDocument();
    expect(screen.getByTestId('project-fact-save')).toBeDisabled();
    await user.click(screen.getByTestId('project-fact-missing-conflict-close'));
    await user.click(await screen.findByTestId('project-fact-discard-confirm'));

    expect(await screen.findByTestId('project-memory-empty')).toBeInTheDocument();
    expect(updateFactMock).toHaveBeenCalledTimes(1);
  });

  it('keeps archived project facts readable and disables changes', async () => {
    listFactsMock.mockResolvedValue([baseFact]);
    renderManager(true);

    expect(await screen.findByText(baseFact.content)).toBeInTheDocument();
    expect(screen.getByTestId('project-memory-archived-message')).toHaveTextContent('memory is available to review');
    expect(screen.getByTestId('project-memory-add')).toBeDisabled();
    expect(screen.getByTestId(`project-fact-edit-${FACT_ID}`)).toBeDisabled();
    expect(createFactMock).not.toHaveBeenCalled();
  });

  it('does not remove a fact until the user confirms deletion', async () => {
    listFactsMock.mockResolvedValue([baseFact]);
    deleteFactMock.mockResolvedValue(undefined);
    renderManager();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId(`project-fact-delete-${FACT_ID}`));
    expect(await screen.findByTestId('project-fact-delete-dialog')).toBeInTheDocument();
    await user.click(screen.getByTestId('project-fact-delete-cancel'));
    expect(deleteFactMock).not.toHaveBeenCalled();

    await user.click(screen.getByTestId(`project-fact-delete-${FACT_ID}`));
    await user.click(await screen.findByTestId('project-fact-delete-confirm'));
    await waitFor(() => expect(deleteFactMock).toHaveBeenCalledWith(PROJECT_ID, FACT_ID, 1, 'csrf-token'));
    await waitFor(() => expect(screen.queryByText(baseFact.title)).not.toBeInTheDocument());
  });

  it('closes a delete conflict when the fact is no longer active', async () => {
    listFactsMock.mockResolvedValueOnce([baseFact]).mockResolvedValueOnce([]);
    deleteFactMock.mockRejectedValueOnce(new ApiClientError(409, 'PROJECT_FACT_VERSION_CONFLICT', 'private details'));
    renderManager();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId(`project-fact-delete-${FACT_ID}`));
    await user.click(await screen.findByTestId('project-fact-delete-confirm'));

    expect(await screen.findByTestId('project-memory-announcement')).toHaveTextContent('This fact is no longer active');
    expect(screen.queryByTestId('project-fact-delete-dialog')).not.toBeInTheDocument();
    expect(await screen.findByTestId('project-memory-empty')).toBeInTheDocument();
    expect(deleteFactMock).toHaveBeenCalledTimes(1);
  });
});
