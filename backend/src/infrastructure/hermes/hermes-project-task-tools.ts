import { z } from 'zod';

import type { RuntimeRunInput } from '@/modules/ai-runs/repositories/agent-runtime';
import type { IAiRunRepository } from '@/modules/ai-runs/repositories/ai-run-repository';
import type { CreateProjectTaskUseCase, ListProjectTasksUseCase, UpdateProjectTaskUseCase } from '@/modules/tasks/use-cases/project-task-use-cases';
import type { IPrincipalAuthorization } from '@/modules/auth/use-cases/principal-authorization';
import { ProjectTaskDomainError } from '@/modules/tasks/domain/project-task-errors';
import { AppError } from '@/shared/errors/app-error';
import { redactEgressText } from '@/shared/egress/redaction';

const createSchema = z.object({ title: z.string(), details: z.string().nullable().optional() }).strict();
const statusSchema = z.object({ taskId: z.string().uuid(), expectedVersion: z.number().int().positive(), status: z.enum(['todo', 'in_progress', 'blocked', 'done']) }).strict();

interface TaskToolDependencies {
  readonly runs: IAiRunRepository;
  readonly principalAuthorization: Pick<IPrincipalAuthorization, 'assertActive'>;
  readonly list: ListProjectTasksUseCase;
  readonly create: CreateProjectTaskUseCase;
  readonly update: UpdateProjectTaskUseCase;
}

/** Executes model task tools through the same owned, versioned use cases as the UI. */
export class HermesProjectTaskTools {
  public constructor(private readonly dependencies: TaskToolDependencies) {}

  public async execute(input: { readonly run: RuntimeRunInput; readonly requestId: string; readonly name: unknown; readonly args: unknown }): Promise<Record<string, unknown>> {
    try {
      if (!input.run.ownerId || !input.run.projectId) throw new AppError('TASK_RUN_SCOPE_INVALID', 409, 'No owned project is available for this run.');
      await this.dependencies.principalAuthorization.assertActive(input.run.ownerId);
      const scope = await this.scope(input.run);
      if (input.name === 'project_tasks_list') {
        z.object({}).strict().parse(input.args);
        const list = await this.dependencies.list.execute({ ...scope, filter: 'all' });
        await this.dependencies.principalAuthorization.assertActive(input.run.ownerId);
        return { tasks: list.tasks.slice(0, 100).map((task) => ({ id: task.id, title: redactEgressText(task.title), status: task.status, version: task.version })), hasMore: list.tasks.length > 100 };
      }
      return await this.mutate({ ...input, scope });
    } catch (error: unknown) {
      if (error instanceof z.ZodError) return { error: 'Invalid task tool arguments. Use the tool schema.' };
      if ((error instanceof AppError || error instanceof ProjectTaskDomainError) && error.statusCode < 500) return { error: error.message, code: error.code, details: error.details };
      return { error: 'The task operation could not be confirmed. Read the saved tasks before retrying; do not claim it succeeded.' };
    }
  }

  private async scope(run: RuntimeRunInput): Promise<{ readonly ownerId: string; readonly projectId: string }> {
    if (!run.ownerId || !run.projectId) throw new AppError('TASK_RUN_SCOPE_INVALID', 409, 'No owned project is available for this run.');
    const current = await this.dependencies.runs.findByIdForOwner(run.ownerId, run.runId);
    if (!current || current.projectId !== run.projectId || current.decision !== 'approved' || current.status !== 'running') {
      throw new AppError('TASK_RUN_NOT_ACTIVE', 409, 'This run is no longer active. No task change was made.');
    }
    return { ownerId: run.ownerId, projectId: run.projectId };
  }

  private async mutate(input: { readonly run: RuntimeRunInput; readonly requestId: string; readonly name: unknown; readonly args: unknown; readonly scope: { readonly ownerId: string; readonly projectId: string } }): Promise<Record<string, unknown>> {
    if (input.name === 'project_task_create') {
      const draft = createSchema.parse(input.args);
      const result = await this.dependencies.create.execute({ ...input.scope, ...draft, idempotencyKey: `hermes:${input.run.runId}:${input.requestId}`, actorKind: 'assistant' });
      return { saved: true, task: { id: result.task.id, title: redactEgressText(result.task.title), status: result.task.status, version: result.task.version } };
    }
    if (input.name === 'project_task_set_status') {
      const change = statusSchema.parse(input.args);
      const result = await this.dependencies.update.execute({
        ...input.scope,
        ...change,
        operationKey: `hermes:${input.run.runId}:${input.requestId}`,
        actorKind: 'assistant'
      });
      return { saved: true, task: { id: result.task.id, title: redactEgressText(result.task.title), status: result.task.status, version: result.task.version } };
    }
    return { error: 'This project task tool is not supported.' };
  }
}
