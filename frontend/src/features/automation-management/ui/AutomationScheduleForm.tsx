import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import type { AutomationSchedule, CreateAutomationScheduleRequest, UpdateAutomationScheduleRequest } from '@/entities/automation';
import { listSkillsForWorkspace } from '@/entities/skill';
import type { ProjectSnapshot } from '@/entities/project';
import type { UserSkill } from '@/entities/skill';
import { ApiClientError } from '@/shared/api';
import { createIdempotencyKey } from '@/shared/lib/idempotency-key';
import { Alert, Button, Card, Input, Label, Skeleton } from '@/shared/ui';
import { isValidTimeZone } from '@/features/automation-management/model/automation-presentation';
import { scheduleActionError } from '@/features/automation-management/model/use-automation-management';

const READ_ONLY_TOOLS = new Set(['home_task_read', 'home_workspace_read']);
type FormField = 'workspaceId' | 'skill' | 'localTime' | 'timeZone';

interface AutomationScheduleFormProps {
  readonly projects: readonly ProjectSnapshot[];
  readonly projectsLoading: boolean;
  readonly projectsError: string | null;
  readonly csrfAvailable: boolean;
  readonly initialWorkspaceId: string;
  readonly schedule?: AutomationSchedule;
  readonly onCancel: () => void;
  readonly onCreate: (request: CreateAutomationScheduleRequest, key: string) => Promise<void>;
  readonly onUpdate: (scheduleId: string, request: UpdateAutomationScheduleRequest) => Promise<AutomationSchedule>;
  readonly onConflict: () => Promise<void>;
  readonly onReloadLatest: () => Promise<void>;
  readonly onRetryProjects: () => void;
}

interface PendingCreate {
  readonly request: CreateAutomationScheduleRequest;
  readonly key: string;
}

function browserTimeZone(): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timeZone && isValidTimeZone(timeZone) ? timeZone : 'UTC';
}

function isEligibleSkill(skill: UserSkill): boolean {
  return skill.enabled && skill.declaredTools.every((tool) => READ_ONLY_TOOLS.has(tool));
}

function skillKey(skillId: string, version: number): string {
  return `${skillId}:${version}`;
}

