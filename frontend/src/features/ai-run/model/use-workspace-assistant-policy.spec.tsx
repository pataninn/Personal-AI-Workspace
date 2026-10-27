import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AssistantExecutionPolicyStatus } from '@/entities/assistant-policy';
import { useWorkspaceAssistantPolicy } from '@/features/ai-run/model/use-workspace-assistant-policy';

const { getPolicyMock } = vi.hoisted(() => ({ getPolicyMock: vi.fn() }));
vi.mock('@/entities/assistant-policy', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/entities/assistant-policy')>(),
  getAssistantExecutionPolicy: getPolicyMock
}));

const policy: AssistantExecutionPolicyStatus = {
  scope: { kind: 'workspace', label: 'Project workspace' },
  policy: { enabled: true, revision: '3', provider: { name: 'Provider', model: 'model' }, included: { categories: ['request'], items: [] }, exclusionsEnforced: true, capabilities: ['workspace_file_read'] },
  fileAccess: true,
  readiness: { state: 'ready' }
};

describe('useWorkspaceAssistantPolicy', () => {
  beforeEach(() => getPolicyMock.mockReset());

  it('keeps execution closed until an enabled, configured, ready scope is loaded', async () => {
    getPolicyMock.mockResolvedValue(policy);
    const { result } = renderHook(() => useWorkspaceAssistantPolicy('project-1'));

    expect(result.current.status).toBe('loading');
    expect(result.current.ready).toBe(false);
    await waitFor(() => expect(result.current.ready).toBe(true));
  });

  it('fails closed and supports retry after an unavailable request', async () => {
    getPolicyMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({
      ...policy,
      readiness: { state: 'unavailable', reasonCode: 'runtime_unverified' }
    });
    const { result } = renderHook(() => useWorkspaceAssistantPolicy('project-1'));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.ready).toBe(false);
    act(() => result.current.retry());
    await waitFor(() => expect(getPolicyMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.status).toBe('loaded'));
    expect(result.current.ready).toBe(false);
  });
});
