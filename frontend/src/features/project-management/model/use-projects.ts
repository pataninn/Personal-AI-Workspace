import { useCallback, useEffect } from 'react';

import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { loadProjects, selectProjectListStatus } from '@/entities/project';

export function useProjectListLoader(): { retry: () => void } {
  const dispatch = useAppDispatch();
  const status = useAppSelector(selectProjectListStatus);

  useEffect(() => {
    if (status === 'idle') {
      void dispatch(loadProjects());
    }
  }, [dispatch, status]);

  const retry = useCallback(() => {
    void dispatch(loadProjects());
  }, [dispatch]);
  return { retry };
}

