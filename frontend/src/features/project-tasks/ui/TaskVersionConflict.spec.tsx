import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ProjectTask } from '@/entities/project-task';
import { TaskVersionConflict } from '@/features/project-tasks/ui/TaskVersionConflict';

const task: ProjectTask = {
  id: 'task-1', projectId: null, title: 'Latest title', details: 'Latest details', importance: 'high', deadline: '2026-10-22',
  subtasks: [
    { id: 'sub-2', title: 'Remote second', completed: true },
    { id: 'sub-1', title: 'Remote first', completed: false }
  ],
  status: 'todo', position: 0, version: 2,
  source: { kind: 'user', label: 'Added by you', suggestionId: null, runId: null, conversationId: null, acceptedAt: null },
  createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z', completedAt: null
};

describe('TaskVersionConflict', () => {
  it('shows the draft and latest values with checklist order and checked state', () => {
    render(<TaskVersionConflict latest={task} draft={{
      title: 'Draft title', details: 'Draft details', metadata: {
        importance: 'medium', deadline: '', subtasks: [
          { id: 'sub-1', title: 'Original first', completed: true },
          { id: 'sub-2', title: 'Original second', completed: false }
        ]
      }
    }} onReload={vi.fn()} onKeepDraft={vi.fn()} />);

    const draft = screen.getByRole('region', { name: 'Your draft' });
    const latest = screen.getByRole('region', { name: 'Latest saved' });
    expect(draft).toHaveTextContent('Draft title');
    expect(draft).toHaveTextContent('Complete: Original first');
    expect(draft).toHaveTextContent('Open: Original second');
    expect(latest).toHaveTextContent('Latest title');
    expect(latest).toHaveTextContent('Complete: Remote second');
    expect(latest).toHaveTextContent('Open: Remote first');
    expect(screen.getByTestId('project-task-conflict-reload')).toBeInTheDocument();
    expect(screen.getByTestId('project-task-conflict-keep-editing')).toBeInTheDocument();
  });
});
