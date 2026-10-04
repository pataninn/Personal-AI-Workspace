import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { ProjectSnapshot } from '@/entities/project';
import { ProjectTasksManager } from '@/features/project-tasks';
import { ChatWorkspace } from '@/widgets/chat-workspace';
import { Label } from '@/shared/ui';

interface ProjectWorkspaceLayoutProps {
  readonly project: ProjectSnapshot;
  readonly filePanel: ReactNode;
}

/** Compose desktop chat/tasks/files and keep the same panels mounted on mobile. */
export function ProjectWorkspaceLayout({ project, filePanel }: ProjectWorkspaceLayoutProps): React.JSX.Element {
  const { conversationId } = useParams();
  const [panel, setPanel] = useState<'chat' | 'tasks' | 'files'>('chat');
  useEffect(() => { setPanel('chat'); }, [project.id]);
  return <>
    <div className="workspace-panel-picker"><Label htmlFor="workspace-panel">Show</Label><select id="workspace-panel" data-testid="workspace-panel-picker" value={panel} onChange={(event) => { const value = event.currentTarget.value; if (value === 'chat' || value === 'tasks' || value === 'files') setPanel(value); }}><option value="chat">Chat</option><option value="tasks">Tasks</option><option value="files">Files</option></select></div>
    <div className="workspace-split" data-panel={panel}>
      <div className="workspace-chat"><ChatWorkspace project={project} /></div>
      <aside className="workspace-side" aria-label="Project tasks and files">
        <section className="workspace-tasks"><ProjectTasksManager projectId={project.id} projectName={project.name} archived={project.status === 'archived'} conversationId={conversationId ?? null} compact /></section>
        <div className="workspace-files">{filePanel}</div>
      </aside>
    </div>
  </>;
}
