import { useEffect, useState } from 'react';

import { getAssistantExecutionPolicy, type AssistantExecutionPolicyStatus } from '@/entities/assistant-policy';

export type WorkspacePolicyLoadStatus = 'loading' | 'error' | 'loaded';

export function useWorkspaceAssistantPolicy(projectId: string): {
  readonly status: WorkspacePolicyLoadStatus;
  readonly policy: AssistantExecutionPolicyStatus | null;
  readonly ready: boolean;
  readonly retry: () => void;
} {
  const [status, setStatus] = useState<WorkspacePolicyLoadStatus>('loading');
  const [policy, setPolicy] = useState<AssistantExecutionPolicyStatus | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setStatus('loading');
    setPolicy(null);
    void getAssistantExecutionPolicy({ scope: 'workspace', projectId })
      .then((result) => {
        if (!active) return;
        setPolicy(result);
        setStatus('loaded');
      })
      .catch(() => {
        if (active) setStatus('error');
      });
    return () => { active = false; };
  }, [attempt, projectId]);

  const ready = status === 'loaded'
    && policy?.readiness.state === 'ready'
    && policy.policy?.enabled === true
    && policy.policy.provider !== null;

  return { status, policy, ready, retry: () => setAttempt((current) => current + 1) };
}
