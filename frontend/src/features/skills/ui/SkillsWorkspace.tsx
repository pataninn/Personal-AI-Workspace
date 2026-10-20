import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { createHomeConversation } from '@/entities/home-conversation';
import { getAssistantExecutionPolicy } from '@/entities/assistant-policy';
import { listProjects, type ProjectSnapshot } from '@/entities/project';
import { createSkill, deleteSkill, getSkill, invokeSkill, listSkillTemplates, listSkills, updateSkill } from '@/entities/skill';
import type { SkillTemplate, SkillToolCapability, UpdateSkillRequest, UserSkill } from '@/entities/skill';
import { useAccountUsage } from '@/entities/account-usage';
import { selectCsrfToken } from '@/entities/user-session';
import { useAppSelector } from '@/app/store/hooks';
import { ApiClientError } from '@/shared/api';
import { createIdempotencyKey } from '@/shared/lib/idempotency-key';
import {
  Alert, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogRoot, AlertDialogTitle,
  Button, Card, DialogContent, DialogDescription, DialogRoot, DialogTitle, Input, Label, Skeleton, Textarea
} from '@/shared/ui';

const SKILL_TOOLS: readonly { readonly id: SkillToolCapability; readonly label: string }[] = [
  { id: 'home_task_read', label: 'Read workspace tasks' },
  { id: 'home_task_write', label: 'Create or update tasks' },
  { id: 'home_workspace_read', label: 'Read saved workspace details' },
  { id: 'home_workspace_write', label: 'Update saved workspace details' },
  { id: 'home_action_undo', label: 'Undo an assistant action' }
];

interface SkillDraft {
  readonly title: string;
  readonly instructions: string;
  readonly workspaceId: string | null;
  readonly enabled: boolean;
  readonly declaredTools: readonly SkillToolCapability[];
}

interface EditorState {
  readonly key: string;
  readonly skill: UserSkill | null;
  readonly draft: SkillDraft;
}

type LoadStatus = 'loading' | 'loaded' | 'error';

