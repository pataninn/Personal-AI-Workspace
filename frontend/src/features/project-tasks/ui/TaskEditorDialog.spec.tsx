import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { TaskEditorDialog } from '@/features/project-tasks/ui/TaskEditorDialog';

const task = {
  id: 'task-1', projectId: null, title: 'Original title', details: 'Original detail', importance: 'medium', deadline: null, subtasks: [],
  status: 'todo', position: 0, version: 1,
  source: { kind: 'user', label: 'Added by you', suggestionId: null, runId: null, conversationId: null, acceptedAt: null },
  createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z', completedAt: null
} as const;

describe('TaskEditorDialog', () => {
  it('defaults new tasks to Medium importance and leaves the optional date empty', () => {
    render(<TaskEditorDialog target={{ kind: 'task', task: null }} saving={false} onOpenChange={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByLabelText('Importance')).toHaveValue('medium');
    expect(screen.getByLabelText('Deadline (optional)')).toHaveValue('');
    expect(screen.getByText(/unchecking an item reopens it/)).toBeInTheDocument();
  });

  it('rebases an edited field onto the latest task without replacing untouched remote fields', async () => {
    const user = userEvent.setup();
    const latest = { ...task, details: 'Changed elsewhere', version: 2 };
    const onSave = vi.fn().mockResolvedValueOnce({ status: 'conflict', latest }).mockResolvedValueOnce({ status: 'saved' });
    render(<TaskEditorDialog target={{ kind: 'task', task }} saving={false} onOpenChange={vi.fn()} onSave={onSave} />);

    await user.clear(screen.getByLabelText('Task title'));
    await user.type(screen.getByLabelText('Task title'), 'My title');
    await user.click(screen.getByTestId('project-task-editor-save'));
    expect(await screen.findByTestId('project-task-version-conflict')).toBeVisible();
    await user.click(screen.getByTestId('project-task-conflict-keep-editing'));

    expect(screen.getByLabelText('Task title')).toHaveValue('My title');
    expect(screen.getByLabelText('Details (optional)')).toHaveValue('Changed elsewhere');
    await user.click(screen.getByTestId('project-task-editor-save'));
    expect(onSave).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: 'My title', details: 'Changed elsewhere' }), expect.any(String), 2, latest);
    expect(onSave.mock.calls[1]?.[1]).not.toBe(onSave.mock.calls[0]?.[1]);
  });
});
