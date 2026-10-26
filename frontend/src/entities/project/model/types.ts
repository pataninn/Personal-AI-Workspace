export type ProjectStatus = 'active' | 'archived';
export type ProjectWorkspaceMode = 'planning' | 'file_backed';

export interface ProjectCapabilities {
  readonly planning: true;
  readonly fileAccess: boolean;
}

export interface ProjectSnapshot {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly objective?: string | null;
  readonly workspaceMode: ProjectWorkspaceMode;
  readonly capabilities: ProjectCapabilities;
  readonly status: ProjectStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectListResponse {
  readonly projects: ProjectSnapshot[];
}

export interface ProjectState {
  readonly generation?: number;
  readonly listRequestId?: string;
  readonly detailRequestIds?: Record<string, string>;
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
