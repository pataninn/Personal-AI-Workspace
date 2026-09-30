import type { IProposedChangeSetRepository } from '@/modules/ai-runs/repositories/change-set-repository';
import type { ProjectFileHistoryRecord } from '@/modules/ai-runs/domain/file-history-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import { ListProjectFileHistoryUseCase } from '@/modules/ai-runs/use-cases/file-history-use-cases';
import { redactSensitiveText } from '@/infrastructure/workspace/workspace-text';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const CHANGE_SET_ID = '33333333-3333-4333-8333-333333333333';
const DATE = new Date('2026-09-30T00:00:00.000Z');

function record(summary: string): ProjectFileHistoryRecord {
  return {
    changeSetId: CHANGE_SET_ID, projectId: PROJECT_ID, runId: '44444444-4444-4444-8444-444444444444', conversationId: null,
    operationId: '55555555-5555-4555-8555-555555555555', operationIndex: 0, operation: 'edit', matchedPath: 'src/file.ts',
    path: 'src/file.ts', summary, changeSetStatus: 'applied', operationStatus: 'applied', backupStatus: 'not_required', createdAt: DATE, updatedAt: DATE
  };
}

describe('ListProjectFileHistoryUseCase', () => {
  it('allows archived history, bounds and redacts summaries, and binds cursors to path and filter', async () => {
    const list = jest.fn(async () => ({ records: [record('password=secret-value')], hasMore: true }));
    const projectRepository = { findByIdForOwner: jest.fn(async () => ({ id: PROJECT_ID, status: 'archived' })) } as unknown as IProjectRepository;
    const useCase = new ListProjectFileHistoryUseCase(projectRepository, { listFileHistoryForProjectOwner: list } as unknown as IProposedChangeSetRepository);

    const page = await useCase.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, path: 'src/file.ts', outcome: 'applied' });

    expect(projectRepository.findByIdForOwner).toHaveBeenCalledWith(OWNER_ID, PROJECT_ID);
    expect(list).toHaveBeenCalledWith({ ownerId: OWNER_ID, projectId: PROJECT_ID, path: 'src/file.ts', outcome: 'applied', limit: 20 });
    expect(page.items[0]?.summary).toBe(redactSensitiveText('password=secret-value'));
    expect(page.items[0]?.summary).not.toContain('secret-value');
    const cursor = JSON.parse(Buffer.from(page.nextCursor ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(cursor).toMatchObject({ path: 'src/file.ts', outcome: 'applied', operationIndex: 0 });
  });

  it('rejects traversal paths, out of range limits, and cursors from another path', async () => {
    const listFileHistoryForProjectOwner = jest.fn();
    const useCase = new ListProjectFileHistoryUseCase(
      { findByIdForOwner: async () => ({ id: PROJECT_ID, status: 'active' }) } as unknown as IProjectRepository,
      { listFileHistoryForProjectOwner } as unknown as IProposedChangeSetRepository
    );
    await expect(useCase.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, path: '../secrets.txt' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(useCase.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, path: '.npmrc' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(useCase.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, path: 'src/database-passwords.txt' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(useCase.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, path: 'src/file.ts', limit: '51' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const cursor = Buffer.from(JSON.stringify({ createdAt: DATE.toISOString(), changeSetId: CHANGE_SET_ID, operationIndex: 0, path: 'src/other.ts', outcome: 'all' })).toString('base64url');
    await expect(useCase.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, path: 'src/file.ts', cursor })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(listFileHistoryForProjectOwner).not.toHaveBeenCalled();
  });
});
