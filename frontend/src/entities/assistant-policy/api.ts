import { getJson } from '@/shared/api';
import type { AssistantExecutionPolicyQuery, AssistantExecutionPolicyStatus } from '@/entities/assistant-policy/model/types';

const EXECUTION_POLICY_PATH = '/api/v1/assistant/execution-policy';

export function getAssistantExecutionPolicy(query: AssistantExecutionPolicyQuery): Promise<AssistantExecutionPolicyStatus> {
  const parameters = new URLSearchParams({ scope: query.scope });
  if (query.scope === 'workspace') parameters.set('projectId', query.projectId);
  return getJson<AssistantExecutionPolicyStatus>(`${EXECUTION_POLICY_PATH}?${parameters.toString()}`);
}
