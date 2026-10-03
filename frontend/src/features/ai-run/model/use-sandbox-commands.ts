import { useCallback, useEffect, useRef, useState } from 'react';

import {
  cancelSandboxCommand,
  decideSandboxCommand,
  getSandboxCommand,
  getSandboxCommands,
  type SandboxCommandSnapshot
} from '@/entities/ai-run';
import { ApiClientError } from '@/shared/api';
import { createIdempotencyKey } from '@/shared/lib/idempotency-key';

export type SandboxCommandAction = 'approve' | 'reject' | 'cancel';

export interface SandboxCommandActionError {
  readonly message: string;
  readonly ambiguous: boolean;
}

export interface SandboxCommandActionState {
  readonly action: SandboxCommandAction;
  readonly error?: SandboxCommandActionError;
}

interface UseSandboxCommandsOptions {
  readonly enabled: boolean;
  readonly polling?: boolean;
  readonly runId: string;
  readonly csrfToken: string | null;
}

interface UseSandboxCommandsResult {
  readonly commands: readonly SandboxCommandSnapshot[];
  readonly status: 'idle' | 'loading' | 'success' | 'error';
  readonly error: string | null;
  readonly refreshing: boolean;
  readonly actions: Readonly<Record<string, SandboxCommandActionState>>;
  readonly refresh: () => void;
  readonly decide: (command: SandboxCommandSnapshot, decision: 'approve' | 'reject') => void;
  readonly cancel: (command: SandboxCommandSnapshot) => void;
}

const GENERIC_ERROR = 'We could not load the command status. Refresh the run status.';

