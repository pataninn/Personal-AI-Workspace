import { useEffect, useState } from 'react';
import { flattenWorkspaceFiles, getWorkspaceTree } from '@/entities/workspace';

export function useContextFiles(projectId: string): {
  readonly paths: readonly string[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly truncated: boolean;
  readonly reload: () => void;
} {
  const [paths, setPaths] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setPaths([]); setLoading(true); setError(null);
    void getWorkspaceTree(projectId, 6).then((tree) => {
      if (!cancelled) { setPaths(flattenWorkspaceFiles(tree).map((file) => file.path)); setTruncated(tree.truncated); }
    }).catch(() => { if (!cancelled) setError('Project files could not be loaded. Try again.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, attempt]);
  return { paths, loading, error, truncated, reload: () => setAttempt((value) => value + 1) };
}