export function SkillsWorkspace({ projectId, projectName, archived }: { readonly projectId: string; readonly projectName: string; readonly archived: boolean }): React.JSX.Element {
  const csrfToken = useAppSelector(selectCsrfToken);
  const navigate = useNavigate();
  const [skills, setSkills] = useState<readonly UserSkill[]>([]);
  const [templates, setTemplates] = useState<readonly SkillTemplate[]>([]);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>('loading');
  const [templatesStatus, setTemplatesStatus] = useState<LoadStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [projects, setProjects] = useState<readonly ProjectSnapshot[]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserSkill | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [runTarget, setRunTarget] = useState<UserSkill | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const visibleSkills = useMemo(() => skills.filter((skill) => skill.workspaceId === null || skill.workspaceId === projectId), [projectId, skills]);

  useEffect(() => {
    let active = true;
    setLoadStatus('loading');
    setError(null);
    void listSkills().then((result) => {
      if (active) { setSkills(result); setLoadStatus('loaded'); }
    }).catch(() => {
      if (active) { setError('Skills could not be loaded.'); setLoadStatus('error'); }
    });
    return () => { active = false; };
  }, [attempt]);

  useEffect(() => {
    let active = true;
    setTemplatesStatus('loading');
    void listSkillTemplates().then((result) => {
      if (active) { setTemplates(result); setTemplatesStatus('loaded'); }
    }).catch(() => { if (active) setTemplatesStatus('error'); });
    return () => { active = false; };
  }, [attempt]);

  useEffect(() => {
    let active = true;
    void listProjects(true).then((result) => { if (active) setProjects(result.projects); }).catch(() => { if (active) setProjects([]); });
    return () => { active = false; };
  }, []);

  function openNewSkill(): void {
    setEditor({ key: createIdempotencyKey(), skill: null, draft: { title: '', instructions: '', workspaceId: archived ? null : projectId, enabled: true, declaredTools: ['home_task_read'] } });
  }

  function copyTemplate(template: SkillTemplate): void {
    setEditor({ key: createIdempotencyKey(), skill: null, draft: { title: template.title, instructions: template.instructions, workspaceId: archived ? null : projectId, enabled: true, declaredTools: [...template.declaredTools] } });
  }

  function copySkill(skill: UserSkill): void {
    setEditor({ key: createIdempotencyKey(), skill: null, draft: { title: `${skill.title} copy`.slice(0, 120), instructions: skill.instructions, workspaceId: archived ? null : projectId, enabled: true, declaredTools: [...skill.declaredTools] } });
  }

  function editSkill(skill: UserSkill): void {
    setEditor({ key: createIdempotencyKey(), skill, draft: { title: skill.title, instructions: skill.instructions, workspaceId: skill.workspaceId, enabled: skill.enabled, declaredTools: [...skill.declaredTools] } });
  }

  function onSaved(skill: UserSkill): void {
    setSkills((current) => [skill, ...current.filter((item) => item.id !== skill.id)]);
    setEditor(null);
    setAnnouncement(`Skill saved as version ${skill.version}.`);
  }

  async function toggleEnabled(skill: UserSkill): Promise<void> {
    if (!csrfToken) return;
    try {
      const saved = await updateSkill(skill.id, { expectedVersion: skill.version, enabled: !skill.enabled }, csrfToken);
      setSkills((current) => current.map((item) => item.id === saved.id ? saved : item));
      setAnnouncement(saved.enabled ? 'Skill enabled.' : 'Skill disabled.');
    } catch (toggleError: unknown) {
      setError(toggleError instanceof ApiClientError && toggleError.code === 'SKILL_VERSION_CONFLICT'
        ? 'This skill changed. Reload the library before changing it.' : 'The skill could not be updated. Try again.');
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!csrfToken || !deleteTarget) return;
    setDeleteError(null);
    try {
      await deleteSkill(deleteTarget.id, deleteTarget.version, csrfToken);
      setSkills((current) => current.filter((item) => item.id !== deleteTarget.id));
      setDeleteTarget(null);
      setAnnouncement('Skill deleted. Previous conversation results are unchanged.');
    } catch (deleteFailure: unknown) {
      setDeleteError(deleteFailure instanceof ApiClientError && deleteFailure.code === 'SKILL_VERSION_CONFLICT'
        ? 'This skill changed. Close this dialog and reload before deleting it.' : 'The skill could not be deleted. Try again.');
    }
  }

  return <main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-8 sm:px-6 lg:px-8" data-testid="skills-page">
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--color-border)] pb-5">
      <div><p className="product-label">{projectName}</p><h1 className="text-3xl font-semibold">Skills</h1><p className="mt-2 max-w-2xl text-[var(--color-text-muted)]">Manage reusable, private instructions. Current workspace policy still controls every run.</p></div>
      <div className="flex flex-wrap gap-3"><Button type="button" variant="secondary" onClick={openNewSkill}>New skill</Button>{visibleSkills.some((skill) => skill.title === 'Plan my day' && skill.enabled) ? <Button type="button" onClick={() => setRunTarget(visibleSkills.find((skill) => skill.title === 'Plan my day' && skill.enabled) ?? null)}>Plan my day</Button> : <Button type="button" variant="secondary" disabled={templatesStatus !== 'loaded' || !templates.some((template) => template.id === 'plan-my-day')} onClick={() => { const template = templates.find((item) => item.id === 'plan-my-day'); if (template) copyTemplate(template); }}>Copy Plan my day</Button>}</div>
    </header>
    {announcement ? <p className="sr-only" role="status" aria-live="polite">{announcement}</p> : null}
    {error ? <Alert tone="error" role="alert"><p>{error}</p><Button type="button" variant="secondary" onClick={() => setAttempt((value) => value + 1)}>Try again</Button></Alert> : null}
    {loadStatus === 'loading' ? <div className="grid gap-3" aria-busy="true" aria-label="Loading skills"><Skeleton className="h-36" /><Skeleton className="h-36" /></div> : null}
    {loadStatus === 'loaded' && visibleSkills.length === 0 ? <Card className="grid gap-4 p-5 sm:p-6" data-testid="skills-empty"><h2 className="text-xl font-semibold">No personal skills yet</h2><p className="text-[var(--color-text-muted)]">Create a private skill or copy a starter template.</p></Card> : null}
    {loadStatus === 'loaded' && visibleSkills.length > 0 ? <section className="grid gap-4" aria-label="Your skills">{visibleSkills.map((skill) => <SkillCard key={skill.id} skill={skill} currentWorkspaceId={projectId} onEdit={() => editSkill(skill)} onCopy={() => copySkill(skill)} onRun={() => setRunTarget(skill)} onToggle={() => { void toggleEnabled(skill); }} onDelete={() => { setDeleteTarget(skill); setDeleteError(null); }} />)}</section> : null}
    {templatesStatus === 'loading' ? <section className="grid gap-3" aria-label="Loading templates"><Skeleton className="h-28" /></section> : null}
    {templatesStatus === 'error' ? <Alert tone="warning"><p>Starter templates could not be loaded.</p><Button type="button" variant="secondary" onClick={() => setAttempt((value) => value + 1)}>Try templates again</Button></Alert> : null}
    {templatesStatus === 'loaded' ? <section className="grid gap-3" aria-labelledby="skill-templates-title"><h2 id="skill-templates-title" className="text-xl font-semibold">Starter templates</h2>{templates.map((template) => <Card key={template.id} className="grid gap-3 p-5 sm:grid-cols-[1fr_auto] sm:items-start"><div><h3 className="font-semibold">{template.title}</h3><p className="mt-1 whitespace-pre-wrap text-sm text-[var(--color-text-muted)]">{template.instructions}</p><p className="mt-2 text-xs text-[var(--color-text-muted)]">Tools: {template.declaredTools.map(toolLabel).join(', ')}</p><p className="mt-1 text-xs">Read-only starter template</p></div><Button type="button" variant="secondary" onClick={() => copyTemplate(template)}>Copy</Button></Card>)}</section> : null}
    {editor ? <SkillEditor key={editor.key} editor={editor} projects={projects} currentProjectId={projectId} csrfToken={csrfToken} onCancel={() => setEditor(null)} onSaved={onSaved} /> : null}
    <AlertDialogRoot open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
      <AlertDialogContent aria-describedby="skill-delete-description">
        <AlertDialogTitle className="text-xl font-semibold">Delete this skill?</AlertDialogTitle>
        <AlertDialogDescription id="skill-delete-description" className="mt-2 text-[var(--color-text-muted)]">Previous conversation results remain in your history.</AlertDialogDescription>
        {deleteError ? <Alert tone="error" role="alert" className="mt-4">{deleteError}</Alert> : null}
        <div className="mt-6 flex justify-end gap-3"><AlertDialogCancel asChild><Button type="button" variant="secondary">Cancel</Button></AlertDialogCancel><Button type="button" variant="destructive" disabled={!csrfToken} onClick={() => { void confirmDelete(); }}>Delete skill</Button></div>
      </AlertDialogContent>
    </AlertDialogRoot>
    {runTarget ? <RunSkillDialog key={`${runTarget.id}:${runTarget.version}`} skill={runTarget} projects={projects} currentProjectId={projectId} csrfToken={csrfToken} onClose={() => setRunTarget(null)} onOpen={(workspaceId, conversationId) => navigate(`/projects/${encodeURIComponent(workspaceId)}/planning-chat?conversation=${encodeURIComponent(conversationId)}`)} /> : null}
  </main>;
}

