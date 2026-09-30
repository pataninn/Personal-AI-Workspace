import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ContextScopePicker } from '@/features/ai-run/ui/ContextScopePicker';

const { getWorkspaceTreeMock, flattenWorkspaceFilesMock, searchWorkspaceFilesMock } = vi.hoisted(() => ({
  getWorkspaceTreeMock: vi.fn(),
  flattenWorkspaceFilesMock: vi.fn(),
  searchWorkspaceFilesMock: vi.fn()
}));

vi.mock('@/entities/workspace', () => ({
  getWorkspaceTree: getWorkspaceTreeMock,
  flattenWorkspaceFiles: flattenWorkspaceFilesMock,
  searchWorkspaceFiles: searchWorkspaceFilesMock
}));

const files = [
  { path: 'src/index.ts', sizeBytes: 120 },
  { path: 'src/lib/answer.ts', sizeBytes: 2048 }
];

describe('ContextScopePicker', () => {
  beforeEach(() => {
    getWorkspaceTreeMock.mockReset().mockResolvedValue({ directory: '', depth: 4, entries: [], truncated: false });
    flattenWorkspaceFilesMock.mockReset().mockReturnValue(files);
    searchWorkspaceFilesMock.mockReset();
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

  it('shows ranked search matches without selecting them until the user checks and applies them', async () => {
    searchWorkspaceFilesMock.mockResolvedValue({
      directory: '', query: 'task suggestion', filesScanned: 9, truncated: false,
      matches: [
        { path: 'src/tasks.ts', line: 6, column: 2, text: 'Task suggestions are saved.' },
        { path: 'src/tasks.ts', line: 11, column: 1, text: 'A second occurrence.' },
        { path: 'src/planning.ts', line: 4, column: 5, text: 'Suggestion task notes.' }
      ]
    });
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ContextScopePicker projectId="project-1" selectedPaths={[]} includeRecentMessages={false} recentMessageCount={0} onChange={onChange} />);
    await user.click(screen.getByTestId('context-scope-open'));
    await screen.findByTestId('context-scope-dialog');
    await user.type(screen.getByTestId('context-file-search-query'), 'task suggestion');
    await user.click(screen.getByTestId('context-file-search-submit'));

    expect(await screen.findByTestId('context-search-results')).toHaveTextContent('2 matching files from a bounded scan of 9 file candidates');
    const resultCheckboxes = screen.getAllByTestId('context-search-result-checkbox');
    expect(resultCheckboxes).toHaveLength(2);
    const firstResult = screen.getByRole('checkbox', { name: /src\/tasks\.ts/u });
    expect(firstResult).not.toBeChecked();
    expect(screen.getByText(/Line 6: Task suggestions are saved\./u)).toBeInTheDocument();

    await user.click(firstResult);
    await user.click(screen.getByTestId('context-scope-apply'));

    expect(onChange).toHaveBeenCalledWith({ relativePaths: ['src/tasks.ts'], includeRecentMessages: false });
  });

  it('shows incomplete browse and search notices while keeping a bounded search selection available', async () => {
    getWorkspaceTreeMock.mockResolvedValue({ directory: '', depth: 4, entries: [], truncated: true });
    searchWorkspaceFilesMock.mockResolvedValue({ directory: '', query: 'context', filesScanned: 200, truncated: true, matches: [{ path: 'src/context.ts', line: 1, column: 1, text: 'context selection' }] });
    const user = userEvent.setup();
    render(<ContextScopePicker projectId="project-1" selectedPaths={[]} includeRecentMessages={false} recentMessageCount={0} onChange={vi.fn()} />);
    await user.click(screen.getByTestId('context-scope-open'));
    await screen.findByTestId('context-tree-truncated');
    await user.type(screen.getByTestId('context-file-search-query'), 'context');
    await user.click(screen.getByTestId('context-file-search-submit'));

    expect(await screen.findByTestId('context-search-truncated')).toBeInTheDocument();
    expect(screen.getByTestId('context-scope-apply')).toBeEnabled();
  });

  it('preserves the draft selection after search failure and offers retry', async () => {
    searchWorkspaceFilesMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({
      directory: '', query: 'context', filesScanned: 2, truncated: false,
      matches: [{ path: 'src/context.ts', line: 1, column: 1, text: 'context selection' }]
    });
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ContextScopePicker projectId="project-1" selectedPaths={['outside-tree.ts']} includeRecentMessages={false} recentMessageCount={0} onChange={onChange} />);
    await user.click(screen.getByTestId('context-scope-open'));
    await screen.findByTestId('context-scope-dialog');
    await user.type(screen.getByTestId('context-file-search-query'), 'context');
    await user.click(screen.getByTestId('context-file-search-submit'));
    expect(await screen.findByTestId('context-search-error')).toBeInTheDocument();
    expect(screen.getByTestId('context-file-selection-count')).toHaveTextContent('1 of 100 project files selected');

    await user.click(screen.getByRole('button', { name: 'Retry search' }));
    expect(await screen.findByTestId('context-search-results')).toBeInTheDocument();
    await user.click(screen.getByTestId('context-scope-apply'));

    expect(onChange).toHaveBeenCalledWith({ relativePaths: ['outside-tree.ts'], includeRecentMessages: false });
  });

  it('discards search results that arrive after switching projects', async () => {
    let resolveSearch: ((value: { directory: string; query: string; filesScanned: number; truncated: boolean; matches: { path: string; line: number; column: number; text: string }[] }) => void) | undefined;
    searchWorkspaceFilesMock.mockReturnValueOnce(new Promise((resolve) => { resolveSearch = resolve; }));
    const onChange = vi.fn();
    const user = userEvent.setup();
    const view = render(<ContextScopePicker projectId="project-1" selectedPaths={[]} includeRecentMessages={false} recentMessageCount={0} onChange={onChange} />);
    await user.click(screen.getByTestId('context-scope-open'));
    await screen.findByTestId('context-scope-dialog');
    await user.type(screen.getByTestId('context-file-search-query'), 'private note');
    await user.click(screen.getByTestId('context-file-search-submit'));
    expect(await screen.findByTestId('context-search-loading')).toBeInTheDocument();

    view.rerender(<ContextScopePicker projectId="project-2" selectedPaths={[]} includeRecentMessages={false} recentMessageCount={0} onChange={onChange} />);
    resolveSearch?.({ directory: '', query: 'private note', filesScanned: 1, truncated: false, matches: [{ path: 'old-project.txt', line: 1, column: 1, text: 'private note' }] });

    await waitFor(() => expect(screen.queryByTestId('context-search-loading')).not.toBeInTheDocument());
    expect(screen.queryByTestId('context-search-results')).not.toBeInTheDocument();
    expect(screen.queryByText('old-project.txt')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('prevents selecting more than 100 project file paths', async () => {
    const selectedPaths = Array.from({ length: 100 }, (_, index) => `src/file-${index}.ts`);
    flattenWorkspaceFilesMock.mockReturnValue([...selectedPaths.map((path) => ({ path, sizeBytes: 1 })), { path: 'src/file-100.ts', sizeBytes: 1 }]);
    const user = userEvent.setup();
    render(<ContextScopePicker projectId="project-1" selectedPaths={selectedPaths} includeRecentMessages={false} recentMessageCount={0} onChange={vi.fn()} />);
    await user.click(screen.getByTestId('context-scope-open'));
    await screen.findByTestId('context-scope-dialog');

    expect(screen.getByTestId('context-file-selection-limit')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /src\/file-100\.ts/u })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /src\/file-0\.ts/u })).toBeChecked();
  });
});
