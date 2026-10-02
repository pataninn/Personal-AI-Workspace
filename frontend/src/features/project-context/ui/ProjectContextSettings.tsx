import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppSelector } from '@/app/store/hooks';
import { useProjectChatContext } from '@/entities/project';
import { selectCsrfToken } from '@/entities/user-session';
import { Alert, Button, Card, Input, Label } from '@/shared/ui';
import { useContextFiles } from '@/features/project-context/model/use-context-files';

/** Render on Context to manage the files and history included in every project chat. */
export function ProjectContextSettings({ projectId, archived }: { readonly projectId: string; readonly archived: boolean }): React.JSX.Element {
  const csrfToken = useAppSelector(selectCsrfToken);
  const settings = useProjectChatContext(projectId, csrfToken);
  const files = useContextFiles(projectId);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [includeHistory, setIncludeHistory] = useState(true);
  const [filter, setFilter] = useState('');
  const [additionalPath, setAdditionalPath] = useState('');
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (settings.context) { setSelected(settings.context.relativePaths); setIncludeHistory(settings.context.includeProjectConversations); }
  }, [settings.context]);
  const disabled = archived || settings.loading || settings.saving || !settings.context || !csrfToken;
  const available = [...new Set([...files.paths, ...selected])].sort();
  const shown = available.filter((path) => path.toLowerCase().includes(filter.toLowerCase()));
  async function apply(): Promise<void> {
    setAnnouncement('');
    if (await settings.save({ relativePaths: selected, includeProjectConversations: includeHistory })) setAnnouncement('Context applied to all chats in this project.');
  }
  return (
    <section className="project-context-settings" data-testid="project-context-settings">
      <Card>
        <h2>Conversation history</h2>
        <label className="context-checkbox-row"><input type="checkbox" checked={includeHistory} disabled={disabled} onChange={(event) => { setIncludeHistory(event.target.checked); setAnnouncement(''); }} /> Include recent messages from previous chats in this project</label>
        <p className="field-help">Recent messages are included by default, within the context size limit.</p>
      </Card>
      <Card>
        <h2>Files for every chat</h2>
        <p className="field-help">Choose files once. Their current contents will be included when you send a message in this project.</p>
        <Label htmlFor="context-file-filter">Find a file</Label>
        <Input id="context-file-filter" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter by file path" />
        {files.loading ? <p role="status">Loading files…</p> : null}
        {files.error ? <Alert tone="error"><p>{files.error}</p><Button type="button" onClick={files.reload}>Try again</Button></Alert> : null}
        {files.truncated ? <p className="field-help">The file list is limited. You can add a relative file path below.</p> : null}
        <div className="context-file-list">
          {shown.map((path) => <label className="context-checkbox-row" key={path}><input type="checkbox" checked={selected.includes(path)} disabled={disabled || (!selected.includes(path) && selected.length >= 100)} onChange={(event) => { setSelected((current) => event.target.checked ? [...current, path] : current.filter((item) => item !== path)); setAnnouncement(''); }} /><code>{path}</code></label>)}
          {!files.loading && !files.error && shown.length === 0 ? <p>No matching files.</p> : null}
        </div>
        <div className="field-group">
          <Label htmlFor="context-add-path">Add a relative file path</Label>
          <Input id="context-add-path" value={additionalPath} disabled={disabled} onChange={(event) => setAdditionalPath(event.target.value)} placeholder="src/example.ts" />
          <Button type="button" variant="secondary" disabled={disabled || !additionalPath.trim() || selected.length >= 100} onClick={() => { setSelected((current) => [...new Set([...current, additionalPath.trim()])]); setAdditionalPath(''); setAnnouncement(''); }}>Add file</Button>
        </div>
        <p className="field-help">{selected.length} files selected. Large files may be omitted to fit the context limit.</p>
      </Card>
      <p>Choose facts for every chat on <Link to={`/projects/${encodeURIComponent(projectId)}/memory`}>Memory</Link>.</p>
      {settings.error ? <Alert tone="error"><p>{settings.error}</p>{!settings.context ? <Button type="button" onClick={settings.reload}>Try again</Button> : null}</Alert> : null}
      <Button type="button" disabled={disabled} aria-busy={settings.saving} onClick={() => { void apply(); }}>{settings.saving ? 'Applying…' : 'Apply to all chats'}</Button>
      <p role="status" aria-live="polite">{announcement}</p>
      {archived ? <p>This project is archived. Context is read-only.</p> : null}
    </section>
  );
}
