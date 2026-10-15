export type ProjectStatus = 'active' | 'archived';

export interface ProjectSnapshot {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly relativeRoot: string | null;
  readonly objective?: string | null;
  readonly workspaceMode?: 'planning' | 'file_backed';
  readonly capabilities?: { readonly planning: true; readonly fileAccess: boolean };
  readonly status: ProjectStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectListResponse {
  readonly projects: ProjectSnapshot[];
}

export interface ProjectState {
  readonly listStatus: 'idle' | 'loading' | 'success' | 'error';
  readonly projects: readonly ProjectSnapshot[];
  readonly errorCode: string | null;
  readonly detailById: Record<string, ProjectDetailState>;
}

export interface ProjectDetailState {
  readonly status: 'idle' | 'loading' | 'success' | 'error';
  readonly project: ProjectSnapshot | null;
  readonly errorCode: string | null;
}
