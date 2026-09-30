import { InMemoryProposedChangeSetRepository } from '@/infrastructure/ai-runs/in-memory-change-set-repository';

describe('InMemoryProposedChangeSetRepository file history', () => {
  it('includes known applied operations from a partially applied stale set in the applied filter', async () => {
    const repository = new InMemoryProposedChangeSetRepository();
    const operation = {
      operationId: '55555555-5555-4555-8555-555555555555',
      operation: 'overwrite' as const,
      path: 'src/file.ts',
      summary: 'Update file',
      expectedSourceHash: 'a'.repeat(64),
      sourcePresent: true,
      destinationPresent: true,
      backupRequired: true,
      sizeBytes: 10,
      lineCount: 1,
      reviewable: true
    };
    const changeSet = await repository.create({
      ownerId: '11111111-1111-4111-8111-111111111111',
      projectId: '22222222-2222-4222-8222-222222222222',
      runId: '33333333-3333-4333-8333-333333333333',
      proposalHash: 'b'.repeat(64),
      operations: [operation],
      counts: { total: 1, creates: 0, edits: 0, overwrites: 1, renames: 0, deletes: 0, destructive: 1 },
      totalSizeBytes: 10,
      totalLineCount: 1,
      previewLimitBytes: 8192,
      previewLimitLines: 200,
      fakeRuntime: true
    });
    await repository.save({
      ...changeSet,
      status: 'stale',
      decision: 'approved',
      result: {
        persisted: true,
        operations: [{ ...operation, status: 'applied', backup: 'created', safeMessage: 'Applied.' }],
        appliedCount: 1,
        skippedCount: 0,
        failedCount: 0,
        backupCount: 1
      }
    });

    const page = await repository.listFileHistoryForProjectOwner({
      ownerId: changeSet.ownerId,
      projectId: changeSet.projectId,
      path: operation.path,
      outcome: 'applied',
      limit: 20
    });

    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({ changeSetStatus: 'stale', operationStatus: 'applied', backupStatus: 'created' });
  });
});
