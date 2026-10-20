import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { useAppSelector } from '@/app/store/hooks';
import { listProjectFacts, type ProjectFact } from '@/entities/project-fact';
import { listProjectTasks, type ProjectTask } from '@/entities/project-task';
import { listProjects, type ProjectSnapshot } from '@/entities/project';
import { listSkills, type UserSkill } from '@/entities/skill';
import { flattenWorkspaceFiles, getWorkspaceTree, type WorkspaceFileCandidate } from '@/entities/workspace';
import { getCurrentShowcase, previewShowcase, publishShowcase } from '@/entities/showcase';
import type { ShowcasePreview, ShowcasePreviewRequest, ShowcasePublishResult, ShowcaseSelection } from '@/entities/showcase';
import { selectCsrfToken } from '@/entities/user-session';
import { ApiClientError } from '@/shared/api';
import { createIdempotencyKey } from '@/shared/lib/idempotency-key';
import {
  Alert, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogRoot, AlertDialogTitle,
  Button, Card, Label, Skeleton
} from '@/shared/ui';
import { PreviewFileContent } from './PreviewFileContent';

interface SourceItems {
  readonly tasks: readonly ProjectTask[];
  readonly facts: readonly ProjectFact[];
  readonly skills: readonly UserSkill[];
  readonly files: readonly WorkspaceFileCandidate[];
  readonly filesTruncated: boolean;
}

type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

const EMPTY_SELECTION: ShowcaseSelection = { taskIds: [], factIds: [], skillIds: [], filePaths: [] };

