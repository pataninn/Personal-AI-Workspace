import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { TaskMetadataDraft } from '@/features/project-tasks/model/project-task-validation';
import { TaskMetadataFields } from '@/features/project-tasks/ui/TaskMetadataFields';

function MetadataForm(): React.JSX.Element {
  const [metadata, setMetadata] = useState<TaskMetadataDraft>({ importance: '', deadline: '', subtasks: [] });
  return <><TaskMetadataFields value={metadata} onChange={setMetadata} errors={{}} disabled={false} /><output aria-label="Task metadata">{JSON.stringify(metadata)}</output></>;
}

describe('TaskMetadataFields', () => {
  it('allows choosing importance and adding, editing and removing a checklist item', async () => {
    const user = userEvent.setup();
    render(<MetadataForm />);
    await user.selectOptions(screen.getByLabelText('Importance'), 'urgent');
    await user.click(screen.getByRole('button', { name: 'Add subtask' }));
    await user.type(screen.getByLabelText('Subtask 1'), 'Review changes');
    expect(screen.getByLabelText('Task metadata')).toHaveTextContent('"importance":"urgent"');
    expect(screen.getByLabelText('Task metadata')).toHaveTextContent('"subtasks":[{"title":"Review changes","completed":false}]');
    await user.click(screen.getByRole('button', { name: 'Remove subtask Review changes' }));
    expect(screen.queryByLabelText('Subtask 1')).not.toBeInTheDocument();
  });

  it('disables mutations while saving and links field errors to inputs', () => {
    render(<TaskMetadataFields value={{ importance: 'medium', deadline: '', subtasks: [] }} onChange={() => undefined} disabled errors={{ deadline: 'Choose a valid date.' }} />);
    expect(screen.getByLabelText('Importance')).toBeDisabled();
    expect(screen.getByLabelText('Deadline (optional)')).toHaveAttribute('aria-describedby', 'project-task-deadline-error');
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a valid date.');
    expect(screen.getByRole('button', { name: 'Add subtask' })).toBeDisabled();
  });
});
