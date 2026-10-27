import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { listProjects, type ProjectSnapshot } from '@/entities/project';
import { selectCsrfToken } from '@/entities/user-session';
import { ApiClientError } from '@/shared/api';
import { useAppSelector } from '@/app/store/hooks';
import { createIdempotencyKey } from '@/shared/lib/idempotency-key';
import { Alert, Button, Card, Label, Skeleton, Spinner } from '@/shared/ui';
import { createWorkspaceExport, downloadWorkspaceExport, type WorkspaceExportDescriptor } from '@/features/workspace-export/api/workspace-export-api';

type ListStatus = 'loading' | 'ready' | 'error';
interface CreateIntent { readonly workspaceId: string; readonly key: string; }
interface CreateRequest { readonly intent: CreateIntent; }

export function WorkspaceExportPanel(): React.JSX.Element {
  const csrfToken = useAppSelector(selectCsrfToken);
  const [projects, setProjects] = useState<readonly ProjectSnapshot[]>([]);
  const [listStatus, setListStatus] = useState<ListStatus>('loading');
  const [selectedId, setSelectedId] = useState('');
  const [descriptor, setDescriptor] = useState<WorkspaceExportDescriptor | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  const intentRef = useRef<CreateIntent | null>(null);
  const selectedIdRef = useRef('');
  const activeRequestRef = useRef<CreateRequest | null>(null);
  const activeDownloadRef = useRef<WorkspaceExportDescriptor | null>(null);

  const loadProjects = useCallback(async (): Promise<void> => {
    setListStatus('loading');
    try {
      const result = await listProjects(false);
      const active = result.projects.filter((project) => project.status === 'active');
      setProjects(active);
      if (selectedIdRef.current && !active.some((project) => project.id === selectedIdRef.current)) {
        setSelection('', true);
      }
      setListStatus('ready');
    } catch {
      setListStatus('error');
    }
  }, []);

  function setSelection(workspaceId: string, clear: boolean): void {
    selectedIdRef.current = workspaceId;
    setSelectedId(workspaceId);
    intentRef.current = workspaceId ? { workspaceId, key: createIdempotencyKey() } : null;
    if (clear) {
      activeRequestRef.current = null;
      activeDownloadRef.current = null;
      setPreparing(false);
      setDownloading(false);
      setDescriptor(null);
      setCreateError(null);
      setDownloadError(false);
    }
  }

  useEffect(() => { void loadProjects(); }, [loadProjects]);

  const selectedProject = useMemo(() => projects.find((project) => project.id === selectedId) ?? null, [projects, selectedId]);
  async function prepareExport(): Promise<void> {
    if (!selectedProject || !csrfToken || activeRequestRef.current) return;
    const intent = intentRef.current?.workspaceId === selectedProject.id
      ? intentRef.current
      : { workspaceId: selectedProject.id, key: createIdempotencyKey() };
    intentRef.current = intent;
    const request: CreateRequest = { intent };
    activeRequestRef.current = request;
    setPreparing(true);
    setDescriptor(null);
    setCreateError(null);
    setDownloadError(false);
    try {
      const result = await createWorkspaceExport(intent.workspaceId, csrfToken, intent.key);
      if (activeRequestRef.current !== request || selectedIdRef.current !== intent.workspaceId || intentRef.current !== intent) return;
      setDescriptor(result);
    } catch (error: unknown) {
      if (activeRequestRef.current !== request || selectedIdRef.current !== intent.workspaceId || intentRef.current !== intent) return;
      setCreateError(createFailureMessage(error));
      if (isDefinitiveCreateFailure(error)) {
        const retryIntent = { workspaceId: intent.workspaceId, key: createIdempotencyKey() };
        intentRef.current = retryIntent;
      }
    } finally {
      if (activeRequestRef.current === request) {
        activeRequestRef.current = null;
        setPreparing(false);
      }
    }
  }

  async function downloadExport(): Promise<void> {
    if (!descriptor || activeDownloadRef.current) return;
    const current = descriptor;
    activeDownloadRef.current = current;
    setDownloading(true);
    setDownloadError(false);
    try {
      const blob = await downloadWorkspaceExport(current.id);
      if (activeDownloadRef.current !== current || descriptor?.id !== current.id || selectedIdRef.current !== current.workspaceId) return;
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = `workspace-export-${current.id}.json`;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch (error: unknown) {
      if (activeDownloadRef.current !== current || selectedIdRef.current !== current.workspaceId) return;
      if (error instanceof ApiClientError && error.statusCode === 404) {
        setDescriptor(null);
        intentRef.current = { workspaceId: current.workspaceId, key: createIdempotencyKey() };
      }
      setDownloadError(true);
    } finally {
      if (activeDownloadRef.current === current) {
        activeDownloadRef.current = null;
        setDownloading(false);
      }
    }
  }

  return <Card className="grid gap-4 p-5" data-testid="workspace-export" aria-busy={listStatus === 'loading' || preparing}>
    <div>
      <h2 className="text-xl font-semibold">Export a workspace</h2>
      <p className="field-help">Download a private copy of your workspace.</p>
    </div>

    {listStatus === 'loading' ? <div className="grid gap-3" data-testid="workspace-export-loading" aria-live="polite">
      <div className="flex items-center gap-2"><Spinner /><span>Loading active workspaces…</span></div>
      <Skeleton className="h-10" />
    </div> : null}

    {listStatus === 'error' ? <Alert tone="error" data-testid="workspace-export-list-error">
      <p>Your active workspaces could not be loaded.</p>
      <Button type="button" variant="secondary" onClick={() => { void loadProjects(); }}>Try again</Button>
    </Alert> : null}

    {listStatus === 'ready' && projects.length === 0 ? <p className="field-help" data-testid="workspace-export-empty">No active workspaces available to export.</p> : null}

    {listStatus === 'ready' && projects.length > 0 ? <>
      <div className="grid max-w-xl gap-2">
        <Label htmlFor="workspace-export-project">Workspace to export</Label>
        <select id="workspace-export-project" className="field-select min-h-11 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3" value={selectedId}
          onChange={(event) => setSelection(event.currentTarget.value, true)}
          disabled={downloading} data-testid="workspace-export-project-select">
          <option value="">Choose an active workspace</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </div>

      <details className="text-sm text-[var(--color-text-muted)]">
        <summary className="cursor-pointer py-3 font-medium">What is included?</summary>
        <div className="grid gap-2 pt-2 [&>p]:m-0">
          <p>Includes this workspace's files, tasks, saved facts, conversations, skills and schedules.</p>
          <p>Account-wide skills, other workspaces and account security data are excluded. Exports containing recognized credentials are blocked; review the file before sharing it.</p>
          <p>This is a JSON download. Import and restore are not supported. Download links last up to 15 minutes.</p>
        </div>
      </details>

      {createError ? <Alert tone="error" data-testid="workspace-export-create-error">{createError}</Alert> : null}
      {downloadError ? <Alert tone="error" data-testid="workspace-export-download-error">
        <p>This export is unavailable. Prepare a new export.</p>
      </Alert> : null}

      {descriptor ? <section className="grid justify-items-start gap-2" aria-label="Export ready" data-testid="workspace-export-ready" aria-live="polite">
        <h3 className="font-semibold">Export ready</h3>
        <p>{selectedProject?.name} · {formatBytes(descriptor.sizeBytes)}</p>
        <p>Available until {formatDate(descriptor.expiresAt)}.</p>
        <Button type="button" variant="secondary" disabled={downloading} aria-busy={downloading} onClick={() => { void downloadExport(); }}>
          {downloading ? 'Downloading…' : 'Download JSON'}
        </Button>

      </section> : null}

      <div>
        <Button type="button" disabled={!selectedProject || !csrfToken || preparing || downloading}
          aria-busy={preparing} onClick={() => { void prepareExport(); }}>
          {preparing ? 'Preparing export…' : 'Prepare export'}
        </Button>
        {!csrfToken ? <p className="field-help mt-2" role="status">Your session is unavailable. Sign in again before exporting.</p> : null}
      </div>
    </> : null}
  </Card>;
}

function createFailureMessage(error: unknown): string {
  if (!(error instanceof ApiClientError)) return 'The export request did not finish. Retry to check or prepare the same request.';
  if (error.statusCode === 413 || error.code === 'EXPORT_TOO_LARGE') return 'This workspace exceeds the supported export size. Nothing downloadable was created. Reduce workspace content before retrying; exports cannot be split.';
  if (error.statusCode === 422 || error.code === 'EXPORT_CONTENT_UNSAFE') return 'This workspace contains text that looks like a credential. Remove it before exporting; nothing downloadable was created.';
  if (error.statusCode === 429 || error.code === 'EXPORT_LIMIT_REACHED') return 'At most two exports can be active per account, and each expires within 15 minutes. Wait for one to expire before trying again.';
  if (error.statusCode === 404 || error.code === 'WORKSPACE_UNAVAILABLE') return 'This workspace is unavailable for export. Refresh the workspace list and try again.';
  return 'The workspace export could not be prepared. Try again.';
}

function isDefinitiveCreateFailure(error: unknown): boolean {
  return error instanceof ApiClientError && (error.statusCode === 413 || error.statusCode === 422 || error.statusCode === 429 || error.statusCode === 404
    || error.code === 'IDEMPOTENCY_KEY_EXPIRED' || error.code === 'IDEMPOTENCY_KEY_REUSED');
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return 'Size unavailable';
  const units = ['B', 'kB', 'MB', 'GB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1000 && unit < units.length - 1) { amount /= 1000; unit += 1; }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(amount)} ${units[unit]}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : 'unavailable';
}