export function AutomationScheduleForm({
  projects, projectsLoading, projectsError, csrfAvailable, initialWorkspaceId, schedule,
  onCancel, onCreate, onUpdate, onConflict, onReloadLatest, onRetryProjects
}: AutomationScheduleFormProps): React.JSX.Element {
  const activeProjects = projects.filter((project) => project.status === 'active');
  const [workspaceId, setWorkspaceId] = useState(schedule?.workspaceId ?? initialWorkspaceId);
  const [skills, setSkills] = useState<readonly UserSkill[]>([]);
  const [skillStatus, setSkillStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [skillAttempt, setSkillAttempt] = useState(0);
  const [selectedSkillKey, setSelectedSkillKey] = useState(schedule ? skillKey(schedule.skillId, schedule.skillVersion) : '');
  const [localTime, setLocalTime] = useState(schedule?.localTime ?? '08:30');
  const [timeZone, setTimeZone] = useState(schedule?.timeZone ?? browserTimeZone());
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FormField, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const workspaceRef = useRef<HTMLSelectElement>(null);
  const skillRef = useRef<HTMLSelectElement>(null);
  const timeRef = useRef<HTMLInputElement>(null);
  const zoneRef = useRef<HTMLInputElement>(null);
  const eligibleSkills = useMemo(() => skills.filter(isEligibleSkill), [skills]);
  const selectedSkill = eligibleSkills.find((skill) => skillKey(skill.id, skill.version) === selectedSkillKey) ?? null;
  const unchanged = Boolean(schedule)
    && localTime === schedule?.localTime
    && timeZone === schedule?.timeZone
    && selectedSkill?.id === schedule?.skillId
    && selectedSkill?.version === schedule?.skillVersion;

  useEffect(() => {
    if (!workspaceId) { setSkills([]); setSkillStatus('ready'); return; }
    let current = true;
    setSkillStatus('loading');
    void listSkillsForWorkspace(workspaceId).then((values) => {
      if (!current) return;
      setSkills(values);
      setSkillStatus('ready');
      if (!schedule) setSelectedSkillKey((key) => {
        const first = values.find(isEligibleSkill);
        return key || (first ? skillKey(first.id, first.version) : '');
      });
    }).catch(() => {
      if (current) { setSkills([]); setSkillStatus('error'); }
    });
    return () => { current = false; };
  }, [schedule, skillAttempt, workspaceId]);

  useEffect(() => {
    if (fieldErrors.workspaceId) workspaceRef.current?.focus();
    else if (fieldErrors.skill) skillRef.current?.focus();
    else if (fieldErrors.localTime) timeRef.current?.focus();
    else if (fieldErrors.timeZone) zoneRef.current?.focus();
  }, [fieldErrors]);

  function updateField<K extends FormField>(field: K, value: string): void {
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    setFormError(null);
    if (field === 'workspaceId') { setWorkspaceId(value); setSelectedSkillKey(''); }
    if (field === 'skill') setSelectedSkillKey(value);
    if (field === 'localTime') setLocalTime(value);
    if (field === 'timeZone') setTimeZone(value);
  }

  function validate(): boolean {
    const next: Partial<Record<FormField, string>> = {};
    if (!schedule && !activeProjects.some((project) => project.id === workspaceId)) next.workspaceId = 'Choose an active workspace.';
    if (!selectedSkill) next.skill = skillStatus === 'ready' ? 'Choose an enabled saved read-only skill.' : 'Eligible skills are not available yet.';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(localTime)) next.localTime = 'Enter a valid local time.';
    if (!isValidTimeZone(timeZone.trim())) next.timeZone = 'Enter a valid IANA time zone, such as Asia/Shanghai.';
    setFieldErrors(next);
    setFormError(Object.keys(next).length ? 'Review the highlighted fields.' : null);
    return Object.keys(next).length === 0;
  }

  function buildUpdateRequest(): UpdateAutomationScheduleRequest | null {
    if (!schedule || !selectedSkill) return null;
    const request: { expectedRevision: number; localTime?: string; timeZone?: string; skillId?: string; skillVersion?: number } = { expectedRevision: schedule.revision };
    if (localTime !== schedule.localTime) request.localTime = localTime;
    if (timeZone.trim() !== schedule.timeZone) request.timeZone = timeZone.trim();
    if (selectedSkill.id !== schedule.skillId || selectedSkill.version !== schedule.skillVersion) {
      request.skillId = selectedSkill.id;
      request.skillVersion = selectedSkill.version;
    }
    return Object.keys(request).length > 1 ? request : null;
  }

  async function submit(): Promise<void> {
    if (saving || !validate() || !csrfAvailable) return;
    setSaving(true);
    setFormError(null);
    try {
      if (schedule) {
        if (conflict) return;
        const request = buildUpdateRequest();
        if (!request) { setFormError('Change at least one field before saving.'); return; }
        await onUpdate(schedule.id, request);
      } else {
        const intent = pendingCreate ?? {
          key: createIdempotencyKey(),
          request: { workspaceId, skillId: selectedSkill?.id ?? '', skillVersion: selectedSkill?.version ?? 0, localTime, timeZone: timeZone.trim() }
        };
        setPendingCreate(intent);
        await onCreate(intent.request, intent.key);
      }
      setPendingCreate(null);
    } catch (error: unknown) {
      if (error instanceof ApiClientError && error.code === 'SCHEDULE_REVISION_CONFLICT' && schedule) {
        setConflict(true);
        setFormError('This schedule changed. Your edits are preserved; reload the latest schedule before saving again.');
        await onConflict();
      } else {
        if (error instanceof ApiClientError && (error.code === 'SKILL_VERSION_CONFLICT' || error.code === 'SCHEDULE_SKILL_NOT_READ_ONLY' || error.code.endsWith('_NOT_FOUND'))) {
          setSkillAttempt((attempt) => attempt + 1);
          onRetryProjects();
        }
        const isUncertain = !(error instanceof ApiClientError) || error.statusCode >= 500 || error.code === 'IDEMPOTENCY_KEY_REUSED';
        if (!isUncertain) setPendingCreate(null);
        const details = error instanceof ApiClientError ? Object.fromEntries(error.details.map((item) => [item.field, item.message])) : {};
        const mapped: Partial<Record<FormField, string>> = {
          ...(typeof details.workspaceId === 'string' ? { workspaceId: details.workspaceId } : {}),
          ...(typeof details.skillId === 'string' || typeof details.skillVersion === 'string' ? { skill: 'Choose a current eligible skill.' } : {}),
          ...(typeof details.localTime === 'string' ? { localTime: details.localTime } : {}),
          ...(typeof details.timeZone === 'string' ? { timeZone: details.timeZone } : {})
        };
        setFieldErrors(mapped);
        setFormError(isUncertain
          ? 'The save outcome is uncertain. Retry the exact same save to safely reconcile it.'
          : scheduleActionError(error, 'The schedule could not be saved. Your entries are preserved.'));
      }
    } finally { setSaving(false); }
  }

  const fieldsLocked = saving || Boolean(pendingCreate);
  const formUnavailable = projectsLoading || Boolean(projectsError) || skillStatus === 'loading' || skillStatus === 'error';

  return <Card className="grid gap-5 p-5 sm:p-6" data-testid="automation-schedule-form">
    <header><h2 className="text-xl font-semibold">{schedule ? 'Edit daily briefing' : 'Create daily briefing'}</h2><p className="mt-1 text-sm text-[var(--color-text-muted)]">Runs on the server even when this page is closed.</p></header>
    {formError ? <Alert tone="error" role="alert">{formError}{conflict ? <Button type="button" variant="secondary" className="mt-3" onClick={() => { void onReloadLatest(); }}>Reload latest schedule</Button> : null}</Alert> : null}
    {projectsError ? <Alert tone="error" role="alert">{projectsError}<Button type="button" variant="secondary" className="mt-2" onClick={onRetryProjects}>Try again</Button></Alert> : null}
    {projectsLoading ? <div aria-busy="true" aria-label="Loading workspaces and skills"><Skeleton className="h-11" /><Skeleton className="h-11" /></div> : null}
    {!projectsLoading && !projectsError && !schedule && activeProjects.length === 0 ? <Alert tone="warning">No active workspaces available.</Alert> : null}
    <form className="grid gap-5" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className="grid gap-2">
        <Label htmlFor="automation-workspace">Workspace</Label>
        {schedule ? <p id="automation-workspace" className="min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2">{activeProjects.find((project) => project.id === schedule.workspaceId)?.name ?? 'Workspace unavailable'}</p> : <select ref={workspaceRef} id="automation-workspace" className="min-h-11 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3" value={workspaceId} aria-required="true" aria-invalid={Boolean(fieldErrors.workspaceId)} aria-describedby={fieldErrors.workspaceId ? 'automation-workspace-error' : undefined} onChange={(event) => updateField('workspaceId', event.target.value)} disabled={fieldsLocked || projectsLoading || activeProjects.length === 0}><option value="">Choose one active workspace</option>{activeProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>}
        {fieldErrors.workspaceId ? <p id="automation-workspace-error" className="text-sm text-[var(--color-error)]" role="alert">{fieldErrors.workspaceId}</p> : null}
      </div>
      <div className="grid gap-2">
        <Label htmlFor="automation-skill">Enabled read-only skill</Label>
        {skillStatus === 'loading' ? <Skeleton className="h-11" /> : <select ref={skillRef} id="automation-skill" className="min-h-11 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3" value={selectedSkillKey} aria-required="true" aria-invalid={Boolean(fieldErrors.skill)} aria-describedby={fieldErrors.skill ? 'automation-skill-error' : undefined} onChange={(event) => updateField('skill', event.target.value)} disabled={fieldsLocked || skillStatus !== 'ready' || eligibleSkills.length === 0}><option value="">Choose an enabled read-only skill</option>{schedule && selectedSkillKey.startsWith(`${schedule.skillId}:`) && !eligibleSkills.some((skill) => skillKey(skill.id, skill.version) === selectedSkillKey) ? <option value={selectedSkillKey}>Saved skill version unavailable — choose current skill</option> : null}{eligibleSkills.map((skill) => <option key={skillKey(skill.id, skill.version)} value={skillKey(skill.id, skill.version)}>{skill.title} · v{skill.version}</option>)}</select>}
        {fieldErrors.skill ? <p id="automation-skill-error" className="text-sm text-[var(--color-error)]" role="alert">{fieldErrors.skill}</p> : null}
        {skillStatus === 'ready' && eligibleSkills.length === 0 ? <p className="text-sm text-[var(--color-text-muted)]">An enabled saved read-only skill is required. <Link className="underline" to={workspaceId ? `/projects/${encodeURIComponent(workspaceId)}/skills` : '/dashboard'}>Open Skills</Link></p> : null}
        {skillStatus === 'error' ? <Alert tone="error" role="alert">Skills could not be loaded.<Button type="button" variant="secondary" className="mt-2" onClick={() => setSkillAttempt((attempt) => attempt + 1)}>Try again</Button></Alert> : null}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="grid gap-2"><Label htmlFor="automation-local-time">Time</Label><Input ref={timeRef} id="automation-local-time" type="time" value={localTime} aria-required="true" aria-invalid={Boolean(fieldErrors.localTime)} aria-describedby={fieldErrors.localTime ? 'automation-time-error' : undefined} onChange={(event) => updateField('localTime', event.target.value)} disabled={fieldsLocked} />{fieldErrors.localTime ? <p id="automation-time-error" className="text-sm text-[var(--color-error)]" role="alert">{fieldErrors.localTime}</p> : null}</div>
        <div className="grid gap-2"><Label htmlFor="automation-time-zone">Time zone</Label><Input ref={zoneRef} id="automation-time-zone" value={timeZone} aria-required="true" aria-invalid={Boolean(fieldErrors.timeZone)} aria-describedby={fieldErrors.timeZone ? 'automation-zone-error' : 'automation-zone-help'} onChange={(event) => updateField('timeZone', event.target.value)} disabled={fieldsLocked} />{fieldErrors.timeZone ? <p id="automation-zone-error" className="text-sm text-[var(--color-error)]" role="alert">{fieldErrors.timeZone}</p> : <p id="automation-zone-help" className="text-xs text-[var(--color-text-muted)]">Use an IANA name such as Asia/Shanghai. A daylight-saving gap uses the next valid time; a repeated time runs once at the earlier instant.</p>}</div>
      </div>
      <p className="text-sm text-[var(--color-text-muted)]">A new schedule starts enabled. Downtime may create at most one recent catch-up run.</p>
      {!csrfAvailable ? <Alert tone="warning">Your session needs to be refreshed before saving a schedule.</Alert> : null}
      <div className="flex flex-wrap gap-3"><Button type="submit" disabled={!csrfAvailable || saving || Boolean(conflict) || formUnavailable || (!schedule && activeProjects.length === 0) || (schedule ? unchanged : !selectedSkill) || Boolean(pendingCreate)} aria-busy={saving}>{saving ? 'Saving…' : pendingCreate ? 'Save' : 'Save'}</Button>{pendingCreate ? <Button type="button" variant="secondary" onClick={() => { void submit(); }} disabled={saving || !csrfAvailable} aria-busy={saving}>Retry same save</Button> : null}<Button type="button" variant="secondary" onClick={onCancel} disabled={saving || Boolean(pendingCreate)}>Cancel</Button></div>
    </form>
  </Card>;
}