function SkillCard({ skill, currentWorkspaceId, onEdit, onCopy, onRun, onToggle, onDelete }: {
  readonly skill: UserSkill; readonly currentWorkspaceId: string;
  readonly onEdit: () => void; readonly onCopy: () => void; readonly onRun: () => void;
  readonly onToggle: () => void; readonly onDelete: () => void;
}): React.JSX.Element {
  return <Card className="grid gap-4 p-5 sm:p-6" data-testid={`skill-card-${skill.id}`}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">{skill.title}</h2><p className="mt-1 text-sm text-[var(--color-text-muted)]">{skill.workspaceId === null ? 'Account-wide' : skill.workspaceId === currentWorkspaceId ? 'This workspace' : 'Another workspace'} · Version {skill.version} · {skill.enabled ? 'Enabled' : 'Disabled'}</p></div><Button type="button" disabled={!skill.enabled} onClick={onRun}>Run</Button></div>
    <p className="line-clamp-3 whitespace-pre-wrap text-sm">{skill.instructions}</p>
    <p className="text-sm text-[var(--color-text-muted)]">Tools this skill may request: {skill.declaredTools.length ? skill.declaredTools.map(toolLabel).join(', ') : 'None'}</p>
    <details><summary className="cursor-pointer text-sm font-medium">Inspect full instructions</summary><p className="mt-2 whitespace-pre-wrap text-sm text-[var(--color-text-muted)]">{skill.instructions}</p></details>
    {!skill.enabled ? <p className="text-sm text-[var(--color-text-muted)]">Enable this skill to run it.</p> : null}
    <div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" onClick={onEdit}>Edit</Button><Button type="button" variant="secondary" onClick={onCopy}>Copy</Button><Button type="button" variant="ghost" onClick={onToggle}>{skill.enabled ? 'Disable' : 'Enable'}</Button><Button type="button" variant="ghost" onClick={onDelete}>Delete</Button></div>
  </Card>;
}

