import { createHash, randomUUID } from 'node:crypto';
import { extname } from 'node:path';

import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IProjectTaskRepository } from '@/modules/tasks/repositories/project-task-repository';
import type { IProjectFactRepository } from '@/modules/memory/repositories/project-fact-repository';
import type { ProjectTask } from '@/modules/tasks/domain/project-task';
import type { ProjectFact } from '@/modules/memory/domain/project-fact';
import type { ProjectFileActions } from '@/modules/files/use-cases/project-file-actions';
import type { ISkillRepository } from '@/modules/skills/repositories/skill-repository';
import { WorkspaceRelativePath } from '@/modules/files/domain/workspace-path';
import { AppError } from '@/shared/errors/app-error';
import type {
  CurrentShowcaseDto,
  IShowcaseRepository,
  ShowcaseFileContent,
  ShowcaseLimits,
  ShowcasePublishOutcome,
  ShowcasePreviewDto,
  ShowcaseSourceRequest,
  ShowcaseSkillContent,
  ShowcaseTaskContent
} from '@/modules/showcases/domain/showcase-types';

type SourceFileActions = Pick<ProjectFileActions, 'download'>;

export class BuildShowcasePreviewUseCase {
  public constructor(
    private readonly projects: Pick<IProjectRepository, 'findByIdForOwner'>,
    private readonly tasks: Pick<IProjectTaskRepository, 'listTasks'>,
    private readonly facts: Pick<IProjectFactRepository, 'findActiveByIds'>,
    private readonly files: SourceFileActions,
    private readonly limits: ShowcaseLimits | undefined,
    private readonly skills?: Pick<ISkillRepository, 'findActiveEnabledForShowcase'>
  ) {}

  public async execute(adminId: string, request: ShowcaseSourceRequest): Promise<ShowcasePreviewDto> {
    const limits = this.requireLimits();
    const project = await this.projects.findByIdForOwner(adminId, request.projectId);
    if (!project || project.status !== 'active') throw notFound('PROJECT_NOT_FOUND');
    const selectedSkillIds = request.selection.skillIds ?? [];
    if (new Set(selectedSkillIds).size !== selectedSkillIds.length) throw validationError();
    if (selectedSkillIds.length > 0 && !this.skills) throw unavailable();
    const [taskSnapshot, selectedFacts, selectedSkills] = await Promise.all([
      this.tasks.listTasks(adminId, project.id, 'all'),
      request.selection.factIds.length === 0 ? Promise.resolve([] as readonly ProjectFact[]) : this.facts.findActiveByIds(adminId, project.id, request.selection.factIds),
      selectedSkillIds.length === 0 ? Promise.resolve([]) : this.skills!.findActiveEnabledForShowcase(adminId, project.id, selectedSkillIds)
    ]);
    const selectedTasks = selectAll(taskSnapshot.tasks, request.selection.taskIds);
    if (selectedFacts.length !== request.selection.factIds.length) throw notFound('SHOWCASE_SOURCE_NOT_FOUND');
    if (selectedSkills.length !== selectedSkillIds.length) throw notFound('SHOWCASE_SOURCE_NOT_FOUND');

    const safePaths = request.selection.filePaths.map((value) => {
      try { return WorkspaceRelativePath.parse(value, { field: 'selection.filePaths' }).value; }
      catch { throw validationError(); }
    });
    if (new Set(safePaths).size !== safePaths.length) throw validationError();
    const fileContents = await Promise.all(safePaths.map(async (path) => {
      let downloaded: { readonly bytes: Buffer; readonly hash: string };
      try {
        downloaded = await this.files.download({ ownerId: adminId, projectId: project.id, path });
      } catch (error: unknown) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
        if (code === 'FILE_TOO_LARGE') throw limitError();
        if (code === 'WORKSPACE_PATH_NOT_FOUND') throw notFound('SHOWCASE_SOURCE_NOT_FOUND');
        throw unavailable();
      }
      if (downloaded.bytes.length > limits.maxFileBytes) throw limitError();
      return {
        name: path,
        mediaType: safeMediaType(path),
        byteLength: downloaded.bytes.length,
        sha256: downloaded.hash,
        bytes: downloaded.bytes
      } satisfies ShowcaseFileContent;
    }));
    fileContents.sort((left, right) => compare(left.name, right.name));
    if (fileContents.length > limits.maxFiles) throw limitError();

