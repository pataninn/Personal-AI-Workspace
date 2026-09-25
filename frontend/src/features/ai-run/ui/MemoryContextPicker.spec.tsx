import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectFact } from '@/entities/project-fact';
import { MemoryContextPicker } from '@/features/ai-run/ui/MemoryContextPicker';

const { listFactsMock } = vi.hoisted(() => ({ listFactsMock: vi.fn() }));

vi.mock('@/entities/project-fact/api/project-fact-api', () => ({ listProjectFacts: listFactsMock }));

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const FACT_ID = '55555555-5555-4555-8555-000000000001';
const fact: ProjectFact = {
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

function renderPicker(props: Partial<React.ComponentProps<typeof MemoryContextPicker>> = {}) {
  const onChange = vi.fn();
  const onReviewStarted = vi.fn();
  const onUnavailable = vi.fn();
  const onSelectionConfirmed = vi.fn();
  const onExplicitSkip = vi.fn();
  render(<MemoryRouter><MemoryContextPicker
    projectId={PROJECT_ID}
    selectedFactIds={[]}
    selectedFactVersions={{}}
    onChange={onChange}
    onReviewStarted={onReviewStarted}
    onUnavailable={onUnavailable}
    onSelectionConfirmed={onSelectionConfirmed}
    onExplicitSkip={onExplicitSkip}
    {...props}
  /></MemoryRouter>);
  return { onChange, onReviewStarted, onUnavailable, onSelectionConfirmed, onExplicitSkip };
}

describe('MemoryContextPicker', () => {
  beforeEach(() => {
    listFactsMock.mockReset().mockResolvedValue([fact]);
  });

  it('starts with no facts selected and sends only an explicit selection to its caller', async () => {
    const callbacks = renderPicker();
    const user = userEvent.setup();

    expect(screen.getByTestId('memory-context-count')).toHaveTextContent('0 facts selected');
    await user.click(screen.getByTestId('memory-context-open'));
    const checkbox = await screen.findByTestId(`memory-context-fact-${FACT_ID}`);
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText('Needs review. Check this value before including it.')).toBeInTheDocument();
    expect(callbacks.onChange).not.toHaveBeenCalled();

    await user.click(checkbox);
    await user.click(screen.getByTestId('memory-context-apply'));

    expect(callbacks.onChange).toHaveBeenCalledWith([FACT_ID], { [FACT_ID]: 1 });
    expect(callbacks.onSelectionConfirmed).toHaveBeenCalledTimes(1);
    // The picker is controlled by its owner; its callback carries the new selection.
    // The live count updates in AiRunEntry after that owner applies the state.
  });

  it('does not save checkbox drafts when the picker is cancelled', async () => {
    const callbacks = renderPicker();
    const user = userEvent.setup();

    await user.click(screen.getByTestId('memory-context-open'));
    await user.click(await screen.findByTestId(`memory-context-fact-${FACT_ID}`));
    await user.click(screen.getByTestId('memory-context-cancel'));

    expect(callbacks.onChange).not.toHaveBeenCalled();
    expect(await screen.findByTestId('memory-context-count')).toHaveTextContent('0 facts selected');
    expect(screen.queryByTestId('memory-context-dialog')).not.toBeInTheDocument();
  });

  it('offers project memory links for an empty fact list', async () => {
    listFactsMock.mockResolvedValueOnce([]);
    renderPicker();
    const user = userEvent.setup();

    await user.click(screen.getByTestId('memory-context-open'));
    await screen.findByTestId('memory-context-empty-state');

    expect(screen.getByTestId('memory-context-manage-link')).toHaveAttribute('href', `/projects/${PROJECT_ID}/memory`);
    expect(screen.getByTestId('memory-context-empty-manage-link')).toHaveAttribute('href', `/projects/${PROJECT_ID}/memory`);
  });

  it('clears a saved selection when the fact version changed since it was reviewed', async () => {
    listFactsMock.mockResolvedValueOnce([{ ...fact, version: 2 }]);
    const callbacks = renderPicker({ selectedFactIds: [FACT_ID], selectedFactVersions: { [FACT_ID]: 1 } });
    const user = userEvent.setup();

    await user.click(screen.getByTestId('memory-context-open'));
    expect(await screen.findByTestId('memory-context-drift')).toHaveTextContent('A selected fact changed');
    expect(await screen.findByTestId(`memory-context-fact-${FACT_ID}`)).not.toBeChecked();
    expect(callbacks.onChange).toHaveBeenCalledWith([], {});
    expect(callbacks.onSelectionConfirmed).not.toHaveBeenCalled();
  });

  it('blocks use on a load failure and requires an explicit continue without memory choice', async () => {
    listFactsMock.mockRejectedValueOnce(new Error('offline'));
    const callbacks = renderPicker({ selectedFactIds: [FACT_ID], selectedFactVersions: { [FACT_ID]: 1 } });
    const user = userEvent.setup();

    await user.click(screen.getByTestId('memory-context-open'));
    expect(await screen.findByTestId('memory-context-dialog-error')).toBeInTheDocument();
    expect(screen.getByTestId('memory-context-apply')).toBeDisabled();
    expect(callbacks.onUnavailable).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId('memory-context-dialog-continue-without'));

    expect(callbacks.onChange).toHaveBeenCalledWith([], {});
    expect(callbacks.onExplicitSkip).toHaveBeenCalledTimes(1);
    expect(callbacks.onSelectionConfirmed).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('memory-context-dialog')).not.toBeInTheDocument());
  });
});