function SkillEditor({ editor, projects, currentProjectId, csrfToken, onCancel, onSaved }: {
  readonly editor: EditorState; readonly projects: readonly ProjectSnapshot[]; readonly currentProjectId: string; readonly csrfToken: string | null;
  readonly onCancel: () => void; readonly onSaved: (skill: UserSkill) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<SkillDraft>(editor.draft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [latest, setLatest] = useState<UserSkill | null>(null);
  const [conflictResolved, setConflictResolved] = useState(false);
  const pendingCreate = useRef<{ readonly key: string; readonly request: { readonly title: string; readonly instructions: string; readonly workspaceId: string | null; readonly declaredTools: readonly SkillToolCapability[] } } | null>(null);
  const instructionBytes = new TextEncoder().encode(draft.instructions).length;

  function change<K extends keyof SkillDraft>(key: K, value: SkillDraft[K]): void {
    setDraft((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => ({ ...current, [key]: '' }));
  }

  async function resolveConflict(): Promise<void> {
    if (!editor.skill) return;
    try { setLatest(await getSkill(editor.skill.id)); }
    catch { setError('The latest version could not be loaded. Your draft is preserved; try again.'); }
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!csrfToken || saving || (latest && !conflictResolved)) return;
    const invalid: Record<string, string> = {};
    if (Array.from(draft.title.trim()).length < 1 || Array.from(draft.title).length > 120) invalid.title = 'Enter a title from 1 to 120 characters.';
    if (!draft.instructions.trim()) invalid.instructions = 'Instructions are required.';
    if (instructionBytes > 16000) invalid.instructions = 'Instructions must be 16,000 UTF-8 bytes or fewer.';
    if (Object.keys(invalid).length) { setFieldErrors(invalid); setError('Review the highlighted fields.'); return; }
    setSaving(true); setError(null); setFieldErrors({});
    try {
      if (editor.skill) {
        const request: UpdateSkillRequest = {
          expectedVersion: (latest ?? editor.skill).version,
          workspaceId: draft.workspaceId,
          title: draft.title.trim(),
          instructions: draft.instructions,
          enabled: draft.enabled,
          declaredTools: draft.declaredTools
        };
        onSaved(await updateSkill(editor.skill.id, request, csrfToken));
      } else {
        const pending = pendingCreate.current ?? {
          key: editor.key,
          request: { title: draft.title.trim(), instructions: draft.instructions, workspaceId: draft.workspaceId, declaredTools: draft.declaredTools }
        };
        pendingCreate.current = pending;
        onSaved(await createSkill(pending.request, csrfToken, pending.key));
      }
    } catch (saveError: unknown) {
      if (saveError instanceof ApiClientError && saveError.code === 'SKILL_VERSION_CONFLICT' && editor.skill) {
        setError('This skill changed while you were editing. Your draft is preserved. Choose how to continue.');
        setConflictResolved(false);
        await resolveConflict();
      } else {
        const fieldDetails = saveError instanceof ApiClientError ? Object.fromEntries(saveError.details.map((item) => [item.field, item.message])) : {};
        setFieldErrors(fieldDetails);
        setError(saveError instanceof ApiClientError && saveError.code.includes('STORAGE')
          ? 'Account storage could not accept this save. Your draft is preserved.'
          : 'The skill could not be saved. Your draft is preserved; retry the same save or review the fields.');
      }
    } finally { setSaving(false); }
  }

  function keepDraft(): void { setConflictResolved(true); setLatest(latest); setError(null); }
  function reloadLatest(): void {
    if (!latest) return;
    setDraft({ title: latest.title, instructions: latest.instructions, workspaceId: latest.workspaceId, enabled: latest.enabled, declaredTools: [...latest.declaredTools] });
    setConflictResolved(true); setError(null);
  }

  return <Card className="grid gap-5 p-5 sm:p-6" data-testid="skill-editor">
    <header><h2 className="text-xl font-semibold">{editor.skill ? `Edit ${editor.skill.title}` : 'New private skill'}</h2><p className="mt-1 text-sm text-[var(--color-text-muted)]">Editing saves a new version. Skills cannot grant capabilities beyond the current workspace policy.</p></header>
    {error ? <Alert tone="error" role="alert">{error}{error.toLowerCase().includes('storage') ? <p className="mt-2"><Link className="underline" to="/usage">View usage</Link></p> : null}</Alert> : null}
    {latest && !conflictResolved ? <div className="grid gap-3 rounded-lg border border-[var(--color-border)] p-4"><p>Latest saved version: {latest.version} · {latest.title}</p><div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" onClick={keepDraft}>Keep my draft</Button><Button type="button" variant="secondary" onClick={reloadLatest}>Reload latest</Button></div></div> : null}
    <form className="grid gap-5" onSubmit={(event) => { void save(event); }}>
      <div className="grid gap-2"><Label htmlFor="skill-title">Title</Label><Input id="skill-title" value={draft.title} maxLength={120} aria-invalid={Boolean(fieldErrors.title)} aria-describedby={fieldErrors.title ? 'skill-title-error' : undefined} onChange={(event) => change('title', event.target.value)} disabled={Boolean(pendingCreate.current)} />{fieldErrors.title ? <p id="skill-title-error" role="alert" className="text-sm text-[var(--color-error)]">{fieldErrors.title}</p> : null}</div>
      <div className="grid gap-2"><Label htmlFor="skill-instructions">Instructions</Label><Textarea id="skill-instructions" rows={8} value={draft.instructions} aria-invalid={Boolean(fieldErrors.instructions)} aria-describedby="skill-instructions-help" onChange={(event) => change('instructions', event.target.value)} disabled={Boolean(pendingCreate.current)} /><p id="skill-instructions-help" className="text-xs text-[var(--color-text-muted)]">{instructionBytes.toLocaleString()} / 16,000 UTF-8 bytes</p>{fieldErrors.instructions ? <p role="alert" className="text-sm text-[var(--color-error)]">{fieldErrors.instructions}</p> : null}</div>
      <div className="grid gap-2"><Label htmlFor="skill-workspace">Workspace</Label><select id="skill-workspace" className="min-h-11 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3" value={draft.workspaceId ?? ''} onChange={(event) => change('workspaceId', event.target.value || null)} disabled={Boolean(pendingCreate.current)}><option value="">Account-wide</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}{project.status === 'archived' ? ' (archived)' : ''}</option>)}{draft.workspaceId && !projects.some((project) => project.id === draft.workspaceId) ? <option value={draft.workspaceId}>{draft.workspaceId === currentProjectId ? 'Current workspace' : 'Existing workspace'}</option> : null}</select></div>
      <label className="flex items-center gap-3"><input type="checkbox" className="size-4 accent-[var(--color-primary)]" checked={draft.enabled} onChange={(event) => change('enabled', event.target.checked)} disabled={Boolean(pendingCreate.current)} /><span>Enabled</span></label>
      <fieldset className="grid gap-3"><legend className="font-medium">Tools this skill may request</legend>{SKILL_TOOLS.map((tool) => <label key={tool.id} className="flex items-start gap-3"><input type="checkbox" className="mt-1 size-4 accent-[var(--color-primary)]" checked={draft.declaredTools.includes(tool.id)} onChange={(event) => change('declaredTools', event.target.checked ? [...draft.declaredTools, tool.id] : draft.declaredTools.filter((value) => value !== tool.id))} disabled={Boolean(pendingCreate.current)} /><span>{tool.label}</span></label>)}<p className="text-xs text-[var(--color-text-muted)]">The current account and workspace policy still decides which tools can run.</p></fieldset>
      <div className="flex flex-wrap gap-3"><Button type="submit" disabled={!csrfToken || saving || Boolean(latest && !conflictResolved) || Boolean(pendingCreate.current)} aria-busy={saving}>{saving ? 'Saving…' : 'Save skill'}</Button>{pendingCreate.current ? <Button type="submit" variant="secondary" disabled={!csrfToken || saving} aria-busy={saving}>Retry same save</Button> : null}<Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button></div>
    </form>
  </Card>;
}

