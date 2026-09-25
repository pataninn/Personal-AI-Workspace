import { useCallback, useRef, useState } from 'react';

import { ApiClientError } from '@/shared/api';
import { createProjectFact, deleteProjectFact, updateProjectFact, verifyProjectFact } from '@/entities/project-fact';
import type { ProjectFact, ProjectFactDraft } from '@/entities/project-fact';

export type ProjectMemoryAction = 'save' | 'verify' | 'delete';

export function useProjectMemoryActions(projectId: string, csrfToken: string | null): {
  readonly pendingAction: ProjectMemoryAction | null;
  readonly create: (draft: ProjectFactDraft) => Promise<ProjectFact>;
  readonly update: (factId: string, draft: ProjectFactDraft, version: number) => Promise<ProjectFact>;
  readonly verify: (factId: string, version: number) => Promise<ProjectFact>;
  readonly remove: (factId: string, version: number) => Promise<void>;
} {
  const [pendingAction, setPendingAction] = useState<ProjectMemoryAction | null>(null);
  const busyRef = useRef(false);

  const run = useCallback(async <T,>(action: ProjectMemoryAction, operation: (token: string) => Promise<T>): Promise<T> => {
    if (!csrfToken) {
      throw new ApiClientError(401, 'SESSION_UNAUTHENTICATED', 'The local session is not available.');
    }
    if (busyRef.current) {
      throw new ApiClientError(409, 'REQUEST_IN_PROGRESS', 'A memory update is already in progress.');
    }
    busyRef.current = true;
    setPendingAction(action);
    try {
      return await operation(csrfToken);
    } finally {
      busyRef.current = false;
      setPendingAction(null);
    }
  }, [csrfToken]);

  const create = useCallback((draft: ProjectFactDraft): Promise<ProjectFact> => run('save', (token) => createProjectFact(projectId, draft, token)), [projectId, run]);
  const update = useCallback((factId: string, draft: ProjectFactDraft, version: number): Promise<ProjectFact> => run('save', (token) => updateProjectFact(projectId, factId, draft, version, token)), [projectId, run]);
  const verify = useCallback((factId: string, version: number): Promise<ProjectFact> => run('verify', (token) => verifyProjectFact(projectId, factId, version, token)), [projectId, run]);
  const remove = useCallback((factId: string, version: number): Promise<void> => run('delete', (token) => deleteProjectFact(projectId, factId, version, token)), [projectId, run]);

  return { pendingAction, create, update, verify, remove };
}
