import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ContextScopePicker } from '@/features/ai-run/ui/ContextScopePicker';

const { getWorkspaceTreeMock, flattenWorkspaceFilesMock } = vi.hoisted(() => ({
  getWorkspaceTreeMock: vi.fn(),
  flattenWorkspaceFilesMock: vi.fn()
}));

vi.mock('@/entities/workspace', () => ({
  getWorkspaceTree: getWorkspaceTreeMock,
  flattenWorkspaceFiles: flattenWorkspaceFilesMock
}));

const files = [
  { path: 'src/index.ts', sizeBytes: 120 },
  { path: 'src/lib/answer.ts', sizeBytes: 2048 }
];

describe('ContextScopePicker', () => {
  beforeEach(() => {
    getWorkspaceTreeMock.mockReset().mockResolvedValue({ directory: '', depth: 4, entries: [], truncated: false });
    flattenWorkspaceFilesMock.mockReset().mockReturnValue(files);
  });

  it('shows exact selected file and recent-message counts and applies the reviewed scope', async () => {
    const onChange = vi.fn();
    render(
      <ContextScopePicker
        projectId="project-1"
        selectedPaths={['src/index.ts']}
        includeRecentMessages
        recentMessageCount={3}
        onChange={onChange}
      />
    );

    expect(screen.getByTestId('context-scope-summary')).toHaveTextContent('Selected context: 1 file and 3 recent messages.');
    const user = userEvent.setup();
    await user.click(screen.getByTestId('context-scope-open'));
    expect(await screen.findByTestId('context-scope-dialog')).toBeInTheDocument();
    await waitFor(() => expect(getWorkspaceTreeMock).toHaveBeenCalledWith('project-1'));
    expect(screen.getByRole('checkbox', { name: /src\/index\.ts/u })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /src\/lib\/answer\.ts/u })).not.toBeChecked();
    expect(screen.getByTestId('context-scope-dialog')).not.toHaveTextContent('file body');

    await user.click(screen.getByRole('checkbox', { name: /src\/lib\/answer\.ts/u }));
    await user.click(screen.getByTestId('context-recent-messages'));
    await user.click(screen.getByTestId('context-scope-apply'));

    expect(onChange).toHaveBeenCalledWith({ relativePaths: ['src/index.ts', 'src/lib/answer.ts'], includeRecentMessages: false });
    expect(screen.queryByTestId('context-scope-dialog')).not.toBeInTheDocument();
  });

  it('keeps selection actions unavailable when the workspace tree cannot be loaded', async () => {
    getWorkspaceTreeMock.mockRejectedValueOnce(new Error('offline'));
    const onChange = vi.fn();
    render(
      <ContextScopePicker
        projectId="project-1"
        selectedPaths={[]}
        includeRecentMessages={false}
        recentMessageCount={0}
        onChange={onChange}
      />
    );

    const user = userEvent.setup();
    await user.click(screen.getByTestId('context-scope-open'));
    expect(await screen.findByTestId('context-file-error')).toBeInTheDocument();
    expect(screen.getByTestId('context-scope-apply')).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
