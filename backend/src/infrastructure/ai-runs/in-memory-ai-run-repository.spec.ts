import type { CreateAiRunRecord } from '@/modules/ai-runs/domain/ai-run-types';
import { RecoverInterruptedAiRunsUseCase } from '@/modules/ai-runs/use-cases/recover-interrupted-ai-runs-use-case';
import { InMemoryAiRunRepository } from '@/infrastructure/ai-runs/in-memory-ai-run-repository';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';

function createRecord(idempotencyKey: string): CreateAiRunRecord {
  return {
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    conversationId: CONVERSATION_ID,
    request: 'Review the project.',
    relativeRoot: '',
    requestedPaths: [],
    manifest: {
      manifestHash: 'a'.repeat(64),
      provider: 'NVIDIA hosted NIM',
      providerProfile: 'nvidia-hosted-nim',
      model: 'nvidia/nemotron-3-super-120b-a12b',
      categories: ['Request'],
      files: [],
      requestBytes: 21,
      messageBytes: 0,
      messageCount: 0,
      messageHash: 'b'.repeat(64),
      byteEstimate: 21,
      tokenEstimate: 6,
      excludedItemCount: 0,
      omittedItemCount: 0,
      omissionSummary: 'No selected items were excluded or omitted.',
      bestEffortSecretDetection: true
    },
    idempotencyKey,
    requestFingerprint: 'c'.repeat(64)
  };
}

describe('InMemoryAiRunRepository startup recovery', () => {
  it('moves interrupted runs to manual review, preserves known transmission, and never resumes work', async () => {
    const repository = new InMemoryAiRunRepository();
    const notSent = (await repository.create(createRecord('not-sent'))).resource;
    const sent = (await repository.create(createRecord('sent'))).resource;
    const pending = (await repository.create(createRecord('pending'))).resource;
    await repository.save({ ...notSent, status: 'queued', phase: 'inference', decision: 'approved' });
    await repository.save({ ...sent, status: 'running', phase: 'inference', decision: 'approved', providerTransmission: 'transmitted_confirmed' });

    const recover = new RecoverInterruptedAiRunsUseCase(repository);
    await expect(recover.execute()).resolves.toBe(2);

    await expect(repository.findByIdForOwner(OWNER_ID, notSent.id)).resolves.toMatchObject({
      status: 'review_required',
      phase: 'review',
      cleanup: 'unknown',
      providerTransmission: 'not_started_confirmed',
      safeMessage: expect.stringContaining('no work was resumed automatically')
    });
    await expect(repository.findByIdForOwner(OWNER_ID, sent.id)).resolves.toMatchObject({
      status: 'review_required',
      cleanup: 'unknown',
      providerTransmission: 'transmitted_confirmed'
    });
    await expect(repository.findByIdForOwner(OWNER_ID, pending.id)).resolves.toMatchObject({ status: 'pending_approval' });
    await expect(recover.execute()).resolves.toBe(0);
  });
});
