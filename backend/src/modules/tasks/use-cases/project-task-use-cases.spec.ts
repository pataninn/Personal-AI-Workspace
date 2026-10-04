import { ProjectNotFoundError } from '@/modules/projects/domain/project-errors';
import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import {
  ProjectTaskArchivedProjectError,
  ProjectTaskIdempotencyKeyError,
  ProjectTaskStatusConflictError,
  ProjectTaskValidationError
} from '@/modules/tasks/domain/project-task-errors';
import type { IProjectTaskRepository } from '@/modules/tasks/repositories/project-task-repository';
import {
  CreateProjectTaskUseCase,
  DeleteProjectTaskUseCase,
  ListProjectTaskSuggestionsUseCase,
  ListProjectTasksUseCase,
  ReorderProjectTaskUseCase,
  ResolveProjectTaskSuggestionUseCase,
  UpdateProjectTaskUseCase
} from '@/modules/tasks/use-cases/project-task-use-cases';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_PROJECT_ID = '44444444-4444-4444-8444-444444444444';
const TASK_ID = '55555555-5555-4555-8555-555555555555';
const SUGGESTION_ID = '66666666-6666-4666-8666-666666666666';
const CONVERSATION_ID = '77777777-7777-4777-8777-777777777777';

function dependencies(projectStatus: 'active' | 'archived' | null = 'active') {
  const findByIdForOwner = jest.fn().mockResolvedValue(
    projectStatus === null ? null : ({ status: projectStatus } as Project)
  );
  const projectRepository = { findByIdForOwner } as unknown as IProjectRepository;

  const taskRepository = {
    listTasks: jest.fn().mockResolvedValue({ tasks: [], orderVersion: 1 }),
    createTask: jest.fn().mockResolvedValue({}),
    updateTask: jest.fn().mockResolvedValue({}),
    deleteTask: jest.fn().mockResolvedValue({ orderVersion: 2 }),
    reorderTask: jest.fn().mockResolvedValue({ tasks: [], orderVersion: 1 }),
    listSuggestions: jest.fn().mockResolvedValue([]),
    resolveSuggestion: jest.fn().mockResolvedValue({})
  };

  return {
    findByIdForOwner,
    projectRepository,
    taskRepository,
    taskRepositoryContract: taskRepository as unknown as IProjectTaskRepository
  };
}

