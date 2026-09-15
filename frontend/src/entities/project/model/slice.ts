import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';

import { getProject, listProjects } from '@/entities/project/api/project-api';
import type { ProjectDetailState, ProjectListResponse, ProjectSnapshot, ProjectState } from '@/entities/project/model/types';
import { ApiClientError, notifySessionExpiry } from '@/shared/api';

const initialDetail: ProjectDetailState = { status: 'idle', project: null, errorCode: null };

const initialState: ProjectState = {
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
  async (_, { rejectWithValue }) => {
    try {
      return await listProjects(true);
    } catch (error: unknown) {
      if (error instanceof ApiClientError) {
        notifySessionExpiry(error.statusCode, error.code, error);
      }
      return rejectWithValue(errorCode(error));
    }
  },
  { condition: (_, { getState }) => (getState() as { project: ProjectState }).project.listStatus !== 'loading' }
);

export const loadProject = createAsyncThunk<ProjectSnapshot, string, { rejectValue: string }>(
  'project/loadProject',
  async (projectId, { rejectWithValue }) => {
    try {
      return await getProject(projectId);
    } catch (error: unknown) {
      if (error instanceof ApiClientError) {
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
    projectCreated(state, action: PayloadAction<ProjectSnapshot>): void {
      state.projects = upsertProject(state.projects, action.payload);
      state.detailById[action.payload.id] = { status: 'success', project: action.payload, errorCode: null };
    },
    projectStatusUpdated(state, action: PayloadAction<ProjectSnapshot>): void {
      state.projects = upsertProject(state.projects, action.payload);
      state.detailById[action.payload.id] = { status: 'success', project: action.payload, errorCode: null };
    }
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadProjects.pending, (state) => {
        state.listStatus = 'loading';
        state.errorCode = null;
      })
      .addCase(loadProjects.fulfilled, (state, action) => {
        state.listStatus = 'success';
        state.projects = [...action.payload.projects];
        state.errorCode = null;
      })
      .addCase(loadProjects.rejected, (state, action) => {
        state.listStatus = 'error';
        state.errorCode = action.payload ?? 'NETWORK_ERROR';
      })
      .addCase(loadProject.pending, (state, action) => {
        state.detailById[action.meta.arg] = { status: 'loading', project: null, errorCode: null };
      })
      .addCase(loadProject.fulfilled, (state, action) => {
        state.detailById[action.payload.id] = { status: 'success', project: action.payload, errorCode: null };
        state.projects = upsertProject(state.projects, action.payload);
      })
      .addCase(loadProject.rejected, (state, action) => {
        state.detailById[action.meta.arg] = { status: 'error', project: null, errorCode: action.payload ?? 'NETWORK_ERROR' };
      });
  }
});

export const { projectCreated, projectStatusUpdated } = projectSlice.actions;
export const projectReducer = projectSlice.reducer;