    const orderedTasks = [...selectedTasks].sort((left, right) => left.position - right.position || compare(left.id, right.id));
    const orderedFacts = [...selectedFacts].sort((left, right) => compare(left.key, right.key) || compare(left.id, right.id));
    const taskContent = orderedTasks.map(toTaskContent);
    const factContent = orderedFacts.map((fact) => ({ title: fact.title, content: fact.content }));
    const orderedSkills = [...selectedSkills].sort((left, right) => compare(left.id, right.id));
    const skillContent: ShowcaseSkillContent[] = orderedSkills.map((skill) => ({
      title: skill.title,
      instructions: skill.instructions,
      declaredTools: [...skill.declaredTools].sort(compare)
    }));
    const itemCount = taskContent.length + taskContent.reduce((sum, task) => sum + task.checklist.length, 0) + factContent.length + skillContent.length + fileContents.length;
    if (itemCount > limits.maxItems) throw limitError();

    const visitorProjection = {
      project: { name: project.name, objective: project.objective },
      tasks: taskContent,
      facts: factContent,
      skills: skillContent,
      files: fileContents.map(({ name, mediaType, byteLength, sha256 }) => ({ name, mediaType, byteLength, sha256 }))
    };
    const snapshotBytes = Buffer.byteLength(canonicalJson(visitorProjection), 'utf8') + fileContents.reduce((sum, file) => sum + file.byteLength, 0);
    if (snapshotBytes > limits.maxSnapshotBytes) throw limitError();
    const sourceRevision = digest({
      project: { id: project.id, version: project.version },
      tasks: orderedTasks.map((task) => ({ id: task.id, version: task.version })),
      facts: orderedFacts.map((fact) => ({ id: fact.id, version: fact.version })),
      skills: orderedSkills.map((skill) => ({ id: skill.id, revisionId: skill.revisionId, version: skill.version })),
      files: fileContents.map(({ name, byteLength, sha256 }) => ({ name, byteLength, sha256 }))
    });
    const previewDigest = digest(visitorProjection);
    return {
      ...visitorProjection,
      files: fileContents.map(({ name, mediaType, byteLength, sha256, bytes }) => ({ name, mediaType, byteLength, sha256, contentBase64: bytes.toString('base64') })),
      previewDigest,
      sourceRevision,
      totals: { itemCount, fileCount: fileContents.length, snapshotBytes },
      exclusions: ['Source owner/resource IDs, policies, provider configuration, technical SKILL.md files, conversations, and assistant runs are not included.']
    };
  }

  private requireLimits(): ShowcaseLimits {
    if (!this.limits) throw unavailable();
    return this.limits;
  }
}

export class PublishShowcaseUseCase {
  public constructor(
    private readonly buildPreview: BuildShowcasePreviewUseCase,
    private readonly repository: IShowcaseRepository,
    private readonly limits: ShowcaseLimits | undefined,
    private readonly createId: () => string = randomUUID
  ) {}