describe('project task use cases', () => {
  describe('CreateProjectTaskUseCase', () => {
    it('defaults to Medium importance with no deadline or checklist', async () => {
      const deps = dependencies();
      const useCase = new CreateProjectTaskUseCase(deps.projectRepository, deps.taskRepositoryContract);
      await useCase.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, title: 'Task', idempotencyKey: 'default' });
      expect(deps.taskRepository.createTask).toHaveBeenCalledWith(expect.objectContaining({ importance: 'medium', deadline: null, subtasks: [] }));
    });
    it('keeps create fingerprints stable when retries generate new checklist ids', async () => {
      const deps = dependencies();
      const useCase = new CreateProjectTaskUseCase(deps.projectRepository, deps.taskRepositoryContract);
      const input = { ownerId: OWNER_ID, projectId: PROJECT_ID, title: 'Task', idempotencyKey: 'retry', importance: 'urgent', deadline: '2026-10-05', subtasks: [{ title: 'First' }] };
      await useCase.execute(input);
      await useCase.execute(input);
      const first = deps.taskRepository.createTask.mock.calls[0]?.[0];
      const second = deps.taskRepository.createTask.mock.calls[1]?.[0];
      expect(first.requestFingerprint).toBe(second.requestFingerprint);
      expect(first.subtasks[0].id).not.toBe(second.subtasks[0].id);
      expect(first).toMatchObject({ importance: 'urgent', deadline: '2026-10-05' });
    });

    it('includes scheduling and checklist changes in the idempotency fingerprint', async () => {
      const deps = dependencies();
      const useCase = new CreateProjectTaskUseCase(deps.projectRepository, deps.taskRepositoryContract);
      const input = { ownerId: OWNER_ID, projectId: PROJECT_ID, title: 'Task', idempotencyKey: 'retry', importance: 'medium' };
      await useCase.execute(input);
      await useCase.execute({ ...input, importance: 'urgent' });
      expect(deps.taskRepository.createTask.mock.calls[0]?.[0].requestFingerprint).not.toBe(deps.taskRepository.createTask.mock.calls[1]?.[0].requestFingerprint);
    });
    it('should normalize task text and keep the owner and project scope on creation', async () => {
      const deps = dependencies();
      const useCase = new CreateProjectTaskUseCase(deps.projectRepository, deps.taskRepositoryContract);

      await useCase.execute({
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        title: '  Review setup notes  ',
        details: '  Document the startup steps.  ',
        idempotencyKey: ' create-key '
      });

      expect(deps.findByIdForOwner).toHaveBeenCalledWith(OWNER_ID, PROJECT_ID);
      expect(deps.taskRepository.createTask).toHaveBeenCalledWith(expect.objectContaining({
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        title: 'Review setup notes',
        details: 'Document the startup steps.',
        idempotencyKey: 'create-key',
        requestFingerprint: expect.any(String)
      }));
    });

    it('should reject an invalid idempotency key without writing a task', async () => {
      const deps = dependencies();
      const useCase = new CreateProjectTaskUseCase(deps.projectRepository, deps.taskRepositoryContract);

      await expect(useCase.execute({
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        title: 'Review setup notes',
        idempotencyKey: 'not a valid key'
      })).rejects.toBeInstanceOf(ProjectTaskIdempotencyKeyError);
      expect(deps.taskRepository.createTask).not.toHaveBeenCalled();
    });

    it('should report a missing project before attempting creation', async () => {
      const deps = dependencies(null);
      const useCase = new CreateProjectTaskUseCase(deps.projectRepository, deps.taskRepositoryContract);

      await expect(useCase.execute({
        ownerId: OTHER_OWNER_ID,
        projectId: OTHER_PROJECT_ID,
        title: 'Review setup notes',
        idempotencyKey: 'create-key'
      })).rejects.toBeInstanceOf(ProjectNotFoundError);
      expect(deps.findByIdForOwner).toHaveBeenCalledWith(OTHER_OWNER_ID, OTHER_PROJECT_ID);
      expect(deps.taskRepository.createTask).not.toHaveBeenCalled();
    });
  });

  describe('UpdateProjectTaskUseCase', () => {
    it('rejects archive mutations while supporting checklist planning updates', async () => {
      const deps = dependencies();
      const useCase = new UpdateProjectTaskUseCase(deps.projectRepository, deps.taskRepositoryContract);
      const input = { ownerId: OWNER_ID, projectId: PROJECT_ID, taskId: TASK_ID, expectedVersion: 1 };
      await expect(useCase.execute({ ...input, status: 'archived' })).rejects.toBeInstanceOf(ProjectTaskStatusConflictError);
      await useCase.execute({ ...input, deadline: null, importance: 'high', subtasks: [{ title: ' Review ', completed: true }] });
      expect(deps.taskRepository.updateTask).toHaveBeenCalledWith(expect.objectContaining({
        ...input, text: { deadline: null, importance: 'high', subtasks: [{ id: expect.any(String), title: 'Review', completed: true }] }
      }));
    });
    it('should pass owner, project, task, and version together to the repository', async () => {
      const deps = dependencies();
      const useCase = new UpdateProjectTaskUseCase(deps.projectRepository, deps.taskRepositoryContract);

      await useCase.execute({
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        expectedVersion: 4,
        status: 'done'
      });

      expect(deps.findByIdForOwner).toHaveBeenCalledWith(OWNER_ID, PROJECT_ID);
      expect(deps.taskRepository.updateTask).toHaveBeenCalledWith({
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        expectedVersion: 4,
        status: 'done'
      });
    });

    it('should reject an update that mixes a status transition with text edits', async () => {
      const deps = dependencies();
      const useCase = new UpdateProjectTaskUseCase(deps.projectRepository, deps.taskRepositoryContract);

      await expect(useCase.execute({
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        expectedVersion: 1,
        status: 'done',
        title: 'Changed title'
      })).rejects.toBeInstanceOf(ProjectTaskStatusConflictError);
      expect(deps.taskRepository.updateTask).not.toHaveBeenCalled();
    });

    it('should reject unsupported status values before reaching the repository', async () => {
      const deps = dependencies();
      const useCase = new UpdateProjectTaskUseCase(deps.projectRepository, deps.taskRepositoryContract);

      await expect(useCase.execute({
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        expectedVersion: 1,
        status: 'deleted'
      })).rejects.toBeInstanceOf(ProjectTaskStatusConflictError);
      expect(deps.taskRepository.updateTask).not.toHaveBeenCalled();
    });
  });

  describe('DeleteProjectTaskUseCase', () => {
    it('preserves owner/project/task scope and expected version on deletion', async () => {
      const deps = dependencies();
      const useCase = new DeleteProjectTaskUseCase(deps.projectRepository, deps.taskRepositoryContract);
      const input = { ownerId: OWNER_ID, projectId: PROJECT_ID, taskId: TASK_ID, expectedVersion: 4 };
      await expect(useCase.execute(input)).resolves.toEqual({ orderVersion: 2 });
      expect(deps.taskRepository.deleteTask).toHaveBeenCalledWith(input);
    });
  });

  describe('project read-only boundary', () => {
    it('should allow task and suggestion reads in an archived project', async () => {
      const deps = dependencies('archived');
      const listTasks = new ListProjectTasksUseCase(deps.projectRepository, deps.taskRepositoryContract);
      const listSuggestions = new ListProjectTaskSuggestionsUseCase(deps.projectRepository, deps.taskRepositoryContract);

      await listTasks.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, filter: 'archived' });
      await listSuggestions.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, status: 'pending' });

      expect(deps.taskRepository.listTasks).toHaveBeenCalledWith(OWNER_ID, PROJECT_ID, 'archived');
      expect(deps.taskRepository.listSuggestions).toHaveBeenCalledWith(OWNER_ID, PROJECT_ID, { status: 'pending' });
    });

    it.each([
      ['create', async (deps: ReturnType<typeof dependencies>) => new CreateProjectTaskUseCase(deps.projectRepository, deps.taskRepositoryContract).execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, title: 'Review setup notes', idempotencyKey: 'create-key' })],
      ['edit', async (deps: ReturnType<typeof dependencies>) => new UpdateProjectTaskUseCase(deps.projectRepository, deps.taskRepositoryContract).execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, taskId: TASK_ID, expectedVersion: 1, title: 'Review setup notes' })],
      ['reorder', async (deps: ReturnType<typeof dependencies>) => new ReorderProjectTaskUseCase(deps.projectRepository, deps.taskRepositoryContract).execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, taskId: TASK_ID, direction: 'up', expectedOrderVersion: 1 })],
      ['resolve a suggestion', async (deps: ReturnType<typeof dependencies>) => new ResolveProjectTaskSuggestionUseCase(deps.projectRepository, deps.taskRepositoryContract).execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, suggestionId: SUGGESTION_ID, expectedVersion: 1, status: 'dismissed' })]
    ] as const)('should reject %s in an archived project without writing', async (_operation, execute) => {
      const deps = dependencies('archived');

      await expect(execute(deps)).rejects.toBeInstanceOf(ProjectTaskArchivedProjectError);
      expect(deps.taskRepository.createTask).not.toHaveBeenCalled();
      expect(deps.taskRepository.updateTask).not.toHaveBeenCalled();
      expect(deps.taskRepository.reorderTask).not.toHaveBeenCalled();
      expect(deps.taskRepository.resolveSuggestion).not.toHaveBeenCalled();
    });
  });

  describe('ListProjectTaskSuggestionsUseCase', () => {
    it('should require a conversation filter when listing resolved suggestions', async () => {
      const deps = dependencies();
      const useCase = new ListProjectTaskSuggestionsUseCase(deps.projectRepository, deps.taskRepositoryContract);

      await expect(useCase.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, status: 'all' }))
        .rejects.toBeInstanceOf(ProjectTaskValidationError);
      expect(deps.taskRepository.listSuggestions).not.toHaveBeenCalled();
    });

    it('should scope resolved suggestions to the requested owner, project, and conversation', async () => {
      const deps = dependencies();
      const useCase = new ListProjectTaskSuggestionsUseCase(deps.projectRepository, deps.taskRepositoryContract);

      await useCase.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, status: 'all', conversationId: CONVERSATION_ID });

      expect(deps.findByIdForOwner).toHaveBeenCalledWith(OWNER_ID, PROJECT_ID);
      expect(deps.taskRepository.listSuggestions).toHaveBeenCalledWith(OWNER_ID, PROJECT_ID, {
        status: 'all',
        conversationId: CONVERSATION_ID
      });
    });
  });

  describe('ResolveProjectTaskSuggestionUseCase', () => {
    it('should accept edited text while passing the owner, project, suggestion, and version together', async () => {
      const deps = dependencies();
      const useCase = new ResolveProjectTaskSuggestionUseCase(deps.projectRepository, deps.taskRepositoryContract);

      await useCase.execute({
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        suggestionId: SUGGESTION_ID,
        expectedVersion: 3,
        status: 'accepted',
        title: '  Updated notes  ',
        details: null
      });

      expect(deps.findByIdForOwner).toHaveBeenCalledWith(OWNER_ID, PROJECT_ID);
      expect(deps.taskRepository.resolveSuggestion).toHaveBeenCalledWith({
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        suggestionId: SUGGESTION_ID,
        expectedVersion: 3,
        decision: 'accepted',
        title: 'Updated notes',
        details: null
      });
    });

    it('should resolve a dismissal without accepting proposal edits', async () => {
      const deps = dependencies();
      const useCase = new ResolveProjectTaskSuggestionUseCase(deps.projectRepository, deps.taskRepositoryContract);

      await useCase.execute({
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        suggestionId: SUGGESTION_ID,
        expectedVersion: 2,
        status: 'dismissed',
        title: 'Ignored edit'
      });

      expect(deps.taskRepository.resolveSuggestion).toHaveBeenCalledWith({
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        suggestionId: SUGGESTION_ID,
        expectedVersion: 2,
        decision: 'dismissed'
      });
    });
  });
});
