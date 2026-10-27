import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';

import { getProject, listProjects } from '@/entities/project/api/project-api';
import type { ProjectDetailState, ProjectListResponse, ProjectSnapshot, ProjectState } from '@/entities/project/model/types';
import { ApiClientError, notifySessionExpiry } from '@/shared/api';

const initialDetail: ProjectDetailState = { status: 'idle', project: null, errorCode: null };

const initialState: ProjectState = {
  generation: 0,
  listStatus: 'idle',
  projects: [],
  errorCode: null,
  detailById: {}
};

function errorCode(error: unknown): string {
  return error instanceof ApiClientError ? error.code : 'NETWORK_ERROR';
}

export const loadProjects = createAsyncThunk<ProjectListResponse, void, { rejectValue: string }>(
  'project/loadProjects',
  async (_, { rejectWithValue, getState }) => {
    const generation = (getState() as { project: ProjectState }).project.generation ?? 0;
    try {
      return await listProjects(true);
    } catch (error: unknown) {
      if (error instanceof ApiClientError && generation === ((getState() as { project: ProjectState }).project.generation ?? 0)) {
        notifySessionExpiry(error.statusCode, error.code, error);
      }
      return rejectWithValue(errorCode(error));
    }
  },
  { condition: (_, { getState }) => (getState() as { project: ProjectState }).project.listStatus !== 'loading' }
);

export const loadProject = createAsyncThunk<ProjectSnapshot, string, { rejectValue: string }>(
  'project/loadProject',
  async (projectId, { rejectWithValue, getState }) => {
    const generation = (getState() as { project: ProjectState }).project.generation ?? 0;
    try {
      return await getProject(projectId);
    } catch (error: unknown) {
      if (error instanceof ApiClientError && generation === ((getState() as { project: ProjectState }).project.generation ?? 0)) {
        notifySessionExpiry(error.statusCode, error.code, error);
      }
      return rejectWithValue(errorCode(error));
    }
  },
  { condition: (projectId, { getState }) => (getState() as { project: ProjectState }).project.detailById[projectId]?.status !== 'loading' }
);

function upsertProject(projects: readonly ProjectSnapshot[], project: ProjectSnapshot): ProjectSnapshot[] {
  const withoutProject = projects.filter((candidate) => candidate.id !== project.id);
  return [...withoutProject, project].sort((left, right) => {
    if (left.status !== right.status) {
      return left.status === 'active' ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

const projectSlice = createSlice({
  name: 'project',
  initialState,
  reducers: {
    projectSessionChanged(state): ProjectState {
      return { ...initialState, generation: (state.generation ?? 0) + 1 };
    },
    projectCreated: {
      prepare: (project: ProjectSnapshot, generation: number) => ({ payload: project, meta: { generation } }),
      reducer(state, action: PayloadAction<ProjectSnapshot, string, { generation: number }>): void {
        if (action.meta.generation !== (state.generation ?? 0)) return;
        state.projects = upsertProject(state.projects, action.payload);
        state.detailById[action.payload.id] = { status: 'success', project: action.payload, errorCode: null };
      }
    },
    projectStatusUpdated: {
      prepare: (project: ProjectSnapshot, generation: number) => ({ payload: project, meta: { generation } }),
      reducer(state, action: PayloadAction<ProjectSnapshot, string, { generation: number }>): void {
        if (action.meta.generation !== (state.generation ?? 0)) return;
        state.projects = upsertProject(state.projects, action.payload);
        state.detailById[action.payload.id] = { status: 'success', project: action.payload, errorCode: null };
      }
    }
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadProjects.pending, (state, action) => {
        state.listRequestId = action.meta.requestId;
        state.listStatus = 'loading';
        state.errorCode = null;
      })
      .addCase(loadProjects.fulfilled, (state, action) => {
        if (state.listRequestId !== action.meta.requestId) return;
        delete state.listRequestId;
        state.listStatus = 'success';
        state.projects = [...action.payload.projects];
        state.errorCode = null;
      })
      .addCase(loadProjects.rejected, (state, action) => {
        if (state.listRequestId !== action.meta.requestId) return;
        delete state.listRequestId;
        state.listStatus = 'error';
        state.errorCode = action.payload ?? 'NETWORK_ERROR';
      })
      .addCase(loadProject.pending, (state, action) => {
        state.detailRequestIds ??= {};
        state.detailRequestIds[action.meta.arg] = action.meta.requestId;
        state.detailById[action.meta.arg] = { status: 'loading', project: null, errorCode: null };
      })
      .addCase(loadProject.fulfilled, (state, action) => {
        if (state.detailRequestIds?.[action.meta.arg] !== action.meta.requestId) return;
        delete state.detailRequestIds[action.meta.arg];
        state.detailById[action.payload.id] = { status: 'success', project: action.payload, errorCode: null };
        state.projects = upsertProject(state.projects, action.payload);
      })
      .addCase(loadProject.rejected, (state, action) => {
        if (state.detailRequestIds?.[action.meta.arg] !== action.meta.requestId) return;
        delete state.detailRequestIds[action.meta.arg];
        state.detailById[action.meta.arg] = { status: 'error', project: null, errorCode: action.payload ?? 'NETWORK_ERROR' };
      });
  }
});

export const { projectCreated, projectStatusUpdated, projectSessionChanged } = projectSlice.actions;
export const projectReducer = projectSlice.reducer;