  public async execute(input: {
    readonly adminId: string;
    readonly request: ShowcaseSourceRequest;
    readonly previewDigest: string;
    readonly sourceRevision: string;
    readonly idempotencyKey: string;
  }): Promise<ShowcasePublishOutcome> {
    if (!this.limits) throw unavailable();
    const normalizedRequest = normalizeSourceRequest(input.request);
    const idempotencyDigest = digest(input.idempotencyKey);
    const requestFingerprint = digest({
      request: normalizedRequest,
      previewDigest: input.previewDigest,
      sourceRevision: input.sourceRevision
    });
    const replay = await this.repository.findPublishedReplay(input.adminId, idempotencyDigest, requestFingerprint);
    if (replay) return { published: replay, statusCode: 200 };
    const preview = await this.buildPreview.execute(input.adminId, input.request);
    if (preview.previewDigest !== input.previewDigest || preview.sourceRevision !== input.sourceRevision) {
      throw new AppError('SHOWCASE_PREVIEW_STALE', 409, 'The selected source changed. Create a new preview.');
    }
    const files = preview.files.map((file) => {
      const bytes = Buffer.from(file.contentBase64, 'base64');
      return { id: this.createId(), name: file.name, mediaType: file.mediaType, byteLength: file.byteLength, sha256: file.sha256, bytes };
    });
    const currentTasks: CurrentShowcaseDto['tasks'] = preview.tasks.map((task) => ({
      ...task,
      id: this.createId(),
      checklist: task.checklist.map((item) => ({ ...item, id: this.createId() }))
    }));
    const currentFacts: CurrentShowcaseDto['facts'] = preview.facts.map((fact) => ({ ...fact, id: this.createId() }));
    const currentSkills: CurrentShowcaseDto['skills'] = preview.skills.map((skill) => ({ ...skill, id: this.createId() }));
    const projection = { project: preview.project, tasks: currentTasks, facts: currentFacts, skills: currentSkills, files: files.map(({ id, name, mediaType, byteLength }) => ({ id, name, mediaType, byteLength })) };
    const contentDigest = digest(projection);
    const published = await this.repository.publish({
      adminId: input.adminId,
      idempotencyDigest,
      requestFingerprint,
      snapshot: { ...projection, files: files.map(({ id, name, mediaType, byteLength, sha256, bytes }) => ({ id, name, mediaType, byteLength, sha256, bytes })) },
      contentDigest,
      snapshotBytes: preview.totals.snapshotBytes,
      itemCount: preview.totals.itemCount,
      maxRetainedVersions: this.limits.maxRetainedVersions
    });
    return {
      published: { version: published.version, publishedAt: published.publishedAt },
      statusCode: published.replayed ? 200 : 201
    };
  }
}

function toTaskContent(task: ProjectTask): ShowcaseTaskContent {
  return {
    title: task.title,
    details: task.details,
    status: task.status,
    importance: task.importance,
    deadline: task.deadline,
    checklist: task.subtasks.map((subtask) => ({ title: subtask.title, completed: subtask.completed }))
  };
}

function normalizeSourceRequest(request: ShowcaseSourceRequest): ShowcaseSourceRequest {
  const normalizedPaths = request.selection.filePaths.map((value) => {
    try { return WorkspaceRelativePath.parse(value, { field: 'selection.filePaths' }).value; }
    catch { throw validationError(); }
  });
  if (new Set(request.selection.taskIds).size !== request.selection.taskIds.length
    || new Set(request.selection.factIds).size !== request.selection.factIds.length
    || new Set(request.selection.skillIds ?? []).size !== (request.selection.skillIds ?? []).length
    || new Set(normalizedPaths).size !== normalizedPaths.length) throw validationError();
  return {
    projectId: request.projectId,
    selection: {
      taskIds: [...request.selection.taskIds].sort(compare),
      factIds: [...request.selection.factIds].sort(compare),
      filePaths: normalizedPaths.sort(compare),
      skillIds: [...(request.selection.skillIds ?? [])].sort(compare)
    }
  };
}

function selectAll<T extends { readonly id: string }>(source: readonly T[], ids: readonly string[]): readonly T[] {
  if (new Set(ids).size !== ids.length) throw validationError();
  const byId = new Map(source.map((item) => [item.id, item]));
  const selected = ids.map((id) => byId.get(id));
  if (selected.some((item) => !item)) throw notFound('SHOWCASE_SOURCE_NOT_FOUND');
  return selected as readonly T[];
}

function safeMediaType(path: string): string {
  switch (extname(path).toLocaleLowerCase('en-US')) {
    case '.md': case '.txt': return 'text/plain';
    case '.csv': return 'text/csv';
    case '.pdf': return 'application/pdf';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    default: return 'application/octet-stream';
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compare(left, right)).map(([key, item]) => [key, sortValue(item)]));
}

function digest(value: unknown): string {
  const canonical = typeof value === 'string' ? value : canonicalJson(value);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function validationError(): AppError { return new AppError('VALIDATION_ERROR', 400, 'The showcase selection is invalid.'); }
function notFound(code: string): AppError { return new AppError(code, 404, 'The selected source is unavailable.'); }
function limitError(): AppError { return new AppError('SHOWCASE_LIMIT_EXCEEDED', 413, 'The showcase selection exceeds configured limits.'); }
function unavailable(): AppError { return new AppError('SHOWCASE_PUBLICATION_UNAVAILABLE', 503, 'Showcase publication is temporarily unavailable.'); }