export function ShowcasePublisher(): React.JSX.Element {
  const csrfToken = useAppSelector(selectCsrfToken);
  const [projects, setProjects] = useState<readonly ProjectSnapshot[]>([]);
  const [projectsState, setProjectsState] = useState<LoadState>('loading');
  const [projectsReload, setProjectsReload] = useState(0);
  const [projectId, setProjectId] = useState('');
  const [source, setSource] = useState<SourceItems | null>(null);
  const [sourceState, setSourceState] = useState<LoadState>('idle');
  const [sourceReload, setSourceReload] = useState(0);
  const [selection, setSelection] = useState<ShowcaseSelection>(EMPTY_SELECTION);
  const [preview, setPreview] = useState<ShowcasePreview | null>(null);
  const [previewStale, setPreviewStale] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [published, setPublished] = useState<ShowcasePublishResult | null>(null);
  const [currentState, setCurrentState] = useState<LoadState>('loading');
  const publishKey = useRef<string | null>(null);
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;

  useEffect(() => {
    let active = true;
    setProjectsState('loading');
    void listProjects(false).then((result) => {
      if (active) {
        setProjects(result.projects.filter((candidate) => candidate.status === 'active'));
        setProjectsState('loaded');
      }
    }).catch(() => {
      if (active) setProjectsState('error');
    });
    return () => { active = false; };
  }, [projectsReload]);

  useEffect(() => {
    let active = true;
    void getCurrentShowcase().then((result) => {
      if (active) {
        setPublished({ version: result.version, publishedAt: result.publishedAt });
        setCurrentState('loaded');
      }
    }).catch((error: unknown) => {
      if (active) {
        setPublished(null);
        setCurrentState(error instanceof ApiClientError && error.code === 'SHOWCASE_NOT_PUBLISHED' ? 'loaded' : 'error');
      }
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!project) {
      setSource(null);
      setSourceState('idle');
      return;
    }
    let active = true;
    setSource(null);
    setSourceState('loading');
    const filesPromise = project.capabilities.fileAccess
      ? getWorkspaceTree(project.id).then((tree) => ({ files: flattenWorkspaceFiles(tree), filesTruncated: tree.truncated }))
      : Promise.resolve({ files: [] as WorkspaceFileCandidate[], filesTruncated: false });
    void Promise.all([listProjectTasks(project.id), listProjectFacts(project.id), filesPromise, listSkills()])
      .then(([taskList, facts, files, allSkills]) => {
        if (active) {
          const skills = allSkills.filter((skill) => skill.enabled && (skill.workspaceId === null || skill.workspaceId === project.id));
          setSource({ tasks: taskList.tasks, facts, skills, files: files.files, filesTruncated: files.filesTruncated });
          setSourceState('loaded');
        }
      })
      .catch(() => {
        if (active) setSourceState('error');
      });
    return () => { active = false; };
  }, [project, sourceReload]);

  function chooseProject(nextProjectId: string): void {
    setProjectId(nextProjectId);
    setSelection(EMPTY_SELECTION);
    clearPreview();
  }

  function toggleSelection(kind: keyof ShowcaseSelection, value: string): void {
    setSelection((current) => ({ ...current, [kind]: toggleValue(current[kind], value) }));
    clearPreview();
  }

  function clearPreview(): void {
    setPreview(null);
    setPreviewStale(false);
    setPreviewError(null);
    setPublishError(null);
    publishKey.current = null;
  }

  async function requestPreview(): Promise<void> {
    if (!csrfToken || !projectId || isPreviewing) return;
    setIsPreviewing(true);
    setPreview(null);
    setPreviewStale(false);
    setPreviewError(null);
    setPublishError(null);
    publishKey.current = null;
    try {
      const request: ShowcasePreviewRequest = { projectId, selection };
      setPreview(await previewShowcase(request, csrfToken));
      setPreviewStale(false);
      publishKey.current = null;
    } catch {
      setPreviewError('The exact preview could not be prepared. Check your selections and try again.');
    } finally {
      setIsPreviewing(false);
    }
  }

  async function confirmPublish(): Promise<void> {
    if (!csrfToken || !preview || previewStale || isPublishing) return;
    setIsPublishing(true);
    setPublishError(null);
    try {
      publishKey.current ??= createIdempotencyKey();
      const result = await publishShowcase({
        projectId,
        selection,
        previewDigest: preview.previewDigest,
        sourceRevision: preview.sourceRevision
      }, csrfToken, publishKey.current);
      setPublished(result);
      setCurrentState('loaded');
      setPreview(null);
      setPreviewStale(false);
      publishKey.current = null;
      setConfirmOpen(false);
    } catch (error: unknown) {
      if (error instanceof ApiClientError && error.code === 'SHOWCASE_PREVIEW_STALE') {
        setPreviewStale(true);
        setPublishError('This project changed after the preview. Refresh the preview before publishing.');
        setConfirmOpen(false);
      } else {
        setPublishError('The showcase could not be published. The current published version remains in place. Try again.');
      }
    } finally {
      setIsPublishing(false);
    }
  }

  return (
    <main className="mx-auto grid w-full max-w-5xl gap-7 px-4 py-8 sm:px-6 lg:px-8" data-testid="showcase-publisher">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-border)] pb-6">
        <div><p className="product-label">Administrator</p><h1 className="text-3xl font-semibold">Publish a showcase</h1><p className="mt-2 max-w-2xl text-[var(--color-text-muted)]">Select public fields from one of your active projects, review every included value, then publish a fixed read-only snapshot.</p></div>
        <Link className="button button-secondary" to="/dashboard">Back to workspace</Link>
      </header>
      <CurrentPublication state={currentState} publication={published} />
      <Card className="grid gap-6 p-5 sm:p-7">
        <section className="grid gap-3">
          <Label htmlFor="showcase-source-project">Your active project</Label>
          {projectsState === 'loading' ? <Skeleton className="h-12 w-full" /> : null}
          {projectsState === 'error' ? <Alert tone="error"><p>Active projects could not be loaded.</p><Button type="button" variant="secondary" onClick={() => setProjectsReload((value) => value + 1)}>Try again</Button></Alert> : null}
          {projectsState === 'loaded' && projects.length === 0 ? <p className="text-[var(--color-text-muted)]">No active projects are available to preview.</p> : null}
          {projectsState === 'loaded' && projects.length > 0 ? (
            <select id="showcase-source-project" className="min-h-12 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3" value={projectId} onChange={(event) => chooseProject(event.target.value)} disabled={isPreviewing || isPublishing}>
              <option value="">Choose an active project</option>
              {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          ) : null}
        </section>
        {project ? <SelectionFields project={project} source={source} state={sourceState} selection={selection} disabled={isPreviewing || isPublishing} onToggle={toggleSelection} onReload={() => setSourceReload((value) => value + 1)} /> : null}
        {previewError ? <Alert tone="error" data-testid="showcase-preview-error">{previewError}</Alert> : null}
        <div className="flex flex-wrap gap-3">
          <Button type="button" variant="secondary" disabled={!project || sourceState !== 'loaded' || !csrfToken || isPreviewing} aria-busy={isPreviewing} onClick={() => { void requestPreview(); }}>
            {isPreviewing ? 'Preparing exact preview…' : previewStale ? 'Refresh preview' : 'Preview selection'}
          </Button>
          {project && !csrfToken ? <p className="self-center text-sm text-[var(--color-text-muted)]">Your admin session needs to be refreshed before you can preview.</p> : null}
        </div>
      </Card>
      {preview ? <ShowcasePreviewCard preview={preview} stale={previewStale} onPublish={() => setConfirmOpen(true)} publishingDisabled={!csrfToken || isPublishing} /> : null}
      {publishError ? <Alert tone="error" data-testid="showcase-publish-error">{publishError}</Alert> : null}
      {published ? <Alert tone="success" data-testid="showcase-publish-success"><strong>Showcase version {published.version} published.</strong><p>Published {formatPublishedAt(published.publishedAt)}. Future demos will use this version; existing demos stay unchanged.</p></Alert> : null}
      <AlertDialogRoot open={confirmOpen} onOpenChange={(open) => { if (!isPublishing) setConfirmOpen(open); }}>
        <AlertDialogContent aria-describedby="showcase-publish-confirm-description" data-testid="showcase-publish-confirm">
          <AlertDialogTitle className="text-xl font-semibold">Publish this showcase?</AlertDialogTitle>
          <AlertDialogDescription id="showcase-publish-confirm-description" className="mt-2 text-[var(--color-text-muted)]">The previewed content will be visible to demo visitors. Existing demos will not change.</AlertDialogDescription>
          <div className="mt-6 flex justify-end gap-3">
            <AlertDialogCancel asChild><Button type="button" variant="secondary" disabled={isPublishing}>Cancel</Button></AlertDialogCancel>
            <Button type="button" disabled={isPublishing} aria-busy={isPublishing} onClick={() => { void confirmPublish(); }}>{isPublishing ? 'Publishing…' : 'Publish showcase'}</Button>
          </div>
        </AlertDialogContent>
      </AlertDialogRoot>
    </main>
  );
}

