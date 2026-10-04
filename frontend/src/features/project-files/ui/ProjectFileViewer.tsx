import { useEffect, useId, useState } from 'react';
import { useAppSelector } from '@/app/store/hooks';
import { selectCsrfToken } from '@/entities/user-session';
import { deleteProjectFile, downloadProjectFile, readProjectFile, saveProjectFile } from '@/entities/workspace';
import type { ProjectTextFile } from '@/entities/workspace';
import { ApiClientError } from '@/shared/api';
import { BinaryFilePreview } from '@/features/project-files/ui/BinaryFilePreview';
import { AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogRoot, AlertDialogTitle, Button, Label, MarkdownContent, Textarea } from '@/shared/ui';

interface ProjectFileViewerProps {
  readonly projectId: string;
  readonly path: string;
  readonly onChanged: () => void;
}

/** Inline file view/editor with version-aware changes and explicit deletion. */
export function ProjectFileViewer({ projectId, path, onChanged }: ProjectFileViewerProps): React.JSX.Element {
  const csrfToken = useAppSelector(selectCsrfToken);
  const editorId = useId();
  const deleteDescriptionId = useId();
  const [file, setFile] = useState<ProjectTextFile | null>(null);
  const [binary, setBinary] = useState<{ blob: Blob; hash: string } | null>(null);
  const [content, setContent] = useState('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const hash = file?.sourceHash ?? binary?.hash;

  useEffect(() => {
    let current = true;
    setLoading(true); setError(null); setFile(null); setBinary(null); setEditing(false);
    void readProjectFile(projectId, path).then((result) => {
      if (current) { setFile(result); setContent(result.content); }
    }).catch(async (failure: unknown) => {
      if (failure instanceof ApiClientError && ['WORKSPACE_FILE_BINARY', 'WORKSPACE_FILE_UNSUPPORTED'].includes(failure.code)) {
        const result = await downloadProjectFile(projectId, path);
        if (current) setBinary(result);
      } else throw failure;
    }).catch((failure: unknown) => { if (current) setError(message(failure)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [projectId, path, attempt]);

  async function save(): Promise<void> {
    if (!file || !csrfToken || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await saveProjectFile(projectId, file, content, csrfToken);
      setFile({ ...file, content, sourceHash: result.hash }); setEditing(false); setNotice('File saved.'); onChanged();
    } catch (failure: unknown) { setError(message(failure)); }
    finally { setBusy(false); }
  }

  async function remove(): Promise<void> {
    if (!hash || !csrfToken || busy) return;
    setBusy(true); setError(null);
    try { await deleteProjectFile(projectId, path, hash, csrfToken); setDeleteOpen(false); onChanged(); }
    catch (failure: unknown) { setError(message(failure)); }
    finally { setBusy(false); }
  }

  async function download(): Promise<void> {
    setError(null);
    try {
      const result = binary ?? await downloadProjectFile(projectId, path);
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement('a'); link.href = url; link.download = path.split('/').at(-1) ?? 'file'; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure: unknown) { setError(message(failure)); }
  }

  return <section className="project-file-viewer" aria-label={`File ${path}`}>
    {loading ? <p role="status">Loading file...</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <p role="status">{notice}</p>
    {editing ? <><Label htmlFor={editorId}>File content</Label><Textarea id={editorId} data-testid="project-file-edit" value={content} disabled={busy} onChange={(event) => { setContent(event.currentTarget.value); }} /><div className="file-actions"><Button type="button" disabled={busy} onClick={() => { void save(); }}>Save</Button><Button type="button" variant="secondary" disabled={busy} onClick={() => { setContent(file?.content ?? ''); setEditing(false); }}>Cancel edit</Button></div></>
      : file ? <>{/\.(?:md|markdown)$/iu.test(path) ? <MarkdownContent content={file.content} /> : <pre className="file-text-preview">{file.content}</pre>}{file.truncated ? <p>This preview is shortened. Download the full file; editing is disabled.</p> : null}</>
        : binary ? <BinaryFilePreview blob={binary.blob} path={path} /> : null}
    <div className="file-actions">
      <Button type="button" variant="secondary" disabled={loading || busy} onClick={() => { void download(); }}>Download</Button>
      {file && !editing ? <Button type="button" variant="secondary" disabled={file.truncated || busy || !csrfToken} onClick={() => { setEditing(true); setNotice(''); }}>Edit</Button> : null}
      <Button type="button" variant="ghost" disabled={busy || editing} onClick={() => { setAttempt((value) => value + 1); }}>Refresh</Button>
      <Button type="button" variant="destructive" disabled={!hash || busy || !csrfToken} onClick={() => { setDeleteOpen(true); }}>Delete file</Button>
    </div>
    <AlertDialogRoot open={deleteOpen} onOpenChange={(open) => { if (!busy) setDeleteOpen(open); }}>
      <AlertDialogContent aria-describedby={deleteDescriptionId} onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}>
        <AlertDialogTitle>Delete this file?</AlertDialogTitle>
        <AlertDialogDescription id={deleteDescriptionId}>{path} will be permanently deleted from the project folder. This cannot be undone.</AlertDialogDescription>
        {error ? <p role="alert">{error}</p> : null}
        <div className="dialog-actions"><AlertDialogCancel asChild><Button type="button" variant="secondary" disabled={busy}>Keep file</Button></AlertDialogCancel><Button type="button" variant="destructive" disabled={busy} onClick={() => { void remove(); }}>{busy ? 'Deleting...' : 'Delete file'}</Button></div>
      </AlertDialogContent>
    </AlertDialogRoot>
  </section>;
}

function message(failure: unknown): string { return failure instanceof Error ? failure.message : 'The file operation failed. Try again.'; }
