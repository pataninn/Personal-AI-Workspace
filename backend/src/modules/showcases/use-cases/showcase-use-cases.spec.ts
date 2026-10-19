import { createHash } from 'node:crypto';

import type { Project } from '@/modules/projects/domain/project-types';
import type { ProjectTask } from '@/modules/tasks/domain/project-task';
import type { ProjectFact } from '@/modules/memory/domain/project-fact';
import type { Skill } from '@/modules/skills/domain/skill-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IProjectTaskRepository } from '@/modules/tasks/repositories/project-task-repository';
import type { IProjectFactRepository } from '@/modules/memory/repositories/project-fact-repository';
import type { ISkillRepository } from '@/modules/skills/repositories/skill-repository';
import type { IShowcaseRepository, ShowcaseLimits } from '@/modules/showcases/domain/showcase-types';
import { BuildShowcasePreviewUseCase, PublishShowcaseUseCase } from '@/modules/showcases/use-cases/showcase-use-cases';

const OWNER_ID = 'd3330000-0000-4000-8000-000000000001';
const PROJECT_ID = 'd3330000-0000-4000-8000-000000000010';
const TASK_ID = 'd3330000-0000-4000-8000-000000000020';
const FACT_ID = 'd3330000-0000-4000-8000-000000000030';
const SKILL_ID = 'd3330000-0000-4000-8000-000000000040';
const SKILL_REVISION_ID = 'd3330000-0000-4000-8000-000000000041';
const FILE_BYTES = Buffer.from('public notes\n', 'utf8');
const FILE_HASH = createHash('sha256').update(FILE_BYTES).digest('hex');
const limits: ShowcaseLimits = {
  maxSnapshotBytes: 100_000,
  maxFileBytes: 10_000,
  maxItems: 20,
  maxFiles: 5,
  maxRetainedVersions: 3,
  maxCopyAttempts: 2
};

const project: Project = {
  id: PROJECT_ID,
  ownerId: OWNER_ID,
  name: 'Reviewed project',
  slug: 'reviewed-project',
  relativeRoot: 'projects/source-project',
  storageKind: 'managed',
  objective: 'A public objective',
  status: 'active',
  version: 4,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-02T00:00:00.000Z')
};

const task: ProjectTask = {
  id: TASK_ID,
  projectId: PROJECT_ID,
  title: 'Ship the public flow',
  details: 'Only explicitly selected fields are projected.',
  status: 'in_progress',
  importance: 'high',
  deadline: '2026-11-01',
  subtasks: [{ id: 'd3330000-0000-4000-8000-000000000021', title: 'Review', completed: false }],
  position: 2,
  version: 7,
  source: {
    kind: 'assistant_suggestion',
    label: 'Added from an assistant suggestion · accepted by you',
    suggestionId: 'd3330000-0000-4000-8000-000000000022',
    runId: 'd3330000-0000-4000-8000-000000000023',
    conversationId: 'd3330000-0000-4000-8000-000000000024',
    acceptedAt: new Date('2026-10-02T00:00:00.000Z')
  },
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-02T00:00:00.000Z'),
  completedAt: null,
  archivedAt: null
};

const fact: ProjectFact = {
  id: FACT_ID,
  ownerId: OWNER_ID,
  projectId: PROJECT_ID,
  key: 'private-key-that-must-not-leak',
  title: 'Verified fact',
  content: 'Selected visitor-safe fact content.',
  source: { kind: 'user', label: 'Added by you', reference: null },
  version: 3,
  verifiedAt: new Date('2026-10-02T00:00:00.000Z'),
  verificationStatus: 'verified',
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-02T00:00:00.000Z')
};

const skill: Skill = {
  id: SKILL_ID,
  revisionId: SKILL_REVISION_ID,
  ownerId: OWNER_ID,
  workspaceId: PROJECT_ID,
  title: 'Plan my day',
  instructions: 'Review selected tasks and summarize their order.',
  declaredTools: ['home_task_read'],
  enabled: true,
  version: 3,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-02T00:00:00.000Z')
};

