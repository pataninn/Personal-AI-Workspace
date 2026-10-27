import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { ProjectTaskStatusLabel, TASK_IMPORTANCE_LABELS } from '@/entities/project-task';
import { useAppSelector } from '@/app/store/hooks';
import { selectPrincipal } from '@/entities/user-session';
import { downloadShowcaseFile, getCurrentShowcase } from '@/entities/showcase';
import type { CurrentShowcase, ShowcaseFile, ShowcaseTask } from '@/entities/showcase';
import { ApiClientError } from '@/shared/api';
import { Alert, Button, Card, Skeleton } from '@/shared/ui';

type ShowcaseState = 'loading' | 'unpublished' | 'error' | 'loaded';

export function ShowcasePage(): React.JSX.Element {
  const principal = useAppSelector(selectPrincipal);
  const [showcase, setShowcase] = useState<CurrentShowcase | null>(null);
  const [state, setState] = useState<ShowcaseState>('loading');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setState('loading');
    void getCurrentShowcase()
      .then((value) => {
        if (active) {
          setShowcase(value);
          setState('loaded');
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        setShowcase(null);
        setState(isUnpublished(error) ? 'unpublished' : 'error');
      });
    return () => { active = false; };
  }, [reloadKey]);

  return (
    <main className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-8 sm:px-6 lg:px-8" data-testid="showcase-page">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-border)] pb-6">
        <div>
          <p className="product-label brand-wordmark">Threadnest<span className="brand-dot" aria-hidden="true">.</span></p>
          <h1 className="text-3xl font-semibold sm:text-4xl">Published showcase</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-full border border-[var(--color-border-strong)] px-3 py-1 text-sm font-medium">Read only</span>
          {principal?.accountKind === 'demo' ? <Link className="button button-secondary" to="/dashboard">Back to my demo</Link> : <Link className="button button-primary" to="/login?returnTo=%2Fdashboard">Try demo</Link>}
          {principal?.role !== 'admin' ? <Link className="text-[var(--color-link)] underline underline-offset-4" to="/login?returnTo=%2Fshowcase">Sign in</Link> : <Link className="text-[var(--color-link)] underline underline-offset-4" to="/admin/showcase">Manage showcase</Link>}
        </div>
      </header>
      {state === 'loading' ? <ShowcaseLoading /> : null}
      {state === 'unpublished' ? <ShowcaseEmpty onTryAgain={() => setReloadKey((key) => key + 1)} /> : null}
      {state === 'error' ? <ShowcaseError onTryAgain={() => setReloadKey((key) => key + 1)} principalIsDemo={principal?.accountKind === 'demo'} /> : null}
      {state === 'loaded' && showcase ? <ShowcaseContent showcase={showcase} /> : null}
    </main>
  );
}

function ShowcaseLoading(): React.JSX.Element {
  return (
    <section className="grid gap-4" data-testid="showcase-loading" aria-busy="true" aria-label="Loading published showcase">
      <Skeleton className="h-10 w-2/3" />
      <Skeleton className="h-24 w-full" />
      <div className="m-0 grid list-none gap-4 p-0 md:grid-cols-2"><Skeleton className="h-44" /><Skeleton className="h-44" /></div>
    </section>
  );
}

function ShowcaseEmpty({ onTryAgain }: { readonly onTryAgain: () => void }): React.JSX.Element {
  return (
    <Card className="grid gap-3 p-6 sm:p-8" data-testid="showcase-unpublished">
      <h2 className="text-xl font-semibold">No showcase is available right now.</h2>
      <p className="text-[var(--color-text-muted)]">A sample project will appear here when it is ready.</p>
      <Button type="button" variant="secondary" className="w-fit" onClick={onTryAgain}>Try again</Button>
    </Card>
  );
}

function ShowcaseError({ onTryAgain, principalIsDemo }: { readonly onTryAgain: () => void; readonly principalIsDemo: boolean }): React.JSX.Element {
  return (
    <Card className="grid gap-3 p-6 sm:p-8" data-testid="showcase-error">
      <Alert tone="error">Showcase could not be loaded.</Alert>
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="secondary" onClick={onTryAgain}>Try again</Button>
        {principalIsDemo ? <Link className="button button-ghost" to="/dashboard">Back to my demo</Link> : <Link className="button button-secondary" to="/login?returnTo=%2Fdashboard">Try demo</Link>}
      </div>
    </Card>
  );
}

