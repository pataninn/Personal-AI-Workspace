import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import type { AutomationSchedule, UpdateAutomationScheduleRequest } from '@/entities/automation';
import { selectProjectListStatus, selectProjects, loadProjects } from '@/entities/project';
import { listSkillsForWorkspace } from '@/entities/skill';
import type { UserSkill } from '@/entities/skill';
import { selectCsrfToken } from '@/entities/user-session';
import { ApiClientError } from '@/shared/api';
import { createIdempotencyKey } from '@/shared/lib/idempotency-key';
import { Alert, Button, Card, Skeleton } from '@/shared/ui';
import { AutomationRunHistory, AutomationScheduleCard, AutomationScheduleForm, useAutomationManagement } from '@/features/automation-management';
import type { ScheduleHistoryState } from '@/features/automation-management';

type ScheduleFormMode = { readonly kind: 'create'; readonly workspaceId: string } | { readonly kind: 'edit'; readonly scheduleId: string };

const EMPTY_HISTORY: ScheduleHistoryState = {
  status: 'loading', occurrences: [], nextCursor: null, errorMessage: null, loadingMore: false
};

export function AutomationsPage(): React.JSX.Element {
  const dispatch = useAppDispatch();
  const management = useAutomationManagement();
  const [searchParams] = useSearchParams();
  const projects = useAppSelector(selectProjects);
  const projectStatus = useAppSelector(selectProjectListStatus);
  const csrfToken = useAppSelector(selectCsrfToken);
  const [formMode, setFormMode] = useState<ScheduleFormMode | null>(null);
  const [historyScheduleId, setHistoryScheduleId] = useState<string | null>(null);
  const [skillsByWorkspace, setSkillsByWorkspace] = useState<Readonly<Record<string, readonly UserSkill[]>>>({});
  const [loadedSkillWorkspaces, setLoadedSkillWorkspaces] = useState<ReadonlySet<string>>(new Set());
  const [latestConflict, setLatestConflict] = useState<AutomationSchedule | null>(null);
  const [formEpoch, setFormEpoch] = useState(0);

  useEffect(() => {
    let active = true;
    const workspaceIds = [...new Set(management.schedules.map((schedule) => schedule.workspaceId))];
    setLoadedSkillWorkspaces(new Set());
    void Promise.all(workspaceIds.map(async (workspaceId) => {
      try { return [workspaceId, await listSkillsForWorkspace(workspaceId)] as const; }
      catch { return [workspaceId, []] as const; }
    })).then((entries) => {
      if (!active) return;
      setSkillsByWorkspace(Object.fromEntries(entries));
      setLoadedSkillWorkspaces(new Set(workspaceIds));
    });
    return () => { active = false; };
  }, [management.schedules]);

  const activeProjects = projects.filter((project) => project.status === 'active');
  const projectLoadError = projectStatus === 'error'
    ? 'Workspaces could not be loaded. Try again.' : null;
  const projectsLoading = projectStatus === 'idle' || projectStatus === 'loading';
  const editSchedule = formMode?.kind === 'edit'
    ? management.schedules.find((schedule) => schedule.id === formMode.scheduleId) ?? null : null;
  const formSchedule = formMode?.kind === 'edit' ? latestConflict ?? editSchedule ?? undefined : undefined;
  const workspaceForForm = formSchedule?.workspaceId ?? (formMode?.kind === 'create' ? formMode.workspaceId : '');

  async function refreshConflict(): Promise<readonly AutomationSchedule[]> {
    const refreshed = await management.refresh();
    if (formMode?.kind === 'edit') {
      setLatestConflict(refreshed.find((schedule) => schedule.id === formMode.scheduleId) ?? null);
    }
    return refreshed;
  }

  async function reloadLatestSchedule(): Promise<void> {
    const refreshed = await refreshConflict();
    if (formMode?.kind !== 'edit') return;
    const latest = refreshed.find((schedule) => schedule.id === formMode.scheduleId);
    if (!latest) return;
    setLatestConflict(null);
    setFormEpoch((epoch) => epoch + 1);
  }

  async function createSchedule(request: Parameters<typeof management.create>[0], key: string): Promise<void> {
    const created = await management.create(request, key);
    setHistoryScheduleId(created.id);
    setFormMode(null);
  }

  async function updateSchedule(scheduleId: string, request: UpdateAutomationScheduleRequest): Promise<AutomationSchedule> {
    return management.update(scheduleId, request);
  }

  async function toggleSchedule(schedule: AutomationSchedule): Promise<void> {
    const updated = await management.update(schedule.id, { expectedRevision: schedule.revision, enabled: !schedule.enabled });
    if (!updated.enabled) setHistoryScheduleId(schedule.id);
  }

  function openCreate(): void {
    setLatestConflict(null);
    setFormMode({ kind: 'create', workspaceId: searchParams.get('workspaceId') ?? '' });
    setFormEpoch((epoch) => epoch + 1);
  }

  function openEdit(scheduleId: string): void {
    setLatestConflict(null);
    setFormMode({ kind: 'edit', scheduleId });
    setFormEpoch((epoch) => epoch + 1);
  }

  return <div className="grid gap-6" data-testid="automations-page">
    <header className="grid gap-2 [&>h1]:m-0 [&>p]:m-0"><p className="product-label">Workspace tools</p><h1>Automations</h1><p className="text-[var(--color-text-muted)]">Start your day with a scheduled workspace briefing.</p></header>
    {management.readyNotice ? <Alert tone="success" role="status" live="polite" data-testid="automation-ready-notice"><div className="flex flex-wrap items-center justify-between gap-3"><p>Your daily briefing is ready.</p><div className="flex flex-wrap items-center gap-3"><Link className="font-medium underline underline-offset-4" to={briefingUrl(management.readyNotice.schedule)}>Open briefing</Link><Button type="button" variant="ghost" onClick={management.dismissNotice}>Dismiss</Button></div></div></Alert> : null}
    <div className="flex flex-wrap justify-between gap-3"><p className="text-sm text-[var(--color-text-muted)]">Find each briefing in your workspace chat.</p>{management.schedules.length > 0 ? <Button type="button" onClick={openCreate}>Create daily briefing</Button> : null}</div>
    {formMode ? <AutomationScheduleForm
      key={`${formMode.kind}-${formMode.kind === 'edit' ? formMode.scheduleId : formMode.workspaceId}-${formEpoch}`}
      projects={projects}
      projectsLoading={projectsLoading}
      projectsError={projectLoadError}
      csrfAvailable={Boolean(csrfToken)}
      initialWorkspaceId={workspaceForForm}
      schedule={formSchedule}
      onCancel={() => { setFormMode(null); setLatestConflict(null); }}
      onCreate={createSchedule}
      onUpdate={updateSchedule}
      onConflict={async () => { await refreshConflict(); }}
      onReloadLatest={reloadLatestSchedule}
      onRetryProjects={() => { void dispatch(loadProjects()); }}
    /> : null}
    {management.scheduleStatus === 'loading' ? <div aria-busy="true" aria-label="Loading schedules"><Skeleton className="h-28" /><Skeleton className="h-28" /></div> : null}
    {management.scheduleStatus === 'error' ? <Alert tone="error" role="alert">{management.scheduleError ?? 'Schedules could not be loaded.'}<Button type="button" variant="secondary" className="mt-2" onClick={() => { void management.refresh(); }}>Try again</Button></Alert> : null}
    {management.scheduleStatus === 'success' && management.schedules.length === 0 ? <Card className="grid gap-3 p-5"><h2 className="text-lg font-semibold">No daily briefings scheduled.</h2><p className="text-sm text-[var(--color-text-muted)]">Choose a workspace and a saved skill to get started.</p><Button type="button" className="w-fit" onClick={openCreate}>Create daily briefing</Button></Card> : null}
    {management.scheduleStatus === 'success' ? management.schedules.map((schedule) => {
      const workspace = projects.find((project) => project.id === schedule.workspaceId);
      const history = management.histories[schedule.id] ?? EMPTY_HISTORY;
      const skill = (skillsByWorkspace[schedule.workspaceId] ?? []).find((candidate) => candidate.id === schedule.skillId) ?? null;
      const historyOpen = historyScheduleId === schedule.id;
      return <AutomationScheduleCard
        key={schedule.id}
        schedule={schedule}
        workspaceName={workspace?.name ?? 'Workspace unavailable'}
        workspaceAvailable={workspace?.status === 'active'}
        skill={skill}
        skillLoading={!loadedSkillWorkspaces.has(schedule.workspaceId)}
        history={history}
        runState={management.runStates[schedule.id] ?? { status: 'idle', message: null }}
        historyContent={<AutomationRunHistory
          schedule={schedule}
          workspaceName={workspace?.name ?? 'Workspace unavailable'}
          history={history}
          onRetry={() => { void management.refreshHistory(schedule.id); }}
          onLoadMore={() => { void management.loadMoreHistory(schedule.id); }}
          onRunNow={() => { setHistoryScheduleId(schedule.id); void management.run(schedule.id); }}
        />}
        csrfAvailable={Boolean(csrfToken)}
        historyOpen={historyOpen}
        onEdit={() => openEdit(schedule.id)}
        onToggleHistory={() => setHistoryScheduleId(historyOpen ? null : schedule.id)}
        onRun={() => { setHistoryScheduleId(schedule.id); void management.run(schedule.id); }}
        onRetryRun={() => { void management.retryRun(schedule.id); }}
        onToggleSchedule={() => toggleSchedule(schedule)}
      />;
    }) : null}
  </div>;
}

function briefingUrl(schedule: AutomationSchedule): string {
  return `/projects/${encodeURIComponent(schedule.workspaceId)}/planning-chat?conversation=${encodeURIComponent(schedule.conversationId)}`;
}
