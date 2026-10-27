import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { Provider } from 'react-redux';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionAuthenticated, userSessionReducer } from '@/entities/user-session';
import { SkillsWorkspace } from '@/features/skills/ui/SkillsWorkspace';
import type { UserSkill } from '@/entities/skill';
import { ApiClientError } from '@/shared/api';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_WORKSPACE_ID = '44444444-4444-4444-8444-444444444444';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_CONVERSATION_ID = '55555555-5555-4555-8555-555555555555';

const mocks = vi.hoisted(() => ({
  listSkills: vi.fn(), listSkillTemplates: vi.fn(), listProjects: vi.fn(), createSkill: vi.fn(), updateSkill: vi.fn(),
  deleteSkill: vi.fn(), getSkill: vi.fn(), invokeSkill: vi.fn(), createHomeConversation: vi.fn(),
  getAssistantExecutionPolicy: vi.fn(), useAccountUsage: vi.fn()
}));

vi.mock('@/entities/skill', () => ({
  listSkills: mocks.listSkills, listSkillTemplates: mocks.listSkillTemplates, listProjects: mocks.listProjects,
  createSkill: mocks.createSkill, updateSkill: mocks.updateSkill, deleteSkill: mocks.deleteSkill, getSkill: mocks.getSkill, invokeSkill: mocks.invokeSkill
}));
vi.mock('@/entities/project', () => ({ listProjects: mocks.listProjects }));
vi.mock('@/entities/home-conversation', () => ({ createHomeConversation: mocks.createHomeConversation }));
vi.mock('@/entities/assistant-policy', () => ({ getAssistantExecutionPolicy: mocks.getAssistantExecutionPolicy }));
vi.mock('@/entities/account-usage', () => ({ useAccountUsage: mocks.useAccountUsage }));

const skill: UserSkill = {
  id: '33333333-3333-4333-8333-333333333333', workspaceId: null, title: 'Plan my day',
  instructions: 'Plan around the open tasks.', declaredTools: ['home_task_read'], enabled: true, version: 1,
  createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z'
};

