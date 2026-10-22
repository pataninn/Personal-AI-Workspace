import { Link } from 'react-router-dom';

import type { AutomationOccurrence, AutomationSchedule } from '@/entities/automation';
import { formatDateInTimeZone, occurrenceStatusLabel } from '@/features/automation-management/model/automation-presentation';
import type { ScheduleHistoryState } from '@/features/automation-management/model/use-automation-management';
import { Alert, Button, Card, Skeleton } from '@/shared/ui';

interface AutomationRunHistoryProps {
  readonly schedule: AutomationSchedule;
  readonly workspaceName: string;
  readonly history: ScheduleHistoryState;
  readonly onRetry: () => void;
  readonly onLoadMore: () => void;
  readonly onRunNow: () => void;
}

export function AutomationRunHistory({ schedule, workspaceName, history, onRetry, onLoadMore, onRunNow }: AutomationRunHistoryProps): React.JSX.Element {
  return <section id={`automation-history-${schedule.id}`} className="grid gap-3" aria-labelledby={`automation-history-title-${schedule.id}`} data-testid={`automation-history-${schedule.id}`}>
    <header><h3 id={`automation-history-title-${schedule.id}`} className="text-lg font-semibold">Run history · {workspaceName}</h3></header>
    {history.status === 'loading' ? <div aria-busy="true" aria-label="Loading run history"><Skeleton className="h-24" /><Skeleton className="h-24" /></div> : null}
    {history.status === 'error' ? <Alert tone="error" role="alert">{history.errorMessage ?? 'Run history could not be loaded. Try again.'}<Button type="button" variant="secondary" className="mt-2" onClick={onRetry}>Try again</Button></Alert> : null}
    {history.status === 'success' && history.occurrences.length === 0 ? <Card className="grid gap-3 p-4"><p>No runs yet.</p><Button type="button" onClick={onRunNow}>Run now</Button></Card> : null}
    {history.status === 'success' && history.occurrences.map((occurrence) => <OccurrenceCard key={occurrence.id} occurrence={occurrence} schedule={schedule} />)}
    {history.status === 'success' && history.nextCursor ? <Button type="button" variant="secondary" onClick={onLoadMore} disabled={history.loadingMore} aria-busy={history.loadingMore}>{history.loadingMore ? 'Loading…' : 'Load more'}</Button> : null}
    {history.errorMessage && history.status === 'success' ? <Alert tone="error" role="alert">{history.errorMessage}</Alert> : null}
  </section>;
}

function OccurrenceCard({ occurrence, schedule }: { readonly occurrence: AutomationOccurrence; readonly schedule: AutomationSchedule }): React.JSX.Element {
  const resultUrl = `/projects/${encodeURIComponent(schedule.workspaceId)}/planning-chat?conversation=${encodeURIComponent(schedule.conversationId)}`;
  const usage = occurrence.providerUsage;
  const statusLabel = occurrence.status === 'succeeded' && usage.calls.some((call) => call.status === 'over_bound')
    ? 'Completed — usage exceeded the configured bound'
    : occurrenceStatusLabel(occurrence.status, occurrence.failureCode);
  return <Card className="grid gap-3 p-4" data-testid={`automation-occurrence-${occurrence.id}`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="font-medium">{occurrence.kind === 'manual' ? 'Run now' : 'Scheduled'} · {formatDateInTimeZone(occurrence.intendedFor, schedule.timeZone)} ({schedule.timeZone})</p></div>
      <p className="rounded-full border border-[var(--color-border)] px-3 py-1 text-sm">{statusLabel}</p>
    </div>
    {occurrence.status === 'failed' ? <p className="text-sm text-[var(--color-text-muted)]">This run did not complete.</p> : null}
    {occurrence.homeTurnId ? <Link className="text-[var(--color-link)] underline underline-offset-4" to={resultUrl}>{occurrence.status === 'succeeded' ? 'Open briefing' : 'Open conversation'}</Link> : null}
    {occurrence.taskSources.length ? <div className="grid gap-1"><h4 className="text-sm font-medium">Source tasks</h4><ul className="grid gap-1">{occurrence.taskSources.map((source) => <li key={`${source.taskId}:${source.revision}`} className="text-sm">{source.available && source.href ? <Link className="text-[var(--color-link)] underline underline-offset-4" to={source.href}>{source.title ?? 'Source task'} · revision {source.revision}</Link> : <span>Source unavailable · revision {source.revision}</span>}</li>)}</ul></div> : null}
  </Card>;
}