function SelectionFields({ project, source, state, selection, disabled, onToggle, onReload }: {
  readonly project: ProjectSnapshot;
  readonly source: SourceItems | null;
  readonly state: LoadState;
  readonly selection: ShowcaseSelection;
  readonly disabled: boolean;
  readonly onToggle: (kind: keyof ShowcaseSelection, value: string) => void;
  readonly onReload: () => void;
}): React.JSX.Element {
  if (state === 'loading' || state === 'idle') return <div className="grid gap-4" aria-busy="true"><Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div>;
  if (state === 'error' || !source) return <Alert tone="error"><p>Project items could not be loaded safely.</p><Button type="button" variant="secondary" onClick={onReload} disabled={disabled}>Try again</Button></Alert>;
  return (
    <div className="grid gap-6">
      <fieldset className="grid gap-3" aria-labelledby="showcase-tasks-label">
        <legend id="showcase-tasks-label" className="font-semibold">Tasks</legend>
        {source.tasks.length ? source.tasks.map((task) => <label key={task.id} className="flex items-start gap-3 rounded-lg border border-[var(--color-border)] p-3"><input type="checkbox" className="mt-1 size-4 accent-[var(--color-primary)]" checked={selection.taskIds.includes(task.id)} onChange={() => onToggle('taskIds', task.id)} disabled={disabled} /><span>{task.title}<span className="block text-sm text-[var(--color-text-muted)]">{task.status.replaceAll('_', ' ')} · {task.importance} priority</span></span></label>) : <p className="text-sm text-[var(--color-text-muted)]">No eligible tasks are available.</p>}
      </fieldset>
      <fieldset className="grid gap-3" aria-labelledby="showcase-facts-label">
        <legend id="showcase-facts-label" className="font-semibold">Project facts</legend>
        {source.facts.length ? source.facts.map((fact) => <label key={fact.id} className="flex items-start gap-3 rounded-lg border border-[var(--color-border)] p-3"><input type="checkbox" className="mt-1 size-4 accent-[var(--color-primary)]" checked={selection.factIds.includes(fact.id)} onChange={() => onToggle('factIds', fact.id)} disabled={disabled} /><span>{fact.title}<span className="block text-sm text-[var(--color-text-muted)]">{fact.content}</span></span></label>) : <p className="text-sm text-[var(--color-text-muted)]">No active project facts are available.</p>}
      </fieldset>
      <fieldset className="grid gap-3" aria-labelledby="showcase-skills-label">
        <legend id="showcase-skills-label" className="font-semibold">Skills</legend>
        {source.skills.length ? source.skills.map((skill) => <label key={skill.id} className="flex items-start gap-3 rounded-lg border border-[var(--color-border)] p-3"><input type="checkbox" className="mt-1 size-4 accent-[var(--color-primary)]" checked={selection.skillIds.includes(skill.id)} onChange={() => onToggle('skillIds', skill.id)} disabled={disabled} /><span>{skill.title}<span className="block whitespace-pre-wrap text-sm text-[var(--color-text-muted)]">{skill.instructions}</span><span className="mt-1 block text-xs text-[var(--color-text-muted)]">Tools: {skill.declaredTools.join(', ') || 'None'}</span></span></label>) : <p className="text-sm text-[var(--color-text-muted)]">No enabled skills are eligible for this workspace.</p>}
      </fieldset>
      <fieldset className="grid gap-3" aria-labelledby="showcase-files-label">
        <legend id="showcase-files-label" className="font-semibold">Regular files</legend>
        {!project.capabilities.fileAccess ? <p className="text-sm text-[var(--color-text-muted)]">This project has no file access.</p> : source.files.length ? source.files.map((file) => <label key={file.path} className="flex items-start gap-3 rounded-lg border border-[var(--color-border)] p-3"><input type="checkbox" className="mt-1 size-4 accent-[var(--color-primary)]" checked={selection.filePaths.includes(file.path)} onChange={() => onToggle('filePaths', file.path)} disabled={disabled} /><span className="break-all">{file.path}<span className="block text-sm text-[var(--color-text-muted)]">{formatBytes(file.sizeBytes)}</span></span></label>) : <p className="text-sm text-[var(--color-text-muted)]">No regular files are available.</p>}
        {source.filesTruncated ? <p className="text-sm text-[var(--color-warning)]">The safe workspace listing is truncated. Only listed files can be included.</p> : null}
      </fieldset>
      <p className="text-sm text-[var(--color-text-muted)]">Nothing is selected automatically. Chats, histories, credentials, settings, and unselected items are excluded.</p>
    </div>
  );
}

