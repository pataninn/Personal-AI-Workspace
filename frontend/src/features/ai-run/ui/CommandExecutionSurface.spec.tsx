import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { userSessionReducer } from '@/entities/user-session';
import type { AiRunSnapshot, SandboxCommandSnapshot } from '@/entities/ai-run';
import { CommandExecutionSurface } from '@/features/ai-run/ui/CommandExecutionSurface';

const { getSandboxCommandsMock, getSandboxCommandMock, decideSandboxCommandMock, cancelSandboxCommandMock } = vi.hoisted(() => ({
  getSandboxCommandsMock: vi.fn(),
  getSandboxCommandMock: vi.fn(),
  decideSandboxCommandMock: vi.fn(),
  cancelSandboxCommandMock: vi.fn()
}));

vi.mock('@/entities/ai-run/api/sandbox-command-api', () => ({
  getSandboxCommands: getSandboxCommandsMock,
  getSandboxCommand: getSandboxCommandMock,
  decideSandboxCommand: decideSandboxCommandMock,
  cancelSandboxCommand: cancelSandboxCommandMock
}));

const RUN_ID = '77777777-7777-4777-8777-000000000001';
const COMMAND_ID = '88888888-8888-4888-8888-000000000001';
const HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const session = { status: 'authenticated' as const, principal: { id: 'user-1', displayName: 'Local user', accountKind: 'regular' as const, role: 'user' as const }, csrfToken: 'csrf-token', expiresAt: '2099-01-01T00:00:00.000Z', errorCode: null };
const limits = { wallTimeMs: 10_000, idleTimeMs: 5_000, maxOutputBytes: 32_768, maxProcesses: 4, memoryBytes: 134_217_728, cpuTimeMs: 5_000, network: 'denied' as const };

const run: AiRunSnapshot = {
  runId: RUN_ID,
  projectId: '11111111-1111-4111-8111-111111111111',
  conversationId: '44444444-4444-4444-8444-000000000001',
  status: 'ready',
  phase: 'runtime',
  manifestHash: HASH,
  decision: 'approved',
  safeMessage: 'Private run environment ready.',
  cleanup: 'not_started',
  providerTransmission: 'not_started_confirmed',
  stagingItemCount: 0,
  runtime: { kind: 'fake', sandboxReady: true }
};

const proposal: SandboxCommandSnapshot = {
  commandId: COMMAND_ID,
  runId: RUN_ID,
  proposalHash: HASH,
  command: 'rg',
  summary: 'Search the staged source tree',
  argumentCount: 2,
  argumentSummaries: ['TODO', 'src'],
  cwd: '.',
  classification: 'safe',
  decision: 'pending',
  status: 'awaiting_approval',
  limits,
  safeMessage: 'Review this command before it runs.',
  createdAt: '2026-09-16T00:00:00.000Z',
  updatedAt: '2026-09-16T00:00:00.000Z'
};

function renderSurface(readOnly = false): void {
  const store = configureStore({ reducer: { userSession: userSessionReducer }, preloadedState: { userSession: session } });
  render(<Provider store={store}><CommandExecutionSurface run={run} readOnly={readOnly} conversationHref="/projects/project/conversations/conversation" /></Provider>);
}

describe('CommandExecutionSurface', () => {
  beforeEach(() => {
    getSandboxCommandsMock.mockReset();
    getSandboxCommandMock.mockReset();
    decideSandboxCommandMock.mockReset();
    cancelSandboxCommandMock.mockReset();
    getSandboxCommandsMock.mockResolvedValue({ commands: [proposal] });
  });

  it('shows a legacy command for reference without a decision control', async () => {
    renderSurface();

    expect(await screen.findByRole('heading', { name: 'Legacy command is not resumed' })).toBeInTheDocument();
    expect(screen.getByTestId('command-boundary')).toHaveTextContent('never run on Windows');
    expect(screen.getByTestId('command-summary')).toHaveTextContent('rg TODO src');
    expect(screen.getByTestId('command-legacy-blocked')).toHaveTextContent('waiting for a decision that is no longer available');
    expect(screen.queryByTestId('command-approve')).not.toBeInTheDocument();
    expect(screen.queryByTestId('command-reject')).not.toBeInTheDocument();
    expect(decideSandboxCommandMock).not.toHaveBeenCalled();
  });

  it('keeps a running command cancellable and reports confirmed cancellation', async () => {
    const running = { ...proposal, decision: 'approved' as const, status: 'running' as const };
    const cancelled = { ...running, status: 'cancelled' as const, result: { exitCode: null, termination: 'cancelled' as const, durationMs: 1, outputBytes: 0, outputLineCount: 0, outputTruncated: false, outputSha256: HASH } };
    getSandboxCommandsMock.mockResolvedValue({ commands: [running] });
    cancelSandboxCommandMock.mockResolvedValue(cancelled);
    renderSurface();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('command-cancel'));

    await waitFor(() => expect(cancelSandboxCommandMock).toHaveBeenCalledWith(RUN_ID, COMMAND_ID, 'csrf-token', expect.any(String)));
    expect(await screen.findByTestId('command-cancelled')).toHaveTextContent('No result was promoted to the project');
  });

  it('reconciles a 202 cancellation with an explicit status refresh', async () => {
    const running = { ...proposal, decision: 'approved' as const, status: 'running' as const };
    const cancelRequested = { ...running, status: 'cancel_requested' as const, safeMessage: 'Stopping the private sandbox command.' };
    const cancelled = { ...cancelRequested, status: 'cancelled' as const, result: { exitCode: null, termination: 'cancelled' as const, durationMs: 1, outputBytes: 0, outputLineCount: 0, outputTruncated: false, outputSha256: HASH } };
    getSandboxCommandsMock.mockResolvedValueOnce({ commands: [running] }).mockResolvedValueOnce({ commands: [cancelled] });
    cancelSandboxCommandMock.mockResolvedValue(cancelRequested);
    renderSurface();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('command-cancel'));

    expect(await screen.findByTestId('command-cancel-refresh')).toBeInTheDocument();
    await user.click(screen.getByTestId('command-cancel-refresh'));

    expect(await screen.findByTestId('command-cancelled')).toHaveTextContent('No result was promoted to the project');
    expect(getSandboxCommandsMock).toHaveBeenCalledTimes(2);
  });

  it('keeps command cards visible but read-only for an archived project', async () => {
    renderSurface(true);

    expect(await screen.findByTestId('command-project-read-only')).toHaveTextContent('Existing sandbox commands are read-only');
    expect(screen.getByTestId('command-legacy-blocked')).toBeInTheDocument();
    expect(screen.queryByTestId('command-approve')).not.toBeInTheDocument();
  });

  it('renders a confirmed empty state instead of treating load failure as empty', async () => {
    getSandboxCommandsMock.mockResolvedValue({ commands: [] });
    renderSurface();

    expect(await screen.findByTestId('command-empty')).toHaveTextContent('No sandbox commands are recorded for this run.');
    expect(screen.queryByTestId('command-surface-error')).not.toBeInTheDocument();
  });
});
