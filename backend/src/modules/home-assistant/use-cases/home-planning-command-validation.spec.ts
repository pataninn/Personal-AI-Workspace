import { HomeConversationInputInvalidError } from '@/modules/home-assistant/domain/home-conversation-errors';
import { HomeProposalInputInvalidError } from '@/modules/home-assistant/domain/home-planning-errors';
import { parseHomePlanningToolArgs, parseProposalToolArgs, resolveDeadline, resolveDeadlineWithProvenance } from '@/modules/home-assistant/use-cases/home-planning-command-validation';
import type { HomePlanningToolRequest } from '@/modules/home-assistant/repositories/home-planning-tool-request-handler';

function request(name: string, args: Readonly<Record<string, unknown>>): HomePlanningToolRequest {
  return {
    ownerId: '4a104444-4444-4444-8444-444444444444',
    conversationId: '4a105555-5555-4555-8555-555555555555',
    turnId: '4a106666-6666-4666-8666-666666666666',
    requestId: 'validation-test-request',
    name,
    args,
    scope: { kind: 'home' }
  };
}

describe('Home planning command validation', () => {
  it('requires exact direct-tool argument objects', () => {
    expect(() => parseHomePlanningToolArgs(request('home_create_task', { title: 'Valid title', projectRoot: '.' })))
      .toThrow(HomeConversationInputInvalidError);
    expect(() => parseHomePlanningToolArgs(request('home_exec', { command: 'never' })))
      .toThrow(HomeConversationInputInvalidError);
  });

  it('validates real calendar dates before passing them to canonical task commands', () => {
    expect(() => resolveDeadline({ kind: 'date', value: '2026-02-30' }, undefined))
      .toThrow(HomeConversationInputInvalidError);
    expect(resolveDeadline({ kind: 'date', value: '2026-10-16' }, undefined)).toBe('2026-10-16');
  });

  it('uses the configured timezone and UTC fallback for days-from-today', () => {
    const instant = new Date('2026-01-01T01:00:00.000Z');
    expect(resolveDeadline({ kind: 'days_from_today', days: 1 }, 'America/Los_Angeles', instant)).toBe('2026-01-01');
    expect(resolveDeadline({ kind: 'days_from_today', days: 1 }, undefined, instant)).toBe('2026-01-02');
    expect(() => resolveDeadline({ kind: 'days_from_today', days: 1 }, 'Not/A_Timezone', instant))
      .toThrow(HomeConversationInputInvalidError);
  });

  it('retains only server-owned timezone provenance for relative dates', () => {
    const instant = new Date('2026-01-01T01:00:00.000Z');
    expect(resolveDeadlineWithProvenance({ kind: 'days_from_today', days: 1 }, 'America/Los_Angeles', instant))
      .toEqual({ deadline: '2026-01-01', deadlineResolution: { timeZone: 'America/Los_Angeles', source: 'configured' } });
    expect(resolveDeadlineWithProvenance({ kind: 'days_from_today', days: 1 }, undefined, instant))
      .toEqual({ deadline: '2026-01-02', deadlineResolution: { timeZone: 'UTC', source: 'utc-fallback' } });
    expect(resolveDeadlineWithProvenance({ kind: 'date', value: '2026-10-16' }, undefined, instant))
      .toEqual({ deadline: '2026-10-16', deadlineResolution: null });
    expect(resolveDeadlineWithProvenance(null, undefined, instant))
      .toEqual({ deadline: null, deadlineResolution: null });
  });

  it('allows workspace references only inside bounded bulk commands', () => {
    expect(parseProposalToolArgs({ items: [
      { action: 'workspace.create', name: 'Launch Workspace' },
      { action: 'task.create', title: 'Launch task', workspaceId: { workspaceRef: 1 } }
    ] }).items[1]).toMatchObject({ action: 'task.create', workspaceId: { workspaceRef: 1 } });
    expect(() => parseHomePlanningToolArgs(request('home_create_task', {
      title: 'No forward refs in a direct command', workspaceId: { workspaceRef: 1 }
    }))).toThrow(HomeConversationInputInvalidError);
    expect(() => parseProposalToolArgs({ items: [
      { action: 'workspace.create', name: 'Launch Workspace' },
      { action: 'task.create', title: 'Out-of-range reference', workspaceId: { workspaceRef: 21 } }
    ] })).toThrow(HomeProposalInputInvalidError);
  });

  it('requires a status-only task update or a non-empty field patch', () => {
    expect(() => parseProposalToolArgs({ items: [
      { action: 'task.update', taskId: '4a107777-7777-4777-8777-777777777777', expectedVersion: 1 },
      { action: 'task.archive', taskId: '4a108888-8888-4888-8888-888888888888', expectedVersion: 1 }
    ] })).toThrow(HomeProposalInputInvalidError);
  });
});
