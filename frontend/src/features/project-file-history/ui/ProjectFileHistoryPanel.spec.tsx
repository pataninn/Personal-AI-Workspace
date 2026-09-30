import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectFileHistoryPanel } from '@/features/project-file-history/ui/ProjectFileHistoryPanel';
import type { ProjectFileHistoryItem, ProjectFileHistoryPage } from '@/entities/ai-run';

const { listProjectFileHistoryMock } = vi.hoisted(() => ({ listProjectFileHistoryMock: vi.fn() }));
vi.mock('@/entities/ai-run', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/entities/ai-run')>()), listProjectFileHistory: listProjectFileHistoryMock }));

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const item = {
  changeSetId: '22222222-2222-4222-8222-222222222222', projectId: PROJECT_ID, runId: '33333333-3333-4333-8333-333333333333', conversationId: '44444444-4444-4444-8444-444444444444',
  operationId: '55555555-5555-4555-8555-555555555555', operationIndex: 0, operation: 'edit' as const, matchedPath: 'src/app.ts', path: 'src/app.ts',
  summary: 'Update the app entry', changeSetStatus: 'stale', operationStatus: 'skipped' as const, backupStatus: 'created' as const,
  createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:01:00.000Z'
};
const secondItem = { ...item, operationId: '66666666-6666-4666-8666-666666666666', operationIndex: 1, operation: 'delete' as const };

function page(path: string, items: readonly ProjectFileHistoryItem[] = [item], nextCursor: string | null = null): ProjectFileHistoryPage {
  return { projectId: PROJECT_ID, path, outcome: 'all', items: items.map((entry) => ({ ...entry, matchedPath: path, path })), nextCursor };
}

describe('ProjectFileHistoryPanel', () => {
  beforeEach(() => listProjectFileHistoryMock.mockReset());
  afterEach(() => cleanup());

  it('shows all recorded outcomes by default, keeps archived history read only, and exposes applied filtering', async () => {
    listProjectFileHistoryMock.mockResolvedValue(page('src/app.ts'));
    const onOutcomeChange = vi.fn();
    render(<MemoryRouter><ProjectFileHistoryPanel projectId={PROJECT_ID} path="src/app.ts" outcome="all" archived onOutcomeChange={onOutcomeChange} /></MemoryRouter>);
    expect(await screen.findByTestId('file-history-entry')).toHaveTextContent('stale');
    expect(screen.getByTestId('file-history-archived')).toHaveTextContent('read only history');
    fireEvent.change(screen.getByTestId('file-history-outcome-filter'), { target: { value: 'applied' } });
    expect(onOutcomeChange).toHaveBeenCalledWith('applied');
    expect(screen.getByRole('link', { name: 'Open the related conversation' })).toHaveAttribute('href', `/projects/${PROJECT_ID}/conversations/${item.conversationId}`);
  });

  it('announces paging and ignores late results from an earlier file path', async () => {
    listProjectFileHistoryMock.mockResolvedValueOnce(page('src/first.ts', [item], 'cursor'))
      .mockResolvedValueOnce(page('src/first.ts', [secondItem], null))
      .mockResolvedValueOnce(page('src/second.ts'));
    const onOutcomeChange = vi.fn();
    const { rerender } = render(<MemoryRouter><ProjectFileHistoryPanel projectId={PROJECT_ID} path="src/first.ts" outcome="all" archived={false} onOutcomeChange={onOutcomeChange} /></MemoryRouter>);
    await screen.findByTestId('file-history-entry');
    fireEvent.click(screen.getByTestId('file-history-load-more'));
    await waitFor(() => expect(screen.getByText('More file history loaded.')).toBeInTheDocument());
    rerender(<MemoryRouter><ProjectFileHistoryPanel projectId={PROJECT_ID} path="src/second.ts" outcome="all" archived={false} onOutcomeChange={onOutcomeChange} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('file-history-path')).toHaveTextContent('src/second.ts'));
    expect(await screen.findByTestId('file-history-entry')).toHaveTextContent('src/second.ts');
    expect(listProjectFileHistoryMock).toHaveBeenCalledWith(PROJECT_ID, 'src/first.ts', 'all', 'cursor');
  });

  it('ignores a history response that arrives after switching file paths', async () => {
    let resolveOld: (value: ProjectFileHistoryPage) => void = () => undefined;
    listProjectFileHistoryMock.mockImplementationOnce(() => new Promise<ProjectFileHistoryPage>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(page('src/second.ts'));
    const { rerender } = render(<MemoryRouter><ProjectFileHistoryPanel projectId={PROJECT_ID} path="src/first.ts" outcome="all" archived={false} onOutcomeChange={vi.fn()} /></MemoryRouter>);
    rerender(<MemoryRouter><ProjectFileHistoryPanel projectId={PROJECT_ID} path="src/second.ts" outcome="all" archived={false} onOutcomeChange={vi.fn()} /></MemoryRouter>);
    expect(await screen.findByTestId('file-history-entry')).toHaveTextContent('src/second.ts');
    await act(async () => { resolveOld(page('src/first.ts')); });
    expect(screen.getByTestId('file-history-path')).toHaveTextContent('src/second.ts');
    expect(screen.getByTestId('file-history-entry')).toHaveTextContent('src/second.ts');
  });
});