function ShowcaseContent({ showcase }: { readonly showcase: CurrentShowcase }): React.JSX.Element {
  return (
    <div className="grid gap-8" data-testid="showcase-content">
      <Card className="grid gap-3 p-6 sm:p-8">
        <p className="text-sm text-[var(--color-text-muted)]">Public example · Published {formatPublishedAt(showcase.publishedAt)}</p>
        <h2 className="text-3xl font-semibold">{showcase.project.name}</h2>
        {showcase.project.objective ? <p className="max-w-3xl text-[var(--color-text-muted)]">{showcase.project.objective}</p> : null}
      </Card>
      <section className="grid gap-4" aria-labelledby="showcase-tasks-title">
        <div><p className="product-label">Selected work</p><h2 id="showcase-tasks-title" className="text-2xl font-semibold">Tasks</h2></div>
        {showcase.tasks.length ? <ul className="m-0 grid list-none gap-4 p-0 md:grid-cols-2">{showcase.tasks.map((task) => <li key={task.id}><TaskCard task={task} /></li>)}</ul> : <p className="text-[var(--color-text-muted)]">No tasks were included in this snapshot.</p>}
      </section>
      <section className="grid gap-4" aria-labelledby="showcase-facts-title">
        <div><p className="product-label">Project notes</p><h2 id="showcase-facts-title" className="text-2xl font-semibold">Facts</h2></div>
        {showcase.facts.length ? <ul className="m-0 grid list-none gap-4 p-0 md:grid-cols-2">{showcase.facts.map((fact) => <li key={fact.id}><Card className="h-full p-5"><h3 className="font-semibold">{fact.title}</h3><p className="mt-2 whitespace-pre-wrap text-[var(--color-text-muted)]">{fact.content}</p></Card></li>)}</ul> : <p className="text-[var(--color-text-muted)]">No project facts were included in this snapshot.</p>}
      </section>
      <section className="grid gap-4" aria-labelledby="showcase-skills-title">
        <div><p className="product-label">Reusable guidance</p><h2 id="showcase-skills-title" className="text-2xl font-semibold">Skills</h2></div>
        {showcase.skills.length ? <ul className="m-0 grid list-none gap-4 p-0 md:grid-cols-2">{showcase.skills.map((skill) => <li key={skill.id}><Card className="grid h-full gap-3 p-5"><h3 className="font-semibold">{skill.title}</h3><p className="whitespace-pre-wrap text-sm text-[var(--color-text-muted)]">{skill.instructions}</p><p className="text-xs text-[var(--color-text-muted)]">Tools: {skill.declaredTools.map((tool) => tool.replace(/^home_/u, '').replaceAll('_', ' ')).join(', ') || 'None'}</p></Card></li>)}</ul> : <p className="text-[var(--color-text-muted)]">No skills were included in this snapshot.</p>}
      </section>
      <section className="grid gap-4" aria-labelledby="showcase-files-title">
        <div><p className="product-label">Included documents</p><h2 id="showcase-files-title" className="text-2xl font-semibold">Files</h2></div>
        {showcase.files.length ? <ul className="m-0 grid list-none gap-3 p-0 md:grid-cols-2">{showcase.files.map((file) => <li key={file.id}><ShowcaseFileRow file={file} /></li>)}</ul> : <p className="text-[var(--color-text-muted)]">No files were included in this snapshot.</p>}
      </section>
    </div>
  );
}

function TaskCard({ task }: { readonly task: ShowcaseTask }): React.JSX.Element {
  return (
    <Card className="grid h-full gap-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{task.title}</h3><ProjectTaskStatusLabel status={task.status} /></div>
      <p className="text-sm text-[var(--color-text-muted)]">{TASK_IMPORTANCE_LABELS[task.importance]} priority{task.deadline ? ` · Due ${task.deadline}` : ''}</p>
      {task.details ? <p className="whitespace-pre-wrap">{task.details}</p> : null}
      {task.checklist.length ? <ul className="grid gap-2 border-t border-[var(--color-border)] pt-3">{task.checklist.map((item) => <li key={item.id} className="flex gap-2"><span aria-hidden="true">{item.completed ? '✓' : '○'}</span><span>{item.title}</span><span className="sr-only">{item.completed ? 'completed' : 'not completed'}</span></li>)}</ul> : null}
    </Card>
  );
}

function ShowcaseFileRow({ file }: { readonly file: ShowcaseFile }): React.JSX.Element {
  const [downloading, setDownloading] = useState(false);
  const [failed, setFailed] = useState(false);
  async function download(): Promise<void> {
    if (downloading) return;
    setDownloading(true);
    setFailed(false);
    try {
      await downloadShowcaseFile(file);
    } catch {
      setFailed(true);
    } finally {
      setDownloading(false);
    }
  }
  return (
    <Card className="grid gap-3 p-4">
      <div><h3 className="break-all font-medium">{file.name}</h3><p className="text-sm text-[var(--color-text-muted)]">{formatBytes(file.byteLength)} · {file.mediaType}</p></div>
      <Button type="button" variant="secondary" className="w-fit" disabled={downloading} aria-busy={downloading} onClick={() => { void download(); }}>{downloading ? 'Preparing download…' : 'Download file'}</Button>
      {failed ? <p className="text-sm text-[var(--color-error)]" role="alert">This showcase file could not be downloaded.</p> : null}
    </Card>
  );
}

function isUnpublished(error: unknown): boolean {
  return error instanceof ApiClientError && (error.code === 'SHOWCASE_NOT_PUBLISHED' || error.statusCode === 404);
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
