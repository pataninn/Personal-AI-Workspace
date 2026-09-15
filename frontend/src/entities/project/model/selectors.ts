import type { RootState } from '@/app/store/store';

const EMPTY_PROJECT_STATE = { listStatus: 'success' as const, projects: [], errorCode: null, detailById: {} };

export const selectProjectState = (state: RootState) => state.project ?? EMPTY_PROJECT_STATE;
export const selectProjects = (state: RootState) => (state.project ?? EMPTY_PROJECT_STATE).projects;
export const selectProjectListStatus = (state: RootState) => (state.project ?? EMPTY_PROJECT_STATE).listStatus;
export const selectProjectErrorCode = (state: RootState) => (state.project ?? EMPTY_PROJECT_STATE).errorCode;
export const selectProjectById = (projectId: string) => (state: RootState) => (state.project ?? EMPTY_PROJECT_STATE).projects.find((project) => project.id === projectId) ?? null;
export const selectProjectDetail = (projectId: string) => (state: RootState) => (state.project ?? EMPTY_PROJECT_STATE).detailById[projectId] ?? { status: 'idle' as const, project: null, errorCode: null };
