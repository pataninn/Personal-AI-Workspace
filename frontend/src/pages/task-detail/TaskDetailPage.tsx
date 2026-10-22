import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useBeforeUnload, useBlocker, useLocation, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';

import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { loadProjects, selectProjectListStatus, selectProjects } from '@/entities/project';
import type { GlobalTaskItem, ProjectTask, ProjectTaskDraft, TaskActionReceiptMetadata, TaskMutationKind } from '@/entities/project-task';
import { deleteGlobalTask, getGlobalTask, getInboxTaskCount, getTaskActionReceipt, moveGlobalTask, ProjectTaskStatusLabel, undoTaskAction, updateGlobalTask } from '@/entities/project-task';
import { selectCsrfToken, selectPrincipal } from '@/entities/user-session';
import { TaskConfirmationDialog, type TaskEditorSaveResult } from '@/features/project-tasks';
import { clearTaskReceiptPointer, createTaskPatch, readTaskReceiptPointer, saveTaskReceiptPointer, TaskMoveDialog } from '@/features/task-actions';
import { ApiClientError } from '@/shared/api';
import { Alert, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogRoot, AlertDialogTitle, Button, ErrorState, Skeleton } from '@/shared/ui';
import { TaskDetailEditor } from '@/pages/task-detail/TaskDetailEditor';
import type { AppShellOutletContext } from '@/widgets/app-shell';

type DetailState = { readonly taskId: string; readonly includeArchived: boolean; readonly status: 'loading' | 'success' | 'error'; readonly item: GlobalTaskItem | null };
type ActionError = { readonly message: string; readonly retryable: boolean };

