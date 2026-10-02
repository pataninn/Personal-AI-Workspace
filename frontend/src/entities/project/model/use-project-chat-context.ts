import { useCallback, useEffect, useRef, useState } from 'react';

import { getProjectChatContext, updateProjectChatContext, type ProjectChatContext } from '@/entities/project/api/project-chat-context-api';

export function useProjectChatContext(projectId: string, csrfToken: string | null): {
  readonly context: ProjectChatContext | null;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly reload: () => void;
  readonly save: (changes: Partial<ProjectChatContext>) => Promise<boolean>;
} {
  const [context, setContext] = useState<ProjectChatContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const busy = useRef(false);
  const currentProject = useRef(projectId);
  currentProject.current = projectId;

  useEffect(() => {
    let cancelled = false;
    setContext(null); setLoading(true); setError(null);
    void getProjectChatContext(projectId).then((value) => {
      if (!cancelled) setContext(value);
    }).catch(() => {
      if (!cancelled) setError('Project context could not be loaded. Try again.');
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, attempt]);

  const save = useCallback(async (changes: Partial<ProjectChatContext>): Promise<boolean> => {
    if (!csrfToken || busy.current) return false;
    busy.current = true; setSaving(true); setError(null);
    try {
      const saved = await updateProjectChatContext(projectId, changes, csrfToken);
      if (currentProject.current === projectId) setContext(saved);
      return true;
    } catch {
      if (currentProject.current === projectId) setError('Context could not be saved. Your previous selection is still in use. Try again.');
      return false;
    } finally { busy.current = false; setSaving(false); }
  }, [csrfToken, projectId]);

  return { context, loading, saving, error, save, reload: () => setAttempt((value) => value + 1) };
}