function ShowcasePreviewCard({ preview, stale, onPublish, publishingDisabled }: {
  readonly preview: ShowcasePreview;
  readonly stale: boolean;
  readonly onPublish: () => void;
  readonly publishingDisabled: boolean;
}): React.JSX.Element {
  return (
    <Card className="grid gap-6 p-5 sm:p-7" data-testid="showcase-preview">
      <header><p className="product-label">Exact publication preview</p><h2 className="text-2xl font-semibold">{preview.project.name}</h2>{preview.project.objective ? <p className="mt-2 text-[var(--color-text-muted)]">{preview.project.objective}</p> : null}<p className="mt-3 text-sm text-[var(--color-text-muted)]">Visitors will receive only the fields and file bytes shown here. {preview.totals.itemCount} items · {preview.totals.fileCount} files · {formatBytes(preview.totals.snapshotBytes)} total.</p></header>
      {stale ? <Alert tone="warning">This preview is stale. Refresh it before publishing.</Alert> : null}
      <section className="grid gap-3" aria-labelledby="preview-tasks-title"><h3 id="preview-tasks-title" className="font-semibold">Selected tasks</h3>{preview.tasks.length ? preview.tasks.map((task, index) => <Card key={`${task.title}-${index}`} className="grid gap-2 p-4"><p className="font-medium">{task.title}</p><p className="text-sm text-[var(--color-text-muted)]">{task.status.replaceAll('_', ' ')} · {task.importance}{task.deadline ? ` · Due ${task.deadline}` : ''}</p>{task.details ? <p className="whitespace-pre-wrap">{task.details}</p> : null}{task.checklist.length ? <ul className="grid gap-1">{task.checklist.map((item, itemIndex) => <li key={`${item.title}-${itemIndex}`}>{item.completed ? '✓' : '○'} {item.title}</li>)}</ul> : null}</Card>) : <p className="text-sm text-[var(--color-text-muted)]">No tasks selected.</p>}</section>
      <section className="grid gap-3" aria-labelledby="preview-facts-title"><h3 id="preview-facts-title" className="font-semibold">Selected facts</h3>{preview.facts.length ? preview.facts.map((fact, index) => <Card key={`${fact.title}-${index}`} className="p-4"><h4 className="font-medium">{fact.title}</h4><p className="mt-1 whitespace-pre-wrap">{fact.content}</p></Card>) : <p className="text-sm text-[var(--color-text-muted)]">No facts selected.</p>}</section>
      <section className="grid gap-3" aria-labelledby="preview-skills-title"><h3 id="preview-skills-title" className="font-semibold">Selected skills</h3>{preview.skills.length ? preview.skills.map((skill, index) => <Card key={`${skill.title}-${index}`} className="grid gap-2 p-4"><h4 className="font-medium">{skill.title}</h4><p className="whitespace-pre-wrap text-sm">{skill.instructions}</p><p className="text-xs text-[var(--color-text-muted)]">Declared tools: {skill.declaredTools.join(', ') || 'None'}</p></Card>) : <p className="text-sm text-[var(--color-text-muted)]">No skills selected.</p>}</section>
      <section className="grid gap-3" aria-labelledby="preview-files-title"><h3 id="preview-files-title" className="font-semibold">Selected files and exact bytes</h3>{preview.files.length ? preview.files.map((file) => <Card key={file.name} className="grid gap-3 p-4"><h4 className="break-all font-medium">{file.name}</h4><PreviewFileContent file={file} /></Card>) : <p className="text-sm text-[var(--color-text-muted)]">No files selected.</p>}</section>
      <section className="grid gap-2" aria-labelledby="preview-exclusions-title"><h3 id="preview-exclusions-title" className="font-semibold">Excluded from the snapshot</h3><ul className="grid list-disc gap-1 pl-5 text-sm text-[var(--color-text-muted)]">{preview.exclusions.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></section>
      <Button type="button" className="w-fit" disabled={publishingDisabled || stale} onClick={onPublish}>Publish showcase</Button>
    </Card>
  );
}

function CurrentPublication({ state, publication }: { readonly state: LoadState; readonly publication: ShowcasePublishResult | null }): React.JSX.Element {
  if (state === 'loading') return <Skeleton className="h-20" />;
  if (state === 'error') return <Alert tone="warning">Current publication status is unavailable. You can still review a preview; publishing remains protected by the server.</Alert>;
  return publication
    ? <Alert tone="info" data-testid="current-showcase-version">Current published version {publication.version} · {formatPublishedAt(publication.publishedAt)}.</Alert>
    : <Alert tone="info" data-testid="current-showcase-version">No showcase is published. The public view remains empty until you publish one.</Alert>;
}

function toggleValue(values: readonly string[], value: string): readonly string[] {
  return values.includes(value) ? values.filter((candidate) => candidate !== value) : [...values, value];
}

function formatPublishedAt(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date) : 'date unavailable';
}

function formatBytes(value: number): string {
  if (value < 1000) return `${value} bytes`;
  const units = ['KB', 'MB', 'GB'] as const;
  let amount = value / 1000;
  let index = 0;
  while (amount >= 1000 && index < units.length - 1) {
    amount /= 1000;
    index += 1;
  }
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[index]}`;
}
