import { HermesProjectTaskTools } from '@/infrastructure/hermes/hermes-project-task-tools';
import type { AiRun, EgressManifest } from '@/modules/ai-runs/domain/ai-run-types';
import type { IAiRunRepository } from '@/modules/ai-runs/repositories/ai-run-repository';
import type { RuntimeRunInput } from '@/modules/ai-runs/repositories/agent-runtime';
import type { CreateProjectTaskUseCase, ListProjectTasksUseCase, UpdateProjectTaskUseCase } from '@/modules/tasks/use-cases/project-task-use-cases';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';

function testManifest(): EgressManifest {
  return {
    manifestHash: 'a'.repeat(64), provider: 'NVIDIA hosted NIM', providerProfile: 'test', model: 'test',
    categories: [], files: [], requestBytes: 0, messageBytes: 0, messageCount: 0,
    messageHash: 'b'.repeat(64), byteEstimate: 0, tokenEstimate: 0, excludedItemCount: 0,
    omittedItemCount: 0, omissionSummary: 'none', bestEffortSecretDetection: true
  };
}

function persistedRun(overrides: Partial<AiRun> = {}): AiRun {
  const now = new Date('2026-10-19T00:00:00.000Z');
  return {
    id: RUN_ID, ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID,
    request: 'Review the current project tasks.', relativeRoot: `projects/${PROJECT_ID}`, storageKind: 'managed',
    requestedPaths: [], manifest: testManifest(), manifestInvalidated: false, status: 'running', phase: 'inference',
    decision: 'approved', cleanup: 'not_started', providerTransmission: 'not_started_confirmed', stagingItemCount: 0,
    sandboxReady: true, safeMessage: 'Assistant is working.', createdAt: now, updatedAt: now, ...overrides
  };
}

function runtimeInput(run: AiRun): RuntimeRunInput {
  return {
    runId: run.id, ownerId: run.ownerId, projectId: run.projectId, conversationId: run.conversationId,
    storageKind: run.storageKind, relativeRoot: run.relativeRoot, request: run.request, manifest: run.manifest
  };
}

function makeTools(options: { readonly run?: AiRun | null; readonly assertActive?: (principalId: string) => Promise<void> }) {
  const foundRun = options.run === undefined ? persistedRun() : options.run;
  const runs = { findByIdForOwner: jest.fn().mockResolvedValue(foundRun) } as unknown as IAiRunRepository;
  const list = { execute: jest.fn().mockResolvedValue({ tasks: [{ id: 'task-1', title: 'Review notes', status: 'todo', version: 1 }] }) } as unknown as ListProjectTasksUseCase;
  const create = { execute: jest.fn().mockResolvedValue({ task: { id: 'task-2', title: 'New task', status: 'todo', version: 1 } }) } as unknown as CreateProjectTaskUseCase;
  const update = { execute: jest.fn() } as unknown as UpdateProjectTaskUseCase;
  const tools = new HermesProjectTaskTools({
    runs, list, create, update,
    principalAuthorization: { assertActive: jest.fn(async (principalId: string) => options.assertActive?.(principalId)) }
  });
  return { tools, runs, list, create, update };
}

describe('HermesProjectTaskTools persisted scope and principal boundary', () => {
  it('holds the persisted owner authority while reading tasks from the persisted project', async () => {
    const run = persistedRun();
    const { tools, runs, list } = makeTools({ run });

    const result = await tools.execute({ run: runtimeInput(run), requestId: 'request-1', name: 'project_tasks_list', args: {} });

    expect(result).toMatchObject({ tasks: [{ id: 'task-1' }], hasMore: false });
    expect(runs.findByIdForOwner).toHaveBeenCalledWith(OWNER_ID, RUN_ID);
    expect(list.execute).toHaveBeenCalledWith({ ownerId: OWNER_ID, projectId: PROJECT_ID, filter: 'all' });
  });

  it('denies a persisted run after account authority is revoked and performs no task query', async () => {
    const run = persistedRun();
    const { tools, list, create } = makeTools({
      run,
      assertActive: async () => { throw new Error('principal disabled'); }
    });

    const result = await tools.execute({ run: runtimeInput(run), requestId: 'request-2', name: 'project_tasks_list', args: {} });

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(list.execute).not.toHaveBeenCalled();
    expect(create.execute).not.toHaveBeenCalled();
  });

  it('rejects a caller project that differs from the persisted run before any task access', async () => {
    const run = persistedRun();
    const { tools, runs, list } = makeTools({ run });

    const result = await tools.execute({
      run: { ...runtimeInput(run), projectId: '55555555-5555-4555-8555-555555555555' },
      requestId: 'request-3', name: 'project_tasks_list', args: {}
    });

    expect(result).toMatchObject({ code: 'TASK_RUN_NOT_ACTIVE' });
    expect(runs.findByIdForOwner).toHaveBeenCalledWith(OWNER_ID, RUN_ID);
    expect(list.execute).not.toHaveBeenCalled();
  });

  it('uses only the persisted scope for assistant task creation', async () => {
    const run = persistedRun();
    const { tools, create } = makeTools({ run });

    await tools.execute({ run: runtimeInput(run), requestId: 'request-4', name: 'project_task_create', args: { title: 'New task' } });

    expect(create.execute).toHaveBeenCalledWith({
      ownerId: OWNER_ID, projectId: PROJECT_ID, title: 'New task',
      idempotencyKey: `hermes:${RUN_ID}:request-4`, actorKind: 'assistant'
    });
  });
});
