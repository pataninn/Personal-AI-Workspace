import { useCallback, useEffect, useRef, useState } from 'react';

import { getProjectChatContext, updateProjectChatContext, type ProjectChatContext } from '@/entities/project/api/project-chat-context-api';

export type ProjectChatContextSaveResult =
  | { readonly status: 'saved' | 'reconciled'; readonly context: ProjectChatContext }
  | { readonly status: 'unknown'; readonly context: null };

export function useProjectChatContext(projectId: string, csrfToken: string | null, enabled = true): {
  readonly context: ProjectChatContext | null;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly reload: () => Promise<ProjectChatContext | null>;
  readonly save: (changes: Partial<ProjectChatContext>) => Promise<ProjectChatContextSaveResult>;
} {
  const [context, setContext] = useState<ProjectChatContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const requestGeneration = useRef(0);
  const currentProject = useRef(projectId);
  currentProject.current = projectId;

  const reload = useCallback(async (): Promise<ProjectChatContext | null> => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setContext(null);
    setLoading(true);
    setError(null);
    try {
      const current = await getProjectChatContext(projectId);
      if (requestGeneration.current === generation && currentProject.current === projectId) setContext(current);
      return current;
    } catch {
      if (requestGeneration.current === generation && currentProject.current === projectId) {
        setError('Project context could not be loaded. The saved selection is unknown. Try again.');
      }
      return null;
    } finally {
      if (requestGeneration.current === generation && currentProject.current === projectId) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!enabled) {
      setContext(null);
      setLoading(false);
      setError(null);
      return;
    }
    void reload();
    return () => { requestGeneration.current += 1; };
  }, [enabled, reload]);

  const save = useCallback(async (changes: Partial<ProjectChatContext>): Promise<ProjectChatContextSaveResult> => {
    if (!enabled || !csrfToken || busy.current) return { status: 'unknown', context: null };
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      const saved = await updateProjectChatContext(projectId, changes, csrfToken);
      if (currentProject.current === projectId) setContext(saved);
      return { status: 'saved', context: saved };
    } catch {
      const current = await reload();
      if (current) {
        setError('The save response could not be confirmed. The current saved selection was reloaded; compare it with your draft.');
        return { status: 'reconciled', context: current };
      }
      setError('The save outcome could not be confirmed and the saved selection could not be reloaded. Your draft remains unsaved; reload before retrying.');
      return { status: 'unknown', context: null };
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }, [csrfToken, enabled, projectId, reload]);

  return { context, loading, saving, error, save, reload };
}
