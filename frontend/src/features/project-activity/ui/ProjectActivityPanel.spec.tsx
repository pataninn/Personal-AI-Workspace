import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { ProjectActivityPanel } from '@/features/project-activity/ui/ProjectActivityPanel';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const item = {
  runId: RUN_ID, projectId: PROJECT_ID, conversationId: '33333333-3333-4333-8333-333333333333', status: 'succeeded', decision: 'approved', providerTransmission: 'transmitted_confirmed',
  createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:02.000Z', provider: 'NVIDIA hosted NIM', model: 'test-model', requestPreview: 'Review the project.',
  context: { categories: ['Request', 'Project files'], fileCount: 1, factCount: 0, messageCount: 2, estimatedTokens: 44 },
  usage: { status: 'partial', promptTokens: 40, completionTokens: null, totalTokens: null },
  cost: { status: 'unavailable', label: 'Unavailable — no rate configured' }, changeSet: { status: 'applied', operationCount: 1, appliedCount: 1, skippedCount: 0, failedCount: 0, backupCount: 1 }
} as const;
const detail = { ...item, assistantPreview: 'password=[REDACTED] The task is complete.', selectedFiles: ['src/app.ts'], selectedFactTitles: ['Project goal'], operations: [{ operation: 'edit', path: 'src/app.ts', outcome: 'applied', backupStatus: 'created' }], omittedOperationCount: 0 };
const fetchMock = vi.fn<typeof fetch>();

describe('ProjectActivityPanel', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('shows estimates separately from partial provider usage and expands safe detail', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      return url.endsWith(`/ai-runs/${RUN_ID}/activity`)
        ? envelope(detail)
        : envelope({ projectId: PROJECT_ID, items: [item], nextCursor: null });
    });
    const user = userEvent.setup();
    render(<MemoryRouter><ProjectActivityPanel projectId={PROJECT_ID} archived={false} /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Review the project.' })).toBeInTheDocument();
    expect(screen.getByText('44 tokens (estimate)')).toBeInTheDocument();
    expect(screen.getByText('Partial provider report')).toBeInTheDocument();
    expect(screen.getByText(/Prompt: 40 · Completion: Not available · Total: Not available/)).toBeInTheDocument();
    expect(screen.getByText('Cost: Unavailable — no rate configured')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'View details' }));

    expect(await screen.findByText('password=[REDACTED] The task is complete.')).toBeInTheDocument();
    expect(screen.getAllByText('src/app.ts')).toHaveLength(2);
    expect(screen.getByText(/backup created/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(`/ai-runs/${RUN_ID}/activity`))).toBe(true);
  });

  it('announces read only archived history and distinguishes an empty filtered result', async () => {
    fetchMock.mockImplementation(async () => envelope({ projectId: PROJECT_ID, items: [], nextCursor: null }));
    const user = userEvent.setup();
    render(<MemoryRouter><ProjectActivityPanel projectId={PROJECT_ID} archived /></MemoryRouter>);

    expect(await screen.findByTestId('project-activity-archived')).toHaveTextContent('read only history');
    expect(screen.getByRole('heading', { name: 'No run activity yet' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Show'), 'succeeded');
    expect(await screen.findByRole('heading', { name: 'No activity matches this filter' })).toBeInTheDocument();
  });

  it('announces when another activity page has finished loading', async () => {
    const nextItem = { ...item, runId: '44444444-4444-4444-8444-444444444444', requestPreview: 'Second activity page.' };
    fetchMock.mockImplementation((input) => String(input).includes('cursor=')
      ? Promise.resolve(envelope({ projectId: PROJECT_ID, items: [nextItem], nextCursor: null }))
      : Promise.resolve(envelope({ projectId: PROJECT_ID, items: [item], nextCursor: 'page-2' })));
    const user = userEvent.setup();
    render(<MemoryRouter><ProjectActivityPanel projectId={PROJECT_ID} archived={false} /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: item.requestPreview })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByTestId('activity-load-more-status')).toHaveTextContent('More activity loaded.');
    expect(screen.getByRole('heading', { name: nextItem.requestPreview })).toBeInTheDocument();
  });

  it('ignores a previous filter response that arrives after the filter changes', async () => {
    let resolveAll: (response: Response) => void = () => undefined;
    const delayedAll = new Promise<Response>((resolve) => { resolveAll = resolve; });
    fetchMock.mockImplementation((input) => String(input).includes('filter=all')
      ? delayedAll
      : Promise.resolve(envelope({ projectId: PROJECT_ID, items: [], nextCursor: null })));
    const user = userEvent.setup();
    render(<MemoryRouter><ProjectActivityPanel projectId={PROJECT_ID} archived={false} /></MemoryRouter>);

    await user.selectOptions(screen.getByLabelText('Show'), 'succeeded');
    expect(await screen.findByRole('heading', { name: 'No activity matches this filter' })).toBeInTheDocument();
    resolveAll(envelope({ projectId: PROJECT_ID, items: [item], nextCursor: null }));

    await waitFor(() => expect(screen.queryByRole('heading', { name: item.requestPreview })).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ data, error: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
