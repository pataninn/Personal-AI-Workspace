import { useEffect, useState } from 'react';

import { getAssistantExecutionPolicy, type AssistantExecutionPolicyQuery, type AssistantExecutionPolicyStatus } from '@/entities/assistant-policy';

export type AssistantExecutionPolicyLoadStatus = 'loading' | 'error' | 'loaded';

export function useAssistantExecutionPolicy(query: AssistantExecutionPolicyQuery): {
  readonly status: AssistantExecutionPolicyLoadStatus;
  readonly policy: AssistantExecutionPolicyStatus | null;
  readonly retry: () => void;
} {
  const [status, setStatus] = useState<AssistantExecutionPolicyLoadStatus>('loading');
  const [policy, setPolicy] = useState<AssistantExecutionPolicyStatus | null>(null);
  const [attempt, setAttempt] = useState(0);
  const scope = query.scope;
  const projectId = query.scope === 'workspace' ? query.projectId : null;

  useEffect(() => {
    let active = true;
    setStatus('loading');
    setPolicy(null);
    const currentQuery: AssistantExecutionPolicyQuery = scope === 'workspace' && projectId !== null
      ? { scope, projectId }
      : { scope: 'home' };
    void getAssistantExecutionPolicy(currentQuery)
      .then((result) => {
        if (!active) return;
        setPolicy(result);
        setStatus('loaded');
      })
      .catch(() => {
        if (active) setStatus('error');
      });
    return () => { active = false; };
  }, [attempt, projectId, scope]);

  return { status, policy, retry: () => setAttempt((current) => current + 1) };
}