function RunSkillDialog({ skill, projects, currentProjectId, csrfToken, onClose, onOpen }: {
  readonly skill: UserSkill; readonly projects: readonly ProjectSnapshot[]; readonly currentProjectId: string; readonly csrfToken: string | null;
  readonly onClose: () => void; readonly onOpen: (workspaceId: string, conversationId: string) => void;
}): React.JSX.Element {
  const activeProjects = projects.filter((project) => project.status === 'active');
  const fixedWorkspace = skill.workspaceId !== null;
  const [workspaceId, setWorkspaceId] = useState(skill.workspaceId ?? (activeProjects.find((project) => project.id === currentProjectId)?.id ?? activeProjects[0]?.id ?? ''));
  const [policyState, setPolicyState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [policy, setPolicy] = useState<Awaited<ReturnType<typeof getAssistantExecutionPolicy>> | null>(null);
  const [policyAttempt, setPolicyAttempt] = useState(0);
  const [note, setNote] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogActive = useRef(false);
  const createKey = useRef<string | null>(null);
  const invokeKey = useRef<string | null>(null);
  const invokeRequest = useRef<Parameters<typeof invokeSkill>[1] | null>(null);
  const conversationId = useRef<string | null>(null);
  const usage = useAccountUsage();
  const target = activeProjects.find((project) => project.id === workspaceId) ?? null;
  const missingTools = skill.declaredTools.filter((tool) => !policy?.policy?.capabilities.includes(tool));
  const usageAvailable = usage.state.status === 'success' && usage.state.data.availability.status === 'available' && usage.state.data.availability.canSubmit;
  const canRun = Boolean(csrfToken && target && !running && policyState === 'ready' && policy?.readiness.state === 'ready' && policy.policy?.enabled === true && policy.policy.provider !== null && missingTools.length === 0 && usageAvailable);

  useEffect(() => {
    dialogActive.current = true;
    return () => { dialogActive.current = false; };
  }, []);

  function resetWorkspaceAttempt(): void {
    conversationId.current = null;
    createKey.current = null;
    invokeKey.current = null;
    invokeRequest.current = null;
    setError(null);
  }

  useEffect(() => {
    if (!workspaceId) { setPolicyState('error'); return; }
    let active = true;
    setPolicyState('loading'); setPolicy(null); setError(null);
    void getAssistantExecutionPolicy({ scope: 'workspace', projectId: workspaceId }).then((result) => {
      if (active) { setPolicy(result); setPolicyState('ready'); }
    }).catch(() => { if (active) { setPolicy(null); setPolicyState('error'); } });
    return () => { active = false; };
  }, [policyAttempt, workspaceId]);

  async function run(): Promise<void> {
    if (!canRun || !csrfToken || !target) return;
    const runWorkspaceId = workspaceId;
    setRunning(true); setError(null);
    try {
      if (!conversationId.current) {
        createKey.current ??= createIdempotencyKey();
        const conversation = await createHomeConversation({ kind: 'workspace', workspaceId: runWorkspaceId }, skill.title, csrfToken, createKey.current);
        if (!dialogActive.current) return;
        conversationId.current = conversation.id;
      }
      invokeKey.current ??= createIdempotencyKey();
      const targetConversationId = conversationId.current;
      if (!targetConversationId) throw new Error('A Home conversation is required before invoking a skill.');
      invokeRequest.current ??= {
        conversationId: targetConversationId,
        expectedVersion: skill.version,
        request: note.trim() || "Create today's plan."
      };
      await invokeSkill(skill.id, invokeRequest.current, csrfToken, invokeKey.current);
      if (!dialogActive.current) return;
      onOpen(runWorkspaceId, targetConversationId);
    } catch (runError: unknown) {
      if (!dialogActive.current) return;
      setError(runError instanceof ApiClientError && runError.code === 'SKILL_VERSION_CONFLICT'
        ? 'This skill changed. Reload it before starting a new run.'
        : 'The run could not be confirmed. Retry here to reuse the same conversation and idempotency keys.');
    } finally { if (dialogActive.current) setRunning(false); }
  }

  const readinessMessage = policyState === 'loading' ? 'Checking workspace execution policy and runtime…'
    : policyState === 'error' ? 'Workspace policy or runtime availability is unknown. Refresh before running.'
      : policy?.readiness.state === 'blocked' ? 'Workspace policy currently blocks assistant execution.'
        : policy?.readiness.state === 'unavailable' ? 'Workspace execution is unavailable until policy and runtime readiness are confirmed.'
          : policy?.policy?.enabled !== true ? 'Assistant execution is disabled for this workspace.'
            : policy?.policy.provider === null ? 'A configured provider is not available for this workspace.' : null;
  const usageMessage = usage.state.status === 'success'
    ? usage.state.data.availability.status === 'available' && usage.state.data.availability.canSubmit ? null : usage.state.data.availability.reason ?? 'AI availability is not confirmed.'
    : usage.state.status === 'loading' ? 'Checking AI availability…' : 'AI availability could not be checked.';

  return <DialogRoot open onOpenChange={(open) => { if (!open && !running) onClose(); }}>
    <DialogContent aria-describedby="skill-run-description" className="max-h-[90vh] overflow-y-auto" data-testid="skill-run-dialog">
      <DialogTitle className="text-xl font-semibold">Run {skill.title}</DialogTitle>
      <DialogDescription id="skill-run-description" className="mt-2 text-sm text-[var(--color-text-muted)]">Run once in a workspace you own. The saved result opens in that workspace’s Home conversation history.</DialogDescription>
      <div className="mt-5 grid gap-4">
        {fixedWorkspace ? <p className="text-sm">Target workspace: {target?.name ?? 'Unavailable or inactive workspace'}</p> : <div className="grid gap-2"><Label htmlFor="skill-run-workspace">Target workspace</Label><select id="skill-run-workspace" className="min-h-11 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3" value={workspaceId} onChange={(event) => { resetWorkspaceAttempt(); setWorkspaceId(event.target.value); }} disabled={running}><option value="">Choose an active workspace</option>{activeProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></div>}
        {!target ? <Alert tone="warning">This skill needs an active owned workspace before it can run.</Alert> : null}
        <Card className="grid gap-2 p-4"><h3 className="font-medium">Context and tools</h3><p className="text-sm text-[var(--color-text-muted)]">The run may use tasks and saved workspace details allowed by the current policy. It will not receive tools beyond this skill’s declared needs and workspace policy.</p><p className="text-sm">Declared tools: {skill.declaredTools.length ? skill.declaredTools.map(toolLabel).join(', ') : 'None'}</p></Card>
        <div className="grid gap-2"><Label htmlFor="skill-run-note">Optional request</Label><Textarea id="skill-run-note" rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Create today's plan." disabled={running} />{invokeRequest.current ? <p className="text-xs text-[var(--color-text-muted)]">Retry repeats the request submitted on the first attempt. Editing this note will not change that retry; close and start a new run to submit edited text.</p> : null}</div>
        {policyState === 'loading' ? <p role="status" className="text-sm">{readinessMessage}</p> : null}
        {readinessMessage && policyState !== 'loading' ? <Alert tone="warning"><p>{readinessMessage}</p><Button type="button" variant="secondary" onClick={() => setPolicyAttempt((value) => value + 1)}>Refresh availability</Button></Alert> : null}
        {missingTools.length ? <Alert tone="warning">Workspace policy blocks: {missingTools.map(toolLabel).join(', ')}.</Alert> : null}
        {usageMessage ? <Alert tone={usage.state.status === 'success' && usage.state.data.availability.status === 'available' ? 'warning' : 'warning'}><p>{usageMessage}</p><Link className="text-[var(--color-link)] underline underline-offset-4" to="/usage">View usage</Link></Alert> : null}
        {!csrfToken ? <Alert tone="warning">Your session needs to be refreshed before running a skill.</Alert> : null}
        {error ? <Alert tone="error" role="alert">{error}<div className="mt-3"><Button type="button" variant="secondary" disabled={!canRun} onClick={() => { void run(); }}>Retry same run</Button></div></Alert> : null}
        <div className="flex flex-wrap justify-end gap-3"><Button type="button" variant="secondary" onClick={onClose} disabled={running}>Cancel</Button><Button type="button" onClick={() => { void run(); }} disabled={!canRun} aria-busy={running}>{running ? 'Starting…' : 'Run skill'}</Button></div>
      </div>
    </DialogContent>
  </DialogRoot>;
}

function toolLabel(tool: SkillToolCapability): string {
  return SKILL_TOOLS.find((item) => item.id === tool)?.label ?? tool;
}
