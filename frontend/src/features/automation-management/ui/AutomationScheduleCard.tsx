import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

import type { AutomationSchedule } from '@/entities/automation';
import type { UserSkill } from '@/entities/skill';
import { formatDateInTimeZone, occurrenceStatusLabel } from '@/features/automation-management/model/automation-presentation';
import type { RunState, ScheduleHistoryState } from '@/features/automation-management/model/use-automation-management';
import { scheduleActionError } from '@/features/automation-management/model/use-automation-management';
import { Alert, Button, Card } from '@/shared/ui';

interface AutomationScheduleCardProps {
  readonly schedule: AutomationSchedule;
  readonly workspaceName: string;
  readonly workspaceAvailable: boolean;
  readonly skill: UserSkill | null;
  readonly skillLoading: boolean;
  readonly history: ScheduleHistoryState;
  readonly runState: RunState;
  readonly historyContent: ReactNode;
  readonly csrfAvailable: boolean;
  readonly historyOpen: boolean;
  readonly onEdit: () => void;
  readonly onToggleHistory: () => void;
  readonly onRun: () => void;
  readonly onRetryRun: () => void;
  readonly onToggleSchedule: () => Promise<void>;
}

export function AutomationScheduleCard({
  schedule, workspaceName, workspaceAvailable, skill, skillLoading, history, runState, historyContent, csrfAvailable, historyOpen,
  onEdit, onToggleHistory, onRun, onRetryRun, onToggleSchedule
}: AutomationScheduleCardProps): React.JSX.Element {
  const [savingToggle, setSavingToggle] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const skillAvailable = Boolean(skill && skill.enabled && skill.version === schedule.skillVersion
    && skill.declaredTools.every((tool) => tool === 'home_task_read' || tool === 'home_workspace_read'));
  const unresolved = history.status !== 'success' || history.occurrences.some((occurrence) =>
    ['queued', 'claimed', 'dispatching', 'running', 'cancel_requested', 'interrupted_unknown'].includes(occurrence.status));
  const canRun = csrfAvailable && workspaceAvailable && skillAvailable && !unresolved && runState.status === 'idle';
  const nextRun = formatDateInTimeZone(schedule.nextDueAt, schedule.timeZone);

  async function toggleSchedule(): Promise<void> {
    setSavingToggle(true);
    setToggleError(null);
    try { await onToggleSchedule(); }
    catch (error: unknown) { setToggleError(scheduleActionError(error, 'The schedule could not be updated. Reload and try again.')); }
    finally { setSavingToggle(false); }
  }

  return <Card className="grid gap-4 p-5" data-testid={`automation-schedule-${schedule.id}`}>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="grid gap-1"><h2 className="text-lg font-semibold">Daily briefing</h2><p>{workspaceAvailable ? workspaceName : 'Workspace unavailable'} · {skillLoading ? 'Loading skill…' : skillAvailable && skill ? `${skill.title} · v${schedule.skillVersion}` : 'Skill unavailable'}</p><p className="text-sm text-[var(--color-text-muted)]">{schedule.enabled ? 'Enabled' : 'Paused'} · {schedule.localTime} ({schedule.timeZone})</p></div>
      <div className="grid gap-1 text-sm sm:text-right"><p><span className="font-medium">Next run:</span> {schedule.enabled ? `${nextRun} (${schedule.timeZone})` : 'No next run'}</p><p><span className="font-medium">Last outcome:</span> {schedule.lastRunStatus ? occurrenceStatusLabel(schedule.lastRunStatus, null) : 'No runs yet'}</p></div>
    </div>
    {toggleError ? <Alert tone="error" role="alert">{toggleError}</Alert> : null}
    {runState.message ? <Alert tone={runState.status === 'uncertain' ? 'warning' : 'info'} role={runState.status === 'uncertain' ? 'alert' : 'status'} aria-live={runState.status === 'uncertain' ? undefined : 'polite'}>{runState.message}</Alert> : null}
    {workspaceAvailable && !skillLoading && !skillAvailable ? <Alert tone="warning">This schedule needs an enabled current read-only skill. <Link className="underline" to={`/projects/${encodeURIComponent(schedule.workspaceId)}/skills`}>Choose a skill in Edit</Link>.</Alert> : null}
    <div className="flex flex-wrap gap-2">
      {runState.status === 'uncertain'
        ? <Button type="button" disabled={history.status !== 'success' || unresolved || !csrfAvailable} onClick={onRetryRun}>Retry same Run now</Button>
        : <Button type="button" disabled={!canRun} aria-busy={runState.status === 'submitting'} onClick={onRun}>{runState.status === 'submitting' ? 'Queueing…' : 'Run now'}</Button>}
      <Button type="button" variant="secondary" aria-expanded={historyOpen} aria-controls={`automation-history-${schedule.id}`} onClick={onToggleHistory}>{historyOpen ? 'Hide history' : 'Run history'}</Button>
      <Button type="button" variant="secondary" onClick={onEdit} disabled={!workspaceAvailable}>Edit</Button>
      <Button type="button" variant="ghost" onClick={() => { void toggleSchedule(); }} disabled={!csrfAvailable || savingToggle || !workspaceAvailable || (!schedule.enabled && !skillAvailable)} aria-busy={savingToggle}>{savingToggle ? 'Saving…' : schedule.enabled ? 'Pause' : 'Resume'}</Button>
    </div>
    <div hidden={!historyOpen} className="grid gap-3 border-t border-[var(--color-border)] pt-4"><p className="text-sm text-[var(--color-text-muted)]">History is retained when a schedule is paused.</p>{historyContent}</div>
  </Card>;
}
