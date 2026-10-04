import { useEffect, useState } from 'react';
import { getProjectOverview } from '@/entities/project/api/project-overview-api';
import type { ProjectOverview } from '@/entities/project/api/project-overview-api';
import { ApiClientError } from '@/shared/api';

export function useProjectOverview() {
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setStatus('loading'); setErrorCode(null);
    void getProjectOverview().then((result) => { if (current) { setOverview(result); setStatus('success'); } })
      .catch((error: unknown) => { if (current) { setStatus('error'); setErrorCode(error instanceof ApiClientError ? error.code : 'NETWORK_ERROR'); } });
    return () => { current = false; };
  }, [attempt]);
  return { overview, status, errorCode, refresh: (): void => { setAttempt((value) => value + 1); } };
}
