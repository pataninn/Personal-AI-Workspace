import { useRef, useState } from 'react';
import { useAppSelector } from '@/app/store/hooks';
import { selectCsrfToken } from '@/entities/user-session';
import { uploadProjectFile } from '@/entities/workspace';
import { Button } from '@/shared/ui';
import { ProjectFileTree } from '@/features/project-files/ui/ProjectFileTree';

interface ProjectFilesPanelProps {
  readonly projectId: string;
  readonly paths: readonly string[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly limited?: boolean;
  readonly onRefresh: () => void;
}

/** Show the chosen relevant project files independently of the chat viewport. */
export function ProjectFilesPanel({ projectId, paths, loading, error, limited = false, onRefresh }: ProjectFilesPanelProps): React.JSX.Element {
  const csrfToken = useAppSelector(selectCsrfToken);
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  async function upload(file: File | undefined): Promise<void> {
    if (!file || !csrfToken || uploading) return;
    if (file.size > 8 * 1024 * 1024) { setUploadError('Choose a file 8 MB or smaller.'); return; }
    setUploading(true); setUploadError(null); setNotice('');
    try { await uploadProjectFile(projectId, file, csrfToken); setNotice(`${file.name} uploaded.`); onRefresh(); }
    catch (failure: unknown) { setUploadError(failure instanceof Error ? failure.message : 'Upload failed. Try again.'); }
    finally { setUploading(false); if (inputRef.current) inputRef.current.value = ''; }
  }

  return <section className="project-files-panel" aria-labelledby="workspace-files-heading">
    <header className="file-panel-header"><h2 id="workspace-files-heading">Files <span className="supporting-copy">({paths.length})</span></h2><div className="file-actions"><Button type="button" variant="secondary" data-testid="project-file-upload" disabled={!csrfToken || uploading} onClick={() => { inputRef.current?.click(); }}>{uploading ? 'Uploading...' : 'Upload'}</Button><Button type="button" variant="ghost" data-testid="project-file-refresh" disabled={uploading} onClick={onRefresh}>Refresh</Button></div></header>
    <input ref={inputRef} className="sr-only" type="file" aria-label="Upload project file" onChange={(event) => { void upload(event.currentTarget.files?.[0]); }} />
    {loading ? <p role="status">Loading files...</p> : null}
    {error || uploadError ? <p role="alert">{uploadError ?? error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {limited ? <p className="supporting-copy">The file list reached its discovery limit.</p> : null}
    {!loading && !error && paths.length === 0 ? <p className="supporting-copy">No files in this list yet.</p> : null}
    <ProjectFileTree projectId={projectId} paths={paths} onChanged={onRefresh} />
  </section>;
}