export function useSandboxCommands({ enabled, polling = false, runId, csrfToken }: UseSandboxCommandsOptions): UseSandboxCommandsResult {
  const [commands, setCommands] = useState<readonly SandboxCommandSnapshot[]>([]);
  const [status, setStatus] = useState<UseSandboxCommandsResult['status']>('idle');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [actions, setActions] = useState<Readonly<Record<string, SandboxCommandActionState>>>({});
  const [refreshVersion, setRefreshVersion] = useState(0);
  const previousRunId = useRef(runId);
  const actionLocks = useRef(new Set<string>());
  const requestVersion = useRef(0);

  const refresh = useCallback((): void => {
    setRefreshVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!enabled || !polling) return undefined;
    const timer = window.setInterval(refresh, 1500);
    return () => window.clearInterval(timer);
  }, [enabled, polling, refresh]);

  useEffect(() => {
    if (previousRunId.current !== runId) {
      previousRunId.current = runId;
      setCommands([]);
      setActions({});
      setError(null);
      actionLocks.current.clear();
    }
  }, [runId]);

  useEffect(() => {
    if (!enabled || !runId) {
      requestVersion.current += 1;
      setCommands([]);
      setStatus('idle');
      setError(null);
      setActions({});
      setRefreshing(false);
      actionLocks.current.clear();
      return undefined;
    }
    let cancelled = false;
    const version = ++requestVersion.current;
    setStatus((current) => current === 'success' ? current : 'loading');
    setRefreshing(true);
    void getSandboxCommands(runId)
      .then((result) => {
        if (!cancelled && version === requestVersion.current) {
          setCommands((current) => mergeRefreshedCommands(current, result.commands, actionLocks.current));
          setStatus('success');
          setError(null);
          setRefreshing(false);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled && version === requestVersion.current) {
          setStatus('error');
          setError(mapSurfaceError(cause));
          setRefreshing(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, refreshVersion, runId]);

  function replaceCommand(command: SandboxCommandSnapshot): void {
    setCommands((current) => current.map((item) => item.commandId === command.commandId ? command : item));
  }

  function clearAction(commandId: string): void {
    setActions((current) => {
      const next = { ...current };
      delete next[commandId];
      return next;
    });
  }

  function releaseAction(commandId: string): void {
    actionLocks.current.delete(commandId);
    clearAction(commandId);
  }

  function setAction(commandId: string, action: SandboxCommandAction): void {
    setActions((current) => ({ ...current, [commandId]: { action } }));
  }

  function setActionError(commandId: string, action: SandboxCommandAction, cause: unknown): void {
    setActions((current) => ({
      ...current,
      [commandId]: { action, error: mapActionError(cause, action) }
    }));
  }

  async function reconcileAfterFailure(command: SandboxCommandSnapshot, action: SandboxCommandAction, cause: unknown): Promise<void> {
    try {
      const authoritative = await getSandboxCommand(command.runId, command.commandId);
      replaceCommand(authoritative);
      if (authoritative.status !== command.status || authoritative.decision !== command.decision) {
        releaseAction(command.commandId);
        return;
      }
    } catch {
      setActionError(command.commandId, action, cause);
      return;
    }
    setActionError(command.commandId, action, cause);
  }

  async function submitDecision(command: SandboxCommandSnapshot, decision: 'approve' | 'reject'): Promise<void> {
    if (!csrfToken || actions[command.commandId] || actionLocks.current.has(command.commandId)) {
      return;
    }
    actionLocks.current.add(command.commandId);
    setAction(command.commandId, decision);
    try {
      const updated = await decideSandboxCommand(command.runId, command.commandId, { proposalHash: command.proposalHash, decision }, csrfToken, createIdempotencyKey());
      replaceCommand(updated);
      releaseAction(command.commandId);
    } catch (cause: unknown) {
      await reconcileAfterFailure(command, decision, cause);
      actionLocks.current.delete(command.commandId);
    }
  }

  async function submitCancel(command: SandboxCommandSnapshot): Promise<void> {
    if (!csrfToken || actions[command.commandId] || actionLocks.current.has(command.commandId)) {
      return;
    }
    actionLocks.current.add(command.commandId);
    setAction(command.commandId, 'cancel');
    try {
      const updated = await cancelSandboxCommand(command.runId, command.commandId, csrfToken, createIdempotencyKey());
      replaceCommand(updated);
      releaseAction(command.commandId);
    } catch (cause: unknown) {
      await reconcileAfterFailure(command, 'cancel', cause);
      actionLocks.current.delete(command.commandId);
    }
  }

  return {
    commands,
    status,
    error,
    refreshing,
    actions,
    refresh,
    decide: (command, decision) => { void submitDecision(command, decision); },
    cancel: (command) => { void submitCancel(command); }
  };
}

function mergeRefreshedCommands(
  current: readonly SandboxCommandSnapshot[],
  refreshed: readonly SandboxCommandSnapshot[],
  lockedIds: ReadonlySet<string>
): readonly SandboxCommandSnapshot[] {
  const refreshedIds = new Set(refreshed.map((command) => command.commandId));
  const lockedCurrent = current.filter((command) => lockedIds.has(command.commandId) && !refreshedIds.has(command.commandId));
  return [
    ...refreshed.map((command) => lockedIds.has(command.commandId) ? current.find((item) => item.commandId === command.commandId) ?? command : command),
    ...lockedCurrent
  ];
}

function mapSurfaceError(cause: unknown): string {
  if (cause instanceof ApiClientError && cause.code === 'COMMAND_RUN_NOT_READY') {
    return 'The private run environment is not ready for sandbox commands.';
  }
  return GENERIC_ERROR;
}

function mapActionError(cause: unknown, action: SandboxCommandAction): SandboxCommandActionError {
  if (cause instanceof ApiClientError && cause.code === 'COMMAND_BLOCKED') {
    return { message: 'Command blocked by sandbox policy. This command was not run.', ambiguous: false };
  }
  if (cause instanceof ApiClientError && cause.code === 'COMMAND_PROPOSAL_CONFLICT') {
    return { message: 'This command proposal is no longer current. Refresh command status before deciding again.', ambiguous: false };
  }
  if (cause instanceof ApiClientError && cause.code === 'COMMAND_REVIEW_REQUIRED') {
    return { message: 'We could not confirm whether the command started or stopped. Do not retry automatically; refresh command status.', ambiguous: true };
  }
  if (action === 'cancel') {
    return { message: 'Command status could not be confirmed. Refresh command status before retrying.', ambiguous: true };
  }
  return { message: 'We could not confirm the command decision. Refresh command status before trying again.', ambiguous: true };
}
