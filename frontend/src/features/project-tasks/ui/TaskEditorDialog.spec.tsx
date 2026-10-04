import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TaskEditorDialog } from '@/features/project-tasks/ui/TaskEditorDialog';

describe('TaskEditorDialog', () => {
  it('defaults new tasks to Medium importance and leaves the optional date empty', () => {
    render(<TaskEditorDialog target={{ kind: 'task', task: null }} saving={false} onOpenChange={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByLabelText('Importance')).toHaveValue('medium');
    expect(screen.getByLabelText('Deadline (optional)')).toHaveValue('');
    expect(screen.getByText(/unchecking an item reopens it/)).toBeInTheDocument();
  });
});
