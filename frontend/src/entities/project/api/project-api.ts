import { deleteNoContent, getJson, patchJson, postJson } from '@/shared/api';
import type { ProjectListResponse, ProjectSnapshot, ProjectStatus } from '@/entities/project/model/types';

const PROJECTS_PATH = '/api/v1/projects';

export function removeProject(projectId: string, version: number, csrfToken: string): Promise<void> {
  return deleteNoContent(`${PROJECTS_PATH}/${encodeURIComponent(projectId)}`, { 'X-CSRF-Token': csrfToken, 'If-Match': String(version) });
}

export interface CreateProjectRequest {
  readonly name: string;
  readonly objective?: string;
  readonly workspaceMode: 'planning';
  readonly relativeRoot?: never;
}

export interface CreateFileBackedProjectRequest {
  readonly name: string;
  readonly objective?: string;
  readonly relativeRoot: string;
  readonly workspaceMode?: 'file_backed';
}

export async function listProjects(includeArchived = true): Promise<ProjectListResponse> {
  const query = includeArchived ? '?includeArchived=true' : '?includeArchived=false';
  return getJson<ProjectListResponse>(`${PROJECTS_PATH}${query}`);
}

export function getProject(projectId: string): Promise<ProjectSnapshot> {
  return getJson<ProjectSnapshot>(`${PROJECTS_PATH}/${encodeURIComponent(projectId)}`);
}

export function createProject(
  request: CreateProjectRequest | CreateFileBackedProjectRequest,
  csrfToken: string
): Promise<ProjectSnapshot> {
  return postJson<ProjectSnapshot>(PROJECTS_PATH, request, { 'X-CSRF-Token': csrfToken });
}

export function updateProjectStatus(
  projectId: string,
  status: ProjectStatus,
  version: number,
  csrfToken: string
): Promise<ProjectSnapshot> {
  return patchJson<ProjectSnapshot>(
    `${PROJECTS_PATH}/${encodeURIComponent(projectId)}`,
    { status },
    { 'X-CSRF-Token': csrfToken, 'If-Match': String(version) }
  );
}