export function TaskDetailPage(): React.JSX.Element {
  const { taskId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const shellContext = useOutletContext<AppShellOutletContext | null>();
  const [searchParams, setSearchParams] = useSearchParams();
  const includeArchived = searchParams.get('includeArchived') === 'true';
  const dispatch = useAppDispatch();
  const projects = useAppSelector(selectProjects);
  const projectListStatus = useAppSelector(selectProjectListStatus);
  const ownerId = useAppSelector(selectPrincipal)?.id ?? null;
  const csrfToken = useAppSelector(selectCsrfToken);
  const [state, setState] = useState<DetailState>({ taskId: '', includeArchived: false, status: 'loading', item: null });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [editSaving, setEditSaving] = useState(false);
  const [editDirty, setEditDirty] = useState(false);
  const [exitPromptOpen, setExitPromptOpen] = useState(false);
  const [editResetNonce, setEditResetNonce] = useState(0);
  const [taskUnavailable, setTaskUnavailable] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('');
  const [moveSaving, setMoveSaving] = useState(false);
  const [moveError, setMoveError] = useState<ActionError | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteSaving, setDeleteSaving] = useState(false);
  const [deleteError, setDeleteError] = useState<ActionError | null>(null);
  const [undoSaving, setUndoSaving] = useState(false);
  const [undoError, setUndoError] = useState<ActionError | null>(null);
  const [receipt, setReceipt] = useState<TaskActionReceiptMetadata | null>(null);
  const [receiptOwnerId, setReceiptOwnerId] = useState<string | null>(null);
  const [receiptLoading, setReceiptLoading] = useState(false);
  const [receiptLoadError, setReceiptLoadError] = useState(false);
  const [receiptReloadAttempt, setReceiptReloadAttempt] = useState(0);
  const [refreshWarning, setRefreshWarning] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
  const moveTriggerRef = useRef<HTMLButtonElement>(null);
  const pageActiveRef = useRef(false);
  const taskIdRef = useRef(taskId);
  const locationPathRef = useRef(location.pathname);
  const editDirtyRef = useRef(false);
  const editSavingRef = useRef(false);
  const deleteSavingRef = useRef(false);
  const signOutResolverRef = useRef<((approved: boolean) => void) | null>(null);
  const signOutPromiseRef = useRef<Promise<boolean> | null>(null);
  const moveIntent = useRef<{ readonly taskId: string; readonly expectedVersion: number; readonly workspaceId: string | null; readonly key: string } | null>(null);
  const deleteIntent = useRef<{ readonly taskId: string; readonly expectedVersion: number; readonly key: string } | null>(null);
  const undoIntent = useRef<{ readonly actionId: string; readonly key: string } | null>(null);

  taskIdRef.current = taskId;
  locationPathRef.current = location.pathname;

  useEffect(() => {
    pageActiveRef.current = true;
    return () => { pageActiveRef.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setState({ taskId, includeArchived, status: 'loading', item: null });
    void getGlobalTask(taskId, includeArchived).then((item) => {
      if (active) setState({ taskId, includeArchived, status: 'success', item });
    }).catch(() => {
      if (active) setState({ taskId, includeArchived, status: 'error', item: null });
    });
    return () => { active = false; };
  }, [taskId, includeArchived, loadAttempt]);

  useEffect(() => {
    if (projectListStatus === 'idle') void dispatch(loadProjects());
  }, [dispatch, projectListStatus]);

  useEffect(() => {
    let active = true;
    const pointer = ownerId ? readTaskReceiptPointer(ownerId, taskId) : null;
    setReceiptLoading(pointer !== null);
    setReceiptLoadError(false);
    if (!pointer || !ownerId) {
      setReceipt(null);
      setReceiptOwnerId(null);
      setReceiptLoading(false);
      return () => { active = false; };
    }
    void getTaskActionReceipt(pointer).then((savedReceipt) => {
      if (!active) return;
      if (savedReceipt.targetKind !== 'task' || savedReceipt.targetId !== taskId) {
        clearTaskReceiptPointer(ownerId, taskId);
        setReceipt(null);
        setReceiptOwnerId(null);
      } else {
        setReceipt(savedReceipt);
        setReceiptOwnerId(ownerId);
        if (savedReceipt.undoStatus !== 'available') undoIntent.current = null;
      }
      setReceiptLoading(false);
    }).catch((error: unknown) => {
      if (!active) return;
      if (error instanceof ApiClientError && error.statusCode === 404) {
        clearTaskReceiptPointer(ownerId, taskId);
        setReceipt(null);
        setReceiptOwnerId(null);
      } else {
        setReceiptLoadError(true);
      }
      setReceiptLoading(false);
    });
    return () => { active = false; };
  }, [ownerId, taskId, receiptReloadAttempt]);

  const path = `/tasks${includeArchived ? '?includeArchived=true' : ''}`;
  const current = state.taskId === taskId && state.includeArchived === includeArchived ? state : null;
  const item = current?.status === 'success' ? current.item : null;
  const task = item?.task ?? null;
  const currentLocation = item?.workspace?.name ?? 'Inbox';
  const visibleReceipt = receiptOwnerId === ownerId && receipt?.targetKind === 'task' && receipt.targetId === taskId ? receipt : null;
  const canMutate = task !== null && item?.workspace?.status !== 'archived';
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (currentLocation.pathname === nextLocation.pathname && currentLocation.search === nextLocation.search && currentLocation.hash === nextLocation.hash) return false;
    return editDirtyRef.current || editSavingRef.current || deleteSavingRef.current;
  });

  useEffect(() => {
    if (deleteSavingRef.current && blocker.state === 'blocked') blocker.reset();
  }, [blocker]);

  const requestSignOut = useCallback((): Promise<boolean> => {
    if (deleteSavingRef.current) return Promise.resolve(false);
    if (!editDirtyRef.current && !editSavingRef.current) return Promise.resolve(true);
    if (signOutPromiseRef.current) return signOutPromiseRef.current;
    setExitPromptOpen(true);
    signOutPromiseRef.current = new Promise<boolean>((resolve) => { signOutResolverRef.current = resolve; });
    return signOutPromiseRef.current;
  }, []);

  useBeforeUnload((event) => {
    if (editDirtyRef.current || editSavingRef.current || deleteSavingRef.current) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  useEffect(() => {
    if (current?.status === 'success') pageHeadingRef.current?.focus({ preventScroll: true });
  }, [taskId, current?.status]);

  useEffect(() => {
    editDirtyRef.current = editDirty;
  }, [editDirty]);

  useEffect(() => {
    editSavingRef.current = editSaving;
  }, [editSaving]);

  useEffect(() => {
    const register = shellContext?.registerTaskEditorExitGuard;
    register?.(requestSignOut);
    return () => {
      register?.(null);
      const resolveSignOut = signOutResolverRef.current;
      signOutResolverRef.current = null;
      signOutPromiseRef.current = null;
      resolveSignOut?.(false);
    };
  }, [shellContext?.registerTaskEditorExitGuard, requestSignOut]);

  useEffect(() => {
    setTaskUnavailable(false);
    editDirtyRef.current = false;
    setEditDirty(false);
    setExitPromptOpen(false);
  }, [taskId]);

  function onEditorDirtyChange(dirty: boolean): void {
    editDirtyRef.current = dirty;
    setEditDirty(dirty);
  }

  function setCanonicalItem(nextItem: GlobalTaskItem): void {
    const historical = nextItem.workspace?.status === 'archived';
    setState({ taskId, includeArchived: historical, status: 'success', item: nextItem });
    setSearchParams((currentParams) => {
      const next = new URLSearchParams(currentParams);
      if (historical) next.set('includeArchived', 'true');
      else next.delete('includeArchived');
      return next;
    }, { replace: true });
  }

  async function reloadLatest(): Promise<GlobalTaskItem | null> {
    try {
      const latest = await getGlobalTask(taskId, true);
      setCanonicalItem(latest);
      setTaskUnavailable(false);
      return latest;
    } catch (error: unknown) {
      if (error instanceof ApiClientError && error.statusCode === 404) setTaskUnavailable(true);
      return null;
    }
  }

  async function refreshCommittedViews(): Promise<void> {
    setRefreshWarning(false);
    const refreshes: Promise<unknown>[] = [
      getGlobalTask(taskId, true).then((latest) => { setCanonicalItem(latest); }),
      getInboxTaskCount()
    ];
    if (projectListStatus !== 'loading') refreshes.push(dispatch(loadProjects()).unwrap());
    const outcomes = await Promise.allSettled(refreshes);
    if (outcomes.some((outcome) => outcome.status === 'rejected')) setRefreshWarning(true);
  }

  function applyCommittedMutation(
    result: { readonly item: GlobalTaskItem; readonly receipt: { readonly id: string; readonly actionKind: TaskMutationKind; readonly undoStatus: 'available' | 'not_reversible' } },
    actionKind: TaskMutationKind,
    successMessage: string
  ): void {
    setCanonicalItem(result.item);
    const savedReceipt: TaskActionReceiptMetadata = {
      id: result.receipt.id,
      actionKind,
      actorKind: 'manual',
      turnId: null,
      targetKind: 'task',
      targetId: result.item.task.id,
      postVersion: result.item.task.version,
      undoStatus: result.receipt.undoStatus,
      undoActionId: null
    };
    setReceipt(savedReceipt);
    setReceiptOwnerId(ownerId);
    setReceiptLoadError(false);
    if (ownerId) saveTaskReceiptPointer(ownerId, result.item.task.id, savedReceipt.id);
    setReceiptReloadAttempt((value) => value + 1);
    setAnnouncement(successMessage);
    setUndoError(null);
    void refreshCommittedViews();
  }

  async function saveTask(draft: ProjectTaskDraft, idempotencyKey: string, expectedVersion: number | null, baseline: ProjectTask | null): Promise<TaskEditorSaveResult> {
    if (!task || !csrfToken || !baseline || expectedVersion === null) return { status: 'error', message: 'Task editing is not available right now.' };
    const patch = createTaskPatch(baseline, draft);
    if (Object.keys(patch).length === 0) return { status: 'saved', task: baseline };
    editSavingRef.current = true;
    setEditSaving(true);
    try {
      const result = await updateGlobalTask(taskId, patch, expectedVersion, csrfToken, idempotencyKey);
      applyCommittedMutation(result, 'task.update', 'Task changes saved.');
      setTaskUnavailable(false);
      return { status: 'saved', task: result.item.task };
    } catch (error: unknown) {
      if (error instanceof ApiClientError && error.statusCode === 404) {
        setTaskUnavailable(true);
        return { status: 'conflict', latest: null };
      }
      if (isTaskConflict(error)) {
        const latest = await reloadLatest();
        if (latest) return { status: 'conflict', latest: latest.task };
        return { status: 'error', message: 'This task changed, but its latest version could not be loaded. Your draft is still here; retry or refresh the page.' };
      }
      return { status: 'error', message: isUncertain(error) ? 'The edit outcome is uncertain. Retry to safely check the same edit.' : 'The task could not be updated. Review the fields and try again.' };
    } finally {
      editSavingRef.current = false;
      setEditSaving(false);
    }
  }

  function discardEditorDraft(): void {
    if (editSaving) return;
    setEditResetNonce((value) => value + 1);
    editDirtyRef.current = false;
    setEditDirty(false);
    setExitPromptOpen(false);
    const resolveSignOut = signOutResolverRef.current;
    if (resolveSignOut) {
      signOutResolverRef.current = null;
      signOutPromiseRef.current = null;
      resolveSignOut(true);
      return;
    }
    if (blocker.state === 'blocked') {
      blocker.proceed();
      return;
    }
  }

  function keepEditorDraft(): void {
    setExitPromptOpen(false);
    if (blocker.state === 'blocked') blocker.reset();
    const resolveSignOut = signOutResolverRef.current;
    signOutResolverRef.current = null;
    signOutPromiseRef.current = null;
    resolveSignOut?.(false);
  }

  function openMove(): void {
    if (!task) return;
    const pending = moveIntent.current?.taskId === task.id && moveIntent.current.expectedVersion === task.version ? moveIntent.current : null;
    if (pending) {
      setSelectedWorkspaceId(pending.workspaceId ?? '');
    } else {
      moveIntent.current = null;
      setSelectedWorkspaceId(task.projectId ?? '');
      setMoveError(null);
    }
    setMoveOpen(true);
  }

  async function submitMove(): Promise<void> {
    if (!task || !csrfToken || selectedWorkspaceId === (task.projectId ?? '')) return;
    const workspaceId = selectedWorkspaceId || null;
    const intent = moveIntent.current?.taskId === task.id && moveIntent.current.expectedVersion === task.version && moveIntent.current.workspaceId === workspaceId
      ? moveIntent.current
      : { taskId: task.id, expectedVersion: task.version, workspaceId, key: crypto.randomUUID() };
    moveIntent.current = intent;
    setMoveSaving(true);
    setMoveError(null);
    try {
      const result = await moveGlobalTask(task.id, workspaceId, intent.expectedVersion, csrfToken, intent.key);
      moveIntent.current = null;
      setMoveOpen(false);
      applyCommittedMutation(result, 'task.move', `Task moved to ${result.item.workspace?.name ?? 'Inbox'}.`);
    } catch (error: unknown) {
      if (isTaskConflict(error)) {
        moveIntent.current = null;
        await reloadLatest();
        setMoveError({ message: 'This task changed elsewhere. The latest version is loaded; confirm the destination and try again.', retryable: false });
      } else if (isUncertain(error)) {
        setMoveError({ message: 'The move outcome is uncertain. Retry the same destination to safely check the request.', retryable: true });
      } else {
        moveIntent.current = null;
        setMoveError({ message: 'The task could not be moved. Check its destination and try again.', retryable: false });
      }
    } finally {
      setMoveSaving(false);
    }
  }

  async function deleteTask(): Promise<void> {
    if (!task || !csrfToken || deleteSavingRef.current) return;
    const targetTaskId = task.id;
    const targetLocationPath = location.pathname;
    const intent = deleteIntent.current?.taskId === task.id && deleteIntent.current.expectedVersion === task.version
      ? deleteIntent.current
      : { taskId: task.id, expectedVersion: task.version, key: crypto.randomUUID() };
    deleteIntent.current = intent;
    deleteSavingRef.current = true;
    setDeleteSaving(true);
    setDeleteError(null);
    try {
      await deleteGlobalTask(targetTaskId, intent.expectedVersion, csrfToken, intent.key);
      deleteIntent.current = null;
      if (ownerId) clearTaskReceiptPointer(ownerId, targetTaskId);
      if (!pageActiveRef.current || taskIdRef.current !== targetTaskId || locationPathRef.current !== targetLocationPath) return;
      editDirtyRef.current = false;
      setEditDirty(false);
      setDeleteOpen(false);
      deleteSavingRef.current = false;
      setDeleteSaving(false);
      navigate(path, { replace: true });
    } catch (error: unknown) {
      if (!pageActiveRef.current || taskIdRef.current !== targetTaskId || locationPathRef.current !== targetLocationPath) return;
      if (isTaskConflict(error)) {
        deleteIntent.current = null;
        const latest = await reloadLatest();
        if (error instanceof ApiClientError && error.statusCode === 404 && !latest) {
          setTaskUnavailable(true);
          setDeleteError({ message: 'This task is no longer available. Your unsaved draft is still here.', retryable: false });
        } else if (latest) {
          setDeleteError({ message: 'This task changed elsewhere. The latest version is loaded; review it before deleting.', retryable: false });
        } else {
          setDeleteError({ message: 'The latest task could not be loaded. Your draft is still here; try again.', retryable: true });
        }
      } else if (isUncertain(error)) {
        setDeleteError({ message: 'The delete outcome is uncertain. Retry to safely check the same request.', retryable: true });
      } else {
        deleteIntent.current = null;
        setDeleteError({ message: 'The task could not be deleted. Review its latest state and try again.', retryable: false });
      }
    } finally {
      deleteSavingRef.current = false;
      if (pageActiveRef.current) setDeleteSaving(false);
    }
  }

  async function undoLatestAction(): Promise<void> {
    if (!visibleReceipt || !csrfToken || visibleReceipt.undoStatus !== 'available') return;
    const intent = undoIntent.current?.actionId === visibleReceipt.id ? undoIntent.current : { actionId: visibleReceipt.id, key: crypto.randomUUID() };
    undoIntent.current = intent;
    setUndoSaving(true);
    setUndoError(null);
    try {
      const result = await undoTaskAction(visibleReceipt.id, csrfToken, intent.key);
      undoIntent.current = null;
      setReceipt(result.originalAction);
      setReceiptOwnerId(ownerId);
      if (result.target?.kind === 'task') setCanonicalItem(result.target.item);
      else setLoadAttempt((value) => value + 1);
      setAnnouncement('Undo completed. The task is restored to its saved state.');
      setReceiptReloadAttempt((value) => value + 1);
      void refreshCommittedViews();
    } catch (error: unknown) {
      if (error instanceof ApiClientError && error.statusCode === 409) {
        undoIntent.current = null;
        await reloadLatest();
        setUndoError({ message: 'This task changed after the action, so Undo was not applied. The latest task and receipt are loaded.', retryable: false });
        setReceiptReloadAttempt((value) => value + 1);
      } else if (error instanceof ApiClientError && error.statusCode === 404) {
        undoIntent.current = null;
        if (ownerId) clearTaskReceiptPointer(ownerId, taskId);
        setReceipt(null);
        setReceiptOwnerId(null);
        setUndoError({ message: 'This saved receipt is no longer available.', retryable: false });
      } else if (isUncertain(error)) {
        setUndoError({ message: 'The undo outcome is uncertain. Retry with the same request or refresh the saved receipt.', retryable: true });
      } else {
        undoIntent.current = null;
        setUndoError({ message: 'Undo could not be applied. Refresh the saved receipt before trying again.', retryable: false });
      }
    } finally {
      setUndoSaving(false);
    }
  }

  if (!current || current.status === 'loading') {
    return <section className="task-detail-page" aria-busy="true" data-testid="task-detail-loading"><p role="status">Loading task…</p><Skeleton className="project-heading-skeleton" /></section>;
  }
  if (current.status === 'error' || !current.item) {
    return <ErrorState title="Task could not be loaded" detail="This task may have moved or is no longer available." testId="task-detail-error" action={<div className="error-state-actions"><Button type="button" variant="secondary" onClick={() => { setLoadAttempt((value) => value + 1); }}>Try again</Button><Link className="button button-secondary" data-testid="task-detail-back-to-tasks" to={path}>Back to tasks</Link></div>} />;
  }

  const visibleItem = current.item;
  const visibleTask = visibleItem.task;
  const historical = visibleItem.workspace?.status === 'archived';
  const renderHeader = (editorActions?: React.ReactNode): React.JSX.Element => <header className="task-detail-header"><div><p className="product-label">{visibleItem.workspace?.name ?? 'Inbox'}{visibleItem.workspace?.status === 'archived' ? ' · Archived workspace' : ''}</p><h1 ref={pageHeadingRef} tabIndex={-1}>{visibleTask.title}</h1></div>
    {canMutate ? <div className="task-detail-toolbar"><div className="task-detail-actions" aria-label="Task actions">{editorActions}
      <Button ref={moveTriggerRef} type="button" variant="secondary" data-testid="task-move-open" aria-describedby={editDirty ? 'task-move-disabled-reason' : undefined} disabled={editDirty || editSaving} title={editDirty ? 'Save or cancel edits before moving this task' : undefined} onClick={openMove}>Move</Button>
      <Button type="button" variant="destructive" data-testid="task-delete-open" disabled={deleteSaving || editSaving || taskUnavailable || !csrfToken} onClick={() => { setDeleteError(null); setDeleteOpen(true); }}>
        Delete
      </Button>
    </div>
    {editDirty ? <p id="task-move-disabled-reason" className="supporting-copy">Save or cancel edits before moving this task.</p> : null}
    </div> : null}
  </header>;
  return <article className="task-detail-page" data-testid="task-detail-page">
    {!canMutate ? renderHeader() : null}
    {visibleItem.workspace?.status === 'archived' ? <Alert tone="warning" data-testid="task-detail-archived-workspace">This task belongs to an archived workspace and is read-only here.</Alert> : null}
    {canMutate ? <TaskDetailEditor key={`${ownerId ?? 'anonymous'}:${visibleTask.id}`} task={visibleTask} saving={editSaving} resetNonce={editResetNonce} unavailable={taskUnavailable} renderHeader={renderHeader} onSave={saveTask} onDirtyChange={onEditorDirtyChange} onCancelRequest={() => { setExitPromptOpen(true); }} onTaskUnavailable={() => { setTaskUnavailable(true); }} /> : null}
    <dl className="task-detail-fields">
      <div><dt>Status</dt><dd><ProjectTaskStatusLabel status={visibleTask.status} /></dd></div>
      <div><dt>Location</dt><dd>{visibleItem.workspace ? `${visibleItem.workspace.name}${visibleItem.workspace.status === 'archived' ? ' (archived workspace)' : ''}` : 'Inbox'}</dd></div>
    </dl>
    {!canMutate && visibleTask.details ? <section aria-labelledby="task-detail-details-heading"><h2 id="task-detail-details-heading">Details</h2><p className="task-detail-copy">{visibleTask.details}</p></section> : null}
    {!canMutate && visibleTask.subtasks.length ? <section aria-labelledby="task-detail-checklist-heading"><h2 id="task-detail-checklist-heading">Checklist</h2><ul className="task-detail-checklist">{visibleTask.subtasks.map((subtask) => <li key={subtask.id}><span>{subtask.completed ? 'Completed' : 'Open'}</span> {subtask.title}</li>)}</ul></section> : null}
    <section className="task-detail-source" data-testid="task-detail-source"><h2>Source</h2><p>{visibleTask.source.label}</p>{visibleTask.source.kind === 'assistant_suggestion' ? <p>Accepted {new Date(visibleTask.source.acceptedAt).toLocaleString()}</p> : null}</section>
    {announcement ? <p role="status" aria-live="polite" data-testid="task-action-announcement">{announcement}</p> : null}
    {refreshWarning ? <Alert tone="warning" data-testid="task-refresh-warning" role="alert">The task change was saved, but some lists or counts may be stale. <Button type="button" variant="secondary" data-testid="task-refresh-views" onClick={() => { void refreshCommittedViews(); }}>Refresh views</Button></Alert> : null}
    {visibleReceipt ? <section className="task-action-receipt" aria-labelledby="task-action-receipt-heading" data-testid="task-action-receipt">
      <Alert tone={visibleReceipt.undoStatus === 'undone' ? 'info' : 'success'} live="polite">
        <h2 id="task-action-receipt-heading">{receiptHeading(visibleReceipt.actionKind)}</h2>
        <p>Saved for <Link to={`/tasks/${encodeURIComponent(taskId)}${historical ? '?includeArchived=true' : ''}`}>{visibleTask.title}</Link>.</p>
        {visibleReceipt.undoStatus === 'undone' ? <p data-testid="task-undo-complete">Undo completed.</p> : null}
        {visibleReceipt.undoStatus === 'not_reversible' ? <p>This saved action cannot be undone.</p> : null}
        {visibleReceipt.undoStatus === 'available' ? <Button type="button" variant="secondary" data-testid="task-undo" disabled={undoSaving || !csrfToken} aria-busy={undoSaving || undefined} onClick={() => { void undoLatestAction(); }}>
          {undoSaving ? 'Undoing…' : undoError?.retryable ? 'Retry undo' : undoError ? 'Try Undo again' : 'Undo'}
        </Button> : null}
      </Alert>
      {undoError ? <Alert tone="error" role="alert" data-testid="task-undo-error"><p>{undoError.message}</p>{undoError.retryable ? <Button type="button" variant="secondary" data-testid="task-undo-refresh-receipt" onClick={() => { setReceiptReloadAttempt((value) => value + 1); }}>Refresh receipt</Button> : null}</Alert> : null}
    </section> : receiptLoading ? <p role="status" data-testid="task-receipt-loading">Checking saved receipt…</p> : receiptLoadError ? <Alert tone="warning" data-testid="task-receipt-load-error">The saved task is still available, but its receipt could not be checked. <Button type="button" variant="secondary" data-testid="task-receipt-refresh" onClick={() => { setReceiptReloadAttempt((value) => value + 1); }}>Refresh receipt</Button></Alert> : null}
    <Link className="button button-secondary" data-testid="task-detail-back-to-tasks" to={path}>Back to tasks</Link>
    <TaskConfirmationDialog open={deleteOpen} title="Delete task?" description={`“${visibleTask.title}” and its checklist will be deleted. This cannot be undone.${editDirty ? ' Your unsaved edits will also be discarded.' : ''}`}
      pendingLabel="Deleting…"
      confirmLabel={deleteError?.retryable ? 'Retry delete' : 'Delete task'} pending={deleteSaving} testId="task-delete-confirmation" error={deleteError?.message}
      onOpenChange={(open) => { if (!open && !deleteSaving) { setDeleteOpen(false); setDeleteError(null); } }} onConfirm={() => { void deleteTask(); }} />
    <AlertDialogRoot open={(blocker.state === 'blocked' && !deleteSavingRef.current) || exitPromptOpen} onOpenChange={(open) => { if (!open && !editSaving && !deleteSavingRef.current) keepEditorDraft(); }}>
      <AlertDialogContent data-testid="task-dirty-exit-confirmation" aria-describedby="task-dirty-exit-description">
        <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
        <AlertDialogDescription id="task-dirty-exit-description">Your changes to this task have not been saved.</AlertDialogDescription>
        <div className="dialog-actions"><AlertDialogCancel asChild><Button type="button" variant="secondary" data-testid="task-dirty-exit-keep" disabled={editSaving} onClick={keepEditorDraft}>Keep editing</Button></AlertDialogCancel><Button type="button" variant="destructive" data-testid="task-dirty-exit-discard" disabled={editSaving} onClick={discardEditorDraft}>Discard changes</Button></div>
      </AlertDialogContent>
    </AlertDialogRoot>
    <TaskMoveDialog open={moveOpen} currentLocation={currentLocation} currentWorkspaceId={visibleTask.projectId} projects={projects} projectListStatus={projectListStatus}
      selectedWorkspaceId={selectedWorkspaceId} saving={moveSaving} error={moveError?.message ?? null} retryable={moveError?.retryable ?? false}
      onCloseAutoFocus={(event) => { event.preventDefault(); moveTriggerRef.current?.focus(); }}
      onOpenChange={(open) => { if (!open && !moveSaving) setMoveOpen(false); }}
      onWorkspaceChange={(workspaceId) => { setSelectedWorkspaceId(workspaceId); if (moveIntent.current?.workspaceId !== (workspaceId || null)) moveIntent.current = null; setMoveError(null); }}
      onRetryWorkspaces={() => { void dispatch(loadProjects()); }} onSubmit={() => { void submitMove(); }} />
  </article>;
}

function isTaskConflict(error: unknown): boolean {
  return error instanceof ApiClientError && (error.statusCode === 409 || error.statusCode === 404);
}

function isUncertain(error: unknown): boolean {
  return !(error instanceof ApiClientError) || error.statusCode >= 500;
}

function receiptHeading(actionKind: string): string {
  if (actionKind === 'task.update') return 'Task changes saved';
  if (actionKind === 'task.move') return 'Task move saved';
  if (actionKind === 'task.archive') return 'Task archive saved';
  if (actionKind === 'task.create') return 'Task creation saved';
  return 'Task action saved';
}
