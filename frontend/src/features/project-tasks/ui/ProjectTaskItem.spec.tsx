import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ProjectTask } from '@/entities/project-task';
import { ProjectTaskItem } from '@/features/project-tasks/ui/ProjectTaskItem';

const task: ProjectTask = { id: 'task', projectId: 'project', title: 'Review guide', details: 'Read carefully.', status: 'todo', importance: 'high', deadline: null,
  subtasks: [{ id: 'child', title: 'Check steps', completed: false }], position: 0, version: 1,
  source: { kind: 'user', label: 'Added by you', suggestionId: null, runId: null, conversationId: null, acceptedAt: null }, createdAt: '2026-10-01', updatedAt: '2026-10-01', completedAt: null };

describe('ProjectTaskItem', () => {
  it('expands details inline and forwards checklist and complete actions with the current task', async () => {
    const user = userEvent.setup();
    const onToggleSubtask = vi.fn();
    const onTransition = vi.fn();
    render(<ul><ProjectTaskItem task={task} pending={false} archivedProject={false} actionError={null} onEdit={vi.fn()} onDelete={vi.fn()} onToggleSubtask={onToggleSubtask} onTransition={onTransition} /></ul>);
    const summary = screen.getByText('Review guide').closest('summary');
    expect(summary?.parentElement).not.toHaveAttribute('open');
    if (!summary) { throw new TypeError('Task summary is missing.'); }
    await user.click(summary);
    expect(summary.parentElement).toHaveAttribute('open');
    await user.click(screen.getByLabelText('Check steps'));
    expect(onToggleSubtask).toHaveBeenCalledWith(task, 'child');
    await user.click(screen.getByRole('button', { name: 'Mark complete' }));
    expect(onTransition).toHaveBeenCalledWith(task, 'done');
    expect(screen.queryByRole('button', { name: 'Move up' })).not.toBeInTheDocument();
  });

  it('opens and focuses a targeted task, while allowing the reader to collapse it', async () => {
    render(<ul><ProjectTaskItem task={task} targeted pending={false} archivedProject={false} actionError={null} onEdit={vi.fn()} onDelete={vi.fn()} onToggleSubtask={vi.fn()} onTransition={vi.fn()} /></ul>);
    const summary = screen.getByText(task.title).closest('summary');
    expect(summary?.parentElement).toHaveAttribute('open');
    expect(summary).toHaveFocus();
    if (!summary) { throw new TypeError('Task summary is missing.'); }
    await userEvent.setup().click(summary);
    expect(summary.parentElement).not.toHaveAttribute('open');
  });

  it('disables checklist mutations while a save is pending and retains visible row errors', () => {
    render(<ul><ProjectTaskItem task={task} targeted pending archivedProject={false} actionError="This task changed elsewhere." onEdit={vi.fn()} onDelete={vi.fn()} onToggleSubtask={vi.fn()} onTransition={vi.fn()} /></ul>);
    expect(screen.getByLabelText('Check steps')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Mark complete' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('This task changed elsewhere.');
  });
});