function LocationReader(): React.JSX.Element {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

function renderSkills(): void {
  const store = configureStore({ reducer: { userSession: userSessionReducer } });
  store.dispatch(sessionAuthenticated({
    principal: { id: 'owner-1', displayName: 'Owner', accountKind: 'regular', role: 'user' },
    csrfToken: 'csrf-token', expiresAt: '2026-10-20T00:00:00.000Z'
  }));
  render(<Provider store={store}><MemoryRouter initialEntries={['/projects/11111111-1111-4111-8111-111111111111/skills']}><SkillsWorkspace projectId={WORKSPACE_ID} projectName="Planning workspace" archived={false} /><LocationReader /></MemoryRouter></Provider>);
}

describe('SkillsWorkspace', () => {
  beforeEach(() => {
    mocks.listSkills.mockReset().mockResolvedValue([]);
    mocks.listSkillTemplates.mockReset().mockResolvedValue([
      { id: 'plan-my-day', title: 'Plan my day', instructions: 'Review tasks and propose time blocks.', declaredTools: ['home_task_read'] },
      { id: 'daily-briefing', title: 'Daily briefing', instructions: 'Summarize current work.', declaredTools: ['home_task_read'] }
    ]);
    mocks.listProjects.mockReset().mockResolvedValue({ projects: [{
      id: WORKSPACE_ID, name: 'Planning workspace', slug: 'planning-workspace', objective: null,
      workspaceMode: 'planning', capabilities: { planning: true, fileAccess: false }, status: 'active', version: 1,
      createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z'
    }] });
    mocks.createSkill.mockReset().mockImplementation(async (request) => ({ ...skill, ...request, id: skill.id }));
    mocks.updateSkill.mockReset().mockResolvedValue(skill);
    mocks.deleteSkill.mockReset().mockResolvedValue(undefined);
    mocks.getSkill.mockReset();
    mocks.invokeSkill.mockReset().mockResolvedValue({ invocation: { id: 'invocation-1', state: 'accepted' } });
    mocks.createHomeConversation.mockReset().mockResolvedValue({ id: CONVERSATION_ID, replayed: false });
    mocks.getAssistantExecutionPolicy.mockReset().mockResolvedValue({
      scope: { kind: 'workspace', label: 'Planning workspace' },
      policy: { enabled: true, revision: 'rev-1', provider: { name: 'Configured provider', model: 'model' }, included: { categories: [], items: [] }, exclusionsEnforced: true, capabilities: ['home_task_read'] },
      fileAccess: false, readiness: { state: 'ready' }
    });
    mocks.useAccountUsage.mockReset().mockReturnValue({ state: { status: 'success', data: { availability: { status: 'available', canSubmit: true, reason: null } } }, refresh: vi.fn() });
  });

  it('opens the new skill editor as a focused modal and restores focus when dismissed', async () => {
    const user = userEvent.setup();
    renderSkills();
    const trigger = await screen.findByRole('button', { name: 'New skill' });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'New skill' });
    await waitFor(() => expect(within(dialog).getByLabelText('Title')).toHaveFocus());
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('opens existing skills in the same modal and returns focus to Edit after cancelling', async () => {
    const user = userEvent.setup();
    mocks.listSkills.mockResolvedValue([skill]);
    renderSkills();
    const trigger = await screen.findByRole('button', { name: 'Edit' });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Edit Plan my day' });
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Plan my day');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('copies a read-only template into an editable private skill', async () => {
    const user = userEvent.setup();
    renderSkills();
    await user.click((await screen.findAllByRole('button', { name: 'Copy' }))[0]);
    expect(await screen.findByRole('dialog', { name: 'New skill' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Title')).toHaveValue('Plan my day');
    await user.clear(screen.getByLabelText('Title'));
    await user.type(screen.getByLabelText('Title'), 'My daily plan');
    await user.click(screen.getByRole('button', { name: 'Save skill' }));

    await waitFor(() => expect(mocks.createSkill).toHaveBeenCalledWith(expect.objectContaining({
      title: 'My daily plan', workspaceId: WORKSPACE_ID, declaredTools: ['home_task_read']
    }), 'csrf-token', expect.any(String)));
    expect(await screen.findByText('Skill saved as version 1.')).toBeInTheDocument();
  });

  it('explains enabled-at-create and keeps the enabled control for saved skills', async () => {
    const user = userEvent.setup();
    mocks.listSkills.mockResolvedValue([skill]);
    renderSkills();
    await user.click(await screen.findByRole('button', { name: 'New skill' }));
    expect(screen.queryByRole('checkbox', { name: 'Enabled' })).not.toBeInTheDocument();
    expect(screen.getByText(/New skills are enabled when saved/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('checkbox', { name: 'Enabled' }));
    await user.click(screen.getByRole('button', { name: 'Save skill' }));
    await waitFor(() => expect(mocks.updateSkill).toHaveBeenCalledWith(skill.id, expect.objectContaining({ enabled: false }), 'csrf-token'));
  });

  it('preserves an editable draft after a definite rejection and uses a fresh request key', async () => {
    const user = userEvent.setup();
    const projects = await mocks.listProjects();
    mocks.listProjects.mockResolvedValue({ projects: [...projects.projects, { ...projects.projects[0], id: SECOND_WORKSPACE_ID, name: 'Archived workspace', status: 'archived' }] });
    mocks.createSkill.mockRejectedValueOnce(new ApiClientError(404, 'SKILL_WORKSPACE_NOT_FOUND', 'The selected workspace is unavailable.'));
    renderSkills();
    await user.click(await screen.findByRole('button', { name: 'New skill' }));
    expect(screen.queryByRole('option', { name: /Archived workspace/ })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Title'), 'Retained draft');
    await user.type(screen.getByLabelText('Instructions'), 'Read my tasks.');
    await user.click(screen.getByRole('button', { name: 'Save skill' }));
    await waitFor(() => expect(mocks.createSkill).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByLabelText('Workspace')).toBeEnabled());
    expect(screen.getByLabelText('Title')).toHaveValue('Retained draft');
    expect(screen.queryByRole('button', { name: 'Retry same save' })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Workspace'), '');
    await user.click(screen.getByRole('button', { name: 'Save skill' }));
    await waitFor(() => expect(mocks.createSkill).toHaveBeenCalledTimes(2));
    expect(mocks.createSkill.mock.calls[1]?.[0]).toMatchObject({ workspaceId: null, title: 'Retained draft', instructions: 'Read my tasks.' });
    expect(mocks.createSkill.mock.calls[1]?.[2]).not.toBe(mocks.createSkill.mock.calls[0]?.[2]);
  });

  it('preserves the exact frozen request and key after an uncertain create result', async () => {
    const user = userEvent.setup();
    mocks.createSkill.mockRejectedValueOnce(new Error('Lost response'));
    renderSkills();
    await user.click(await screen.findByRole('button', { name: 'New skill' }));
    await user.type(screen.getByLabelText('Title'), 'Uncertain draft');
    await user.type(screen.getByLabelText('Instructions'), 'Read my tasks.');
    await user.click(screen.getByRole('button', { name: 'Save skill' }));
    const retry = await screen.findByRole('button', { name: 'Retry same save' });
    expect(screen.getByLabelText('Title')).toBeDisabled();
    expect(screen.getByLabelText('Workspace')).toBeDisabled();
    await user.click(retry);
    await waitFor(() => expect(mocks.createSkill).toHaveBeenCalledTimes(2));
    expect(mocks.createSkill.mock.calls[1]).toEqual(mocks.createSkill.mock.calls[0]);
  });

  it('creates one workspace conversation and invokes Plan my day with the same saved target', async () => {
    const user = userEvent.setup();
    mocks.listSkills.mockResolvedValue([skill]);
    renderSkills();
    await user.click(await screen.findByRole('button', { name: /^Plan my day$/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run skill' })).toBeEnabled());
    await user.click(await screen.findByRole('button', { name: 'Run skill' }));

    await waitFor(() => expect(mocks.createHomeConversation).toHaveBeenCalledWith({ kind: 'workspace', workspaceId: WORKSPACE_ID }, 'Plan my day', 'csrf-token', expect.any(String)));
    expect(mocks.invokeSkill).toHaveBeenCalledWith(skill.id, {
      conversationId: CONVERSATION_ID, expectedVersion: 1, request: "Create today's plan."
    }, 'csrf-token', expect.any(String));
    expect(await screen.findByTestId('location')).toHaveTextContent(`/projects/${WORKSPACE_ID}/planning-chat?conversation=${CONVERSATION_ID}`);
  });

  it('retries an uncertain invocation with its original request even if the note is edited', async () => {
    const user = userEvent.setup();
    mocks.listSkills.mockResolvedValue([skill]);
    mocks.invokeSkill.mockRejectedValueOnce(new Error('response was lost')).mockResolvedValueOnce({ invocation: { id: 'invocation-1', state: 'accepted' } });
    renderSkills();
    await user.click(await screen.findByRole('button', { name: /^Plan my day$/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run skill' })).toBeEnabled());
    const note = screen.getByLabelText('Optional request');
    await user.type(note, 'The first submitted request');
    await user.click(screen.getByRole('button', { name: 'Run skill' }));
    await screen.findByRole('button', { name: 'Retry same run' });

    await user.clear(note);
    await user.type(note, 'A different request after the uncertain reply');
    expect(screen.getByText(/Retry repeats the request submitted on the first attempt/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry same run' }));

    await waitFor(() => expect(mocks.invokeSkill).toHaveBeenCalledTimes(2));
    const firstCall = mocks.invokeSkill.mock.calls[0];
    const retryCall = mocks.invokeSkill.mock.calls[1];
    expect(retryCall?.[1]).toEqual(firstCall?.[1]);
    expect(retryCall?.[2]).toBe(firstCall?.[2]);
    expect(retryCall?.[3]).toBe(firstCall?.[3]);
    expect(retryCall?.[1]).toMatchObject({ request: 'The first submitted request' });
  });

  it('starts a fresh invocation in a newly selected workspace after an uncertain run', async () => {
    const user = userEvent.setup();
    mocks.listSkills.mockResolvedValue([skill]);
    mocks.listProjects.mockResolvedValue({ projects: [
      { id: WORKSPACE_ID, name: 'Planning workspace', slug: 'planning-workspace', objective: null, workspaceMode: 'planning', capabilities: { planning: true, fileAccess: false }, status: 'active', version: 1, createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z' },
      { id: SECOND_WORKSPACE_ID, name: 'Second workspace', slug: 'second-workspace', objective: null, workspaceMode: 'planning', capabilities: { planning: true, fileAccess: false }, status: 'active', version: 1, createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z' }
    ] });
    mocks.createHomeConversation.mockImplementation(async (scope) => ({ id: scope.workspaceId === SECOND_WORKSPACE_ID ? SECOND_CONVERSATION_ID : CONVERSATION_ID, replayed: false }));
    mocks.invokeSkill.mockRejectedValueOnce(new Error('response was lost')).mockResolvedValueOnce({ invocation: { id: 'invocation-2', state: 'accepted' } });
    renderSkills();
    await user.click(await screen.findByRole('button', { name: /^Plan my day$/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run skill' })).toBeEnabled());
    await user.type(screen.getByLabelText('Optional request'), 'Request for workspace A');
    await user.click(screen.getByRole('button', { name: 'Run skill' }));
    await screen.findByRole('button', { name: 'Retry same run' });

    await user.selectOptions(screen.getByLabelText('Target workspace'), SECOND_WORKSPACE_ID);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run skill' })).toBeEnabled());
    const note = screen.getByLabelText('Optional request');
    await user.clear(note);
    await user.type(note, 'Request for workspace B');
    await user.click(screen.getByRole('button', { name: 'Run skill' }));

    await waitFor(() => expect(mocks.invokeSkill).toHaveBeenCalledTimes(2));
    const firstCall = mocks.invokeSkill.mock.calls[0];
    const secondCall = mocks.invokeSkill.mock.calls[1];
    expect(firstCall?.[1]).toMatchObject({ conversationId: CONVERSATION_ID, request: 'Request for workspace A' });
    expect(secondCall?.[1]).toMatchObject({ conversationId: SECOND_CONVERSATION_ID, request: 'Request for workspace B' });
    expect(secondCall?.[3]).not.toBe(firstCall?.[3]);
    expect(mocks.createHomeConversation).toHaveBeenNthCalledWith(2, { kind: 'workspace', workspaceId: SECOND_WORKSPACE_ID }, 'Plan my day', 'csrf-token', expect.any(String));
    expect(await screen.findByTestId('location')).toHaveTextContent(`/projects/${SECOND_WORKSPACE_ID}/planning-chat?conversation=${SECOND_CONVERSATION_ID}`);
  });

  it('keeps Run unavailable when policy readiness or credit availability is unknown', async () => {
    const user = userEvent.setup();
    mocks.listSkills.mockResolvedValue([skill]);
    mocks.getAssistantExecutionPolicy.mockResolvedValue({ scope: { kind: 'workspace', label: 'Planning workspace' }, policy: null, fileAccess: false, readiness: { state: 'unavailable', reasonCode: 'runtime_unverified' } });
    mocks.useAccountUsage.mockReturnValue({ state: { status: 'error', data: null }, refresh: vi.fn() });
    renderSkills();
    await user.click(await screen.findByRole('button', { name: /^Plan my day$/ }));
    expect(await screen.findByRole('button', { name: 'Run skill' })).toBeDisabled();
    expect(screen.getByText(/availability is unknown|could not be checked/i)).toBeInTheDocument();
    expect(mocks.createHomeConversation).not.toHaveBeenCalled();
    expect(mocks.invokeSkill).not.toHaveBeenCalled();
  });
});
