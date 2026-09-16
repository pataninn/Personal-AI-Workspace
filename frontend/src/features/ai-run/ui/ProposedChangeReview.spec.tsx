import { configureStore } from '@reduxjs/toolkit';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { userSessionReducer } from '@/entities/user-session';
import type { ProposedChangeSetSnapshot } from '@/entities/ai-run';
import { ProposedChangeReview } from '@/features/ai-run/ui/ProposedChangeReview';

const { getProposedChangeSetMock, decideProposedChangeSetMock } = vi.hoisted(() => ({ getProposedChangeSetMock: vi.fn(), decideProposedChangeSetMock: vi.fn() }));
vi.mock('@/entities/ai-run/api/change-set-api', () => ({ getProposedChangeSet: getProposedChangeSetMock, decideProposedChangeSet: decideProposedChangeSetMock }));

const RUN_ID = '77777777-7777-4777-8777-000000000001';
const HASH = 'a'.repeat(64);
const session = { status: 'authenticated' as const, principal: { id: 'user-1', displayName: 'Local user' }, csrfToken: 'csrf-token', expiresAt: '2099-01-01T00:00:00.000Z', errorCode: null };
const operation = { operationId: '99999999-9999-4999-8999-000000000001', operation: 'delete' as const, path: 'src/old.ts', summary: 'Remove the old source file', expectedSourceHash: HASH, sourcePresent: true, destinationPresent: false, backupRequired: true, sizeBytes: 20, lineCount: 2, reviewable: true, preview: { text: '- old source', limited: false, kind: 'before' as const } };
const pending: ProposedChangeSetSnapshot = { runId: RUN_ID, projectId: '88888888-8888-4888-8888-000000000001', status: 'awaiting_approval', decision: 'pending', proposalHash: HASH, fakeRuntime: true, runtimeProvenance: 'fake_runtime_development_preview', counts: { total: 1, creates: 0, edits: 0, overwrites: 0, renames: 0, deletes: 1, destructive: 1 }, totalSizeBytes: 20, totalLineCount: 2, previewLimitBytes: 8192, previewLimitLines: 200, safeMessage: 'Review the proposed changes before applying them.', operations: [operation], createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z' };
const applied: ProposedChangeSetSnapshot = { ...pending, status: 'applied', decision: 'approved', safeMessage: 'The approved change set was applied and its result was saved.', result: { persisted: true, appliedCount: 1, skippedCount: 0, failedCount: 0, backupCount: 1, operations: [{ operationId: operation.operationId, operation: operation.operation, path: operation.path, status: 'applied', backup: 'created', safeMessage: 'Deleted after a recovery snapshot.' }] } };

function renderReview(readOnly = false): void {
  const store = configureStore({ reducer: { userSession: userSessionReducer }, preloadedState: { userSession: session } });
  render(<Provider store={store}><ProposedChangeReview runId={RUN_ID} readOnly={readOnly} conversationHref="/projects/p/conversations/c" /></Provider>);
}

describe('ProposedChangeReview', () => {
  beforeEach(() => { getProposedChangeSetMock.mockReset(); decideProposedChangeSetMock.mockReset(); getProposedChangeSetMock.mockResolvedValue(pending); decideProposedChangeSetMock.mockResolvedValue(applied); });

  it('shows bounded operation metadata and requires confirmation for destructive apply', async () => {
    renderReview();
    expect(await screen.findByTestId('change-set-summary')).toHaveTextContent('Awaiting your decision');
    expect(screen.getByTestId('change-operation-path')).toHaveTextContent('src/old.ts');
    const user = userEvent.setup();
    await user.click(screen.getByTestId('change-approve'));
    expect(await screen.findByTestId('change-apply-dialog')).toHaveTextContent('recheck the file versions');
    expect(decideProposedChangeSetMock).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('change-apply-confirm'));
    await waitFor(() => expect(decideProposedChangeSetMock).toHaveBeenCalledWith(RUN_ID, HASH, 'approve', 'csrf-token', expect.any(String)));
  });

  it('renders persisted apply results and keeps archived review read-only', async () => {
    renderReview(true);
    expect(await screen.findByTestId('change-review-read-only')).toHaveTextContent('cannot be applied');
    expect(screen.getByTestId('change-approve')).toBeDisabled();
    expect(screen.getByTestId('change-reject')).toBeDisabled();
    expect(screen.queryByTestId('change-apply-result')).not.toBeInTheDocument();
  });

  it('renders the exact fake provenance, operation counts, hashes, and labelled rename endpoints', async () => {
    const rename = { ...operation, operationId: 'rename-1', operation: 'rename' as const, path: 'src/old.ts', destinationPath: 'src/new.ts', destinationPresent: true, expectedDestinationHash: HASH, backupRequired: true };
    const fullSet: ProposedChangeSetSnapshot = { ...pending, operations: [{ ...operation, operationId: 'create-1', operation: 'create' as const, path: 'src/new.ts', sourcePresent: false, destinationPresent: false, backupRequired: false, expectedSourceHash: undefined }, { ...operation, operationId: 'edit-1', operation: 'edit' as const, path: 'src/edit.ts', backupRequired: false }, { ...operation, operationId: 'overwrite-1', operation: 'overwrite' as const, path: 'src/overwrite.ts' }, rename, operation], counts: { total: 5, creates: 1, edits: 1, overwrites: 1, renames: 1, deletes: 1, destructive: 3 } };
    getProposedChangeSetMock.mockResolvedValueOnce(fullSet);
    renderReview();

    expect(await screen.findByTestId('change-review-fake-mode-notice')).toHaveTextContent('Development preview - fake runtime. These proposed changes are simulated; live OpenShell, Hermes, and NVIDIA NIM provenance is not verified.');
    expect(screen.getByTestId('change-set-summary')).toHaveTextContent('Recovery snapshots required');
    expect(screen.getByTestId('change-proposal-freshness')).toHaveTextContent('Reviewed against the project version at proposal time.');
    expect(screen.getByTestId('change-proposal-version')).toHaveTextContent(HASH);
    await userEvent.setup().click(screen.getAllByRole('button', { name: /Rename file/u })[0]!);
    expect(screen.getByTestId('change-operation-detail')).toHaveTextContent(HASH);
    expect(screen.getAllByText('From').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('To').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('src/new.ts').length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the authoritative snapshot visible and busy while a refresh is pending or fails', async () => {
    let rejectRefresh: (error: Error) => void = () => undefined;
    getProposedChangeSetMock.mockResolvedValueOnce(pending).mockImplementationOnce(() => new Promise<ProposedChangeSetSnapshot>((_resolve, reject) => { rejectRefresh = reject; }));
    renderReview();
    expect(await screen.findByTestId('change-set-summary')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByTestId('change-refresh-status'));
    expect(screen.getByTestId('change-set-summary')).toBeInTheDocument();
    expect(screen.getByTestId('change-review-surface')).toHaveAttribute('aria-busy', 'true');
    rejectRefresh(new Error('offline'));
    await waitFor(() => expect(screen.getByTestId('change-refresh-error')).toBeInTheDocument());
    expect(screen.getByTestId('change-set-summary')).toBeInTheDocument();
  });

  it('does not require destructive confirmation for an empty-destination rename', async () => {
    const emptyRename = { ...operation, operation: 'rename' as const, path: 'src/old.ts', destinationPath: 'src/new.ts', destinationPresent: false, expectedDestinationHash: undefined, backupRequired: false };
    getProposedChangeSetMock.mockResolvedValueOnce({ ...pending, operations: [emptyRename], counts: { total: 1, creates: 0, edits: 0, overwrites: 0, renames: 1, deletes: 0, destructive: 0 } });
    renderReview();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('change-approve'));
    expect(screen.queryByTestId('change-apply-dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(decideProposedChangeSetMock).toHaveBeenCalledWith(RUN_ID, HASH, 'approve', 'csrf-token', expect.any(String)));
  });

  it('supports keyboard cancellation without approval and keeps raw secrets out of the DOM', async () => {
    const secret = 'token: private-ui-secret';
    const safeSet: ProposedChangeSetSnapshot = { ...pending, operations: [{ ...operation, preview: { text: 'token: [REDACTED]', limited: false, kind: 'before' } }] };
    getProposedChangeSetMock.mockResolvedValueOnce(safeSet);
    renderReview();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('change-approve'));
    expect(screen.getByTestId('change-apply-dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('change-apply-dialog')).not.toBeInTheDocument();
    expect(decideProposedChangeSetMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('change-review-surface')).not.toHaveTextContent(secret);
  });

  it('renders stale, known failure, rejected, applied, and manual-review states distinctly', async () => {
    const states: readonly ProposedChangeSetSnapshot['status'][] = ['stale', 'failed', 'rejected', 'applied', 'needs_manual_review'];
    for (const status of states) {
      cleanup();
      getProposedChangeSetMock.mockReset();
      getProposedChangeSetMock.mockResolvedValueOnce({ ...pending, status, decision: status === 'rejected' ? 'rejected' : status === 'applied' ? 'approved' : 'pending' });
      renderReview();
      await screen.findByTestId('change-decision-status');
      if (status === 'stale') expect(screen.getByTestId('change-stale')).toBeInTheDocument();
      if (status === 'failed') expect(screen.getByTestId('change-failure')).toBeInTheDocument();
      if (status === 'rejected') expect(screen.getByTestId('change-rejected')).toBeInTheDocument();
      if (status === 'applied') expect(screen.getByTestId('change-applied')).toHaveTextContent('Changes applied');
      if (status === 'needs_manual_review') {
        expect(screen.getByTestId('change-review-required')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Refresh apply status' })).toBeInTheDocument();
      }
    }
  });

  it('shows a separate recovery snapshot result for every backed-up operation', async () => {
    getProposedChangeSetMock.mockResolvedValueOnce(applied);
    renderReview();
    expect(await screen.findByTestId('change-recovery-snapshot-results')).toBeInTheDocument();
    expect(screen.getByTestId('change-recovery-snapshot-result')).toHaveTextContent('Recovery snapshot created for src/old.ts.');
  });
});
