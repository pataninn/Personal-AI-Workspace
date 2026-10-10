import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { ProjectSnapshot } from '@/entities/project';
import { ProjectTasksManager } from '@/features/project-tasks';
import { ChatWorkspace } from '@/widgets/chat-workspace';
import { Button, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuRoot, DropdownMenuTrigger, Icon, Label } from '@/shared/ui';

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
    <div className="workspace-panel-picker">
      <Label htmlFor="workspace-panel">Show</Label>
      <DropdownMenuRoot>
        <DropdownMenuTrigger asChild>
          <Button id="workspace-panel" type="button" variant="ghost" className="workspace-panel-trigger" data-testid="workspace-panel-picker" aria-label={`Show panel: ${panel === 'chat' ? 'Chat' : panel === 'tasks' ? 'Tasks' : 'Files'}`}>
            {panel === 'chat' ? 'Chat' : panel === 'tasks' ? 'Tasks' : 'Files'}<Icon name="chevron" size={18} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="workspace-panel-menu" align="start">
          <DropdownMenuRadioGroup value={panel} onValueChange={(value) => { if (value === 'chat' || value === 'tasks' || value === 'files') setPanel(value); }} aria-label="Workspace panel">
            {(['chat', 'tasks', 'files'] as const).map((value) => <DropdownMenuRadioItem key={value} value={value} className="workspace-panel-option">{value === 'chat' ? 'Chat' : value === 'tasks' ? 'Tasks' : 'Files'}{panel === value ? <Icon name="check" size={16} /> : null}</DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenuRoot>
    </div>
    <div className="workspace-split" data-panel={panel}>
      <div className="workspace-chat"><ChatWorkspace project={project} /></div>
      <aside className="workspace-side" aria-label="Project tasks and files">
        <section className="workspace-tasks"><ProjectTasksManager projectId={project.id} projectName={project.name} archived={project.status === 'archived'} conversationId={conversationId ?? null} compact /></section>
        <div className="workspace-files">{filePanel}</div>
      </aside>
    </div>
  </>;
}
