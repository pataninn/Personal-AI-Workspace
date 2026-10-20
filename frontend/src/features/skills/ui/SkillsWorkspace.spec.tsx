import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { Provider } from 'react-redux';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionAuthenticated, userSessionReducer } from '@/entities/user-session';
import { SkillsWorkspace } from '@/features/skills/ui/SkillsWorkspace';
import type { UserSkill } from '@/entities/skill';

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

  it('copies a read-only template into an editable private skill', async () => {
    const user = userEvent.setup();
    renderSkills();
    await user.click((await screen.findAllByRole('button', { name: 'Copy' }))[0]);
    expect(await screen.findByLabelText('Title')).toHaveValue('Plan my day');
    await user.clear(screen.getByLabelText('Title'));
    await user.type(screen.getByLabelText('Title'), 'My daily plan');
    await user.click(screen.getByRole('button', { name: 'Save skill' }));

    await waitFor(() => expect(mocks.createSkill).toHaveBeenCalledWith(expect.objectContaining({
      title: 'My daily plan', workspaceId: WORKSPACE_ID, declaredTools: ['home_task_read']
    }), 'csrf-token', expect.any(String)));
    expect(await screen.findByText('Skill saved as version 1.')).toBeInTheDocument();
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