function buildPreview(skillLookup?: Pick<ISkillRepository, 'findActiveEnabledForShowcase'>) {
  const projects = { findByIdForOwner: jest.fn(async () => project) } as unknown as Pick<IProjectRepository, 'findByIdForOwner'>;
  const tasks = { listTasks: jest.fn(async () => ({ tasks: [task], orderVersion: 9 })) } as unknown as Pick<IProjectTaskRepository, 'listTasks'>;
  const facts = { findActiveByIds: jest.fn(async () => [fact]) } as unknown as Pick<IProjectFactRepository, 'findActiveByIds'>;
  const files = { download: jest.fn(async () => ({ bytes: FILE_BYTES, hash: FILE_HASH })) };
  return new BuildShowcasePreviewUseCase(projects, tasks, facts, files, limits, skillLookup);
}

const selection = {
  projectId: PROJECT_ID,
  selection: {
    taskIds: [TASK_ID],
    factIds: [FACT_ID],
    filePaths: ['notes/overview.txt']
  }
};

describe('showcase preview and publication', () => {
  it('projects only selected visitor fields and hashes a canonical, deterministic snapshot', async () => {
    const useCase = buildPreview();
    const preview = await useCase.execute(OWNER_ID, {
      ...selection,
      selection: {
        taskIds: [TASK_ID],
        factIds: [FACT_ID],
        filePaths: ['notes/overview.txt']
      }
    });

    expect(preview.project).toEqual({ name: 'Reviewed project', objective: 'A public objective' });
    expect(preview.tasks[0]).toEqual({
      title: task.title,
      details: task.details,
      status: task.status,
      importance: task.importance,
      deadline: task.deadline,
      checklist: [{ title: 'Review', completed: false }]
    });
    expect(preview.facts).toEqual([{ title: fact.title, content: fact.content }]);
    expect(preview.skills).toEqual([]);
    expect(preview.files).toEqual([{
      name: 'notes/overview.txt', mediaType: 'text/plain', byteLength: FILE_BYTES.length,
      sha256: FILE_HASH, contentBase64: FILE_BYTES.toString('base64')
    }]);
    expect(JSON.stringify(preview)).not.toContain(OWNER_ID);
    expect(JSON.stringify(preview)).not.toContain(PROJECT_ID);
    expect(JSON.stringify(preview)).not.toContain(FACT_ID);
    expect(JSON.stringify(preview)).not.toContain(TASK_ID);
    expect(JSON.stringify(preview)).not.toContain(fact.key);
    expect(JSON.stringify(preview)).not.toContain(task.source.runId!);
    expect(preview.totals).toMatchObject({ itemCount: 4, fileCount: 1, snapshotBytes: expect.any(Number) });

    const reordered = await useCase.execute(OWNER_ID, {
      projectId: PROJECT_ID,
      selection: { taskIds: [TASK_ID], factIds: [FACT_ID], filePaths: ['notes/overview.txt'] }
    });
    expect(reordered.previewDigest).toBe(preview.previewDigest);
    expect(reordered.sourceRevision).toBe(preview.sourceRevision);
  });

  it('publishes only the explicitly allowlisted enabled skill fields with generated public IDs', async () => {
    const skillLookup = {
      findActiveEnabledForShowcase: jest.fn(async () => [skill])
    } as unknown as Pick<ISkillRepository, 'findActiveEnabledForShowcase'>;
    const previewUseCase = buildPreview(skillLookup);
    const request = {
      ...selection,
      selection: { ...selection.selection, skillIds: [SKILL_ID] }
    };
    const preview = await previewUseCase.execute(OWNER_ID, request);

    expect(skillLookup.findActiveEnabledForShowcase).toHaveBeenCalledWith(OWNER_ID, PROJECT_ID, [SKILL_ID]);
    expect(preview.skills).toEqual([{
      title: skill.title,
      instructions: skill.instructions,
      declaredTools: ['home_task_read']
    }]);
    expect(JSON.stringify(preview)).not.toContain(SKILL_ID);
    expect(JSON.stringify(preview)).not.toContain(SKILL_REVISION_ID);
    expect(JSON.stringify(preview)).not.toContain(OWNER_ID);
    expect(JSON.stringify(preview)).not.toContain(PROJECT_ID);
    expect(preview.totals.itemCount).toBe(5);

    const repository = {
      findPublishedReplay: jest.fn(async () => null),
      publish: jest.fn(async () => ({ version: 'd3330000-0000-4000-8000-000000000090', publishedAt: '2026-10-19T12:00:00.000Z', replayed: false }))
    } as unknown as IShowcaseRepository;
    const publish = new PublishShowcaseUseCase(previewUseCase, repository, limits, () => 'd3330000-0000-4000-8000-000000000099');
    await publish.execute({
      adminId: OWNER_ID,
      request,
      previewDigest: preview.previewDigest,
      sourceRevision: preview.sourceRevision,
      idempotencyKey: 'publish-skill-key-1'
    });
    expect(repository.publish).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: expect.objectContaining({ skills: [{
        id: 'd3330000-0000-4000-8000-000000000099',
        title: skill.title,
        instructions: skill.instructions,
        declaredTools: ['home_task_read']
      }] })
    }));
  });

  it('does not silently drop selected skills before skill-repository wiring is available', async () => {
    const useCase = buildPreview();
    await expect(useCase.execute(OWNER_ID, {
      ...selection,
      selection: { ...selection.selection, skillIds: [SKILL_ID] }
    })).rejects.toMatchObject({ code: 'SHOWCASE_PUBLICATION_UNAVAILABLE', statusCode: 503 });
  });

  it('publishes only when the recomputed preview digest and source revision still match', async () => {
    const preview = buildPreview();
    const snapshot = await preview.execute(OWNER_ID, selection);
    const repository = {
      findPublishedReplay: jest.fn(async () => null),
      publish: jest.fn(async () => ({ version: 'd3330000-0000-4000-8000-000000000090', publishedAt: '2026-10-19T12:00:00.000Z', replayed: false }))
    } as unknown as IShowcaseRepository;
    let id = 100;
    const useCase = new PublishShowcaseUseCase(preview, repository, limits, () => `d3330000-0000-4000-8000-${String(id++).padStart(12, '0')}`);

    const result = await useCase.execute({
      adminId: OWNER_ID,
      request: selection,
      previewDigest: snapshot.previewDigest,
      sourceRevision: snapshot.sourceRevision,
      idempotencyKey: 'publish-key-1'
    });

    expect(result).toEqual({
      published: { version: 'd3330000-0000-4000-8000-000000000090', publishedAt: '2026-10-19T12:00:00.000Z' },
      statusCode: 201
    });
    expect(repository.publish).toHaveBeenCalledWith(expect.objectContaining({
      adminId: OWNER_ID,
      maxRetainedVersions: limits.maxRetainedVersions,
      snapshot: expect.objectContaining({
        tasks: [expect.objectContaining({ id: expect.any(String) })],
        facts: [expect.objectContaining({ id: expect.any(String) })],
        files: [expect.objectContaining({ id: expect.any(String), bytes: FILE_BYTES })]
      })
    }));
  });

  it('rejects a stale preview without mutating publication state', async () => {
    const preview = buildPreview();
    const repository = {
      findPublishedReplay: jest.fn(async () => null),
      publish: jest.fn()
    } as unknown as IShowcaseRepository;
    const useCase = new PublishShowcaseUseCase(preview, repository, limits);

    await expect(useCase.execute({
      adminId: OWNER_ID,
      request: selection,
      previewDigest: 'f'.repeat(64),
      sourceRevision: 'e'.repeat(64),
      idempotencyKey: 'publish-key-stale'
    })).rejects.toMatchObject({ code: 'SHOWCASE_PREVIEW_STALE', statusCode: 409 });
    expect(repository.publish).not.toHaveBeenCalled();
  });
});
