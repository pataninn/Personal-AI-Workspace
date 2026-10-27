import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { ProjectSnapshot } from '@/entities/project';
import { ProjectWorkspaceLayout } from '@/widgets/project-workspace/ProjectWorkspaceLayout';

vi.mock('@/features/project-tasks', () => ({
  ProjectTasksManager: ({ conversationId }: { readonly conversationId: string | null }) => <div data-testid="task-conversation-id">{conversationId ?? 'none'}</div>
}));
vi.mock('@/widgets/chat-workspace', () => ({ ChatWorkspace: () => <div data-testid="chat-workspace" /> }));

const PROJECT: ProjectSnapshot = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Launch plan', slug: 'launch-plan',
  objective: 'Plan the launch', workspaceMode: 'planning', capabilities: { planning: true, fileAccess: false }, status: 'active', version: 1,
  createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z'
};

describe('ProjectWorkspaceLayout planning-only compatibility', () => {
  it('does not pass a stale conversation id into planning task suggestions', () => {
    render(
      <MemoryRouter initialEntries={[`/projects/${PROJECT.id}/conversations/stale-conversation`]}>
        <Routes>
          <Route path="/projects/:projectId/conversations/:conversationId" element={<ProjectWorkspaceLayout project={PROJECT} filePanel={null} />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId('task-conversation-id')).toHaveTextContent('none');
    expect(screen.queryByTestId('chat-workspace')).not.toBeInTheDocument();
    expect(screen.getByText(/This is a planning-only workspace/)).toBeInTheDocument();
    expect(screen.getByText(/Tasks, memory, and planning assistance remain available where enabled/)).toBeInTheDocument();
  });
});
