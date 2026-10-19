import type { HomeTurn } from '@/modules/home-assistant/domain/home-conversation-types';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';
import type { IHomePlanningRuntime } from '@/modules/home-assistant/repositories/home-planning-runtime';
import { CancelHomeTurnUseCase } from '@/modules/home-assistant/use-cases/cancel-home-turn';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const TURN_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-16T00:00:00.000Z');

const activeTurn: HomeTurn = {
  id: TURN_ID,
  ownerId: OWNER_ID,
  conversationId: CONVERSATION_ID,
  sequence: 1,
  requestKey: 'submit-1',
  status: 'running',
  homePolicyRevision: null,
  workspacePolicyRevision: null,
  createdAt: NOW,
  updatedAt: NOW
};

describe('CancelHomeTurnUseCase', () => {
  it.each([
    { runtimeOutcome: 'confirmed' as const, expectedStatus: 'cancelled' as const },
    { runtimeOutcome: 'unknown' as const, expectedStatus: 'unknown' as const }
  ])('persists cancellation intent before signaling runtime and maps $runtimeOutcome to $expectedStatus', async ({ runtimeOutcome, expectedStatus }) => {
    const order: string[] = [];
    const conversations = {
      cancelTurn: jest.fn(async () => {
        order.push('intent-persisted');
        return { resource: { ...activeTurn, status: 'cancel_requested' as const }, replayed: false };
      }),
      updateTurnStatus: jest.fn(async ({ status }: { readonly status: HomeTurn['status'] }) => {
        order.push(`final-status-persisted:${status}`);
        return { ...activeTurn, status };
      })
    };
    const runtime = {
      cancel: jest.fn(async () => {
        order.push('runtime-signaled');
        return { outcome: runtimeOutcome };
      })
    };

    const useCase = new CancelHomeTurnUseCase(
      conversations as unknown as IHomeConversationRepository,
      runtime as unknown as IHomePlanningRuntime
    );
    const result = await useCase.execute({ ownerId: OWNER_ID, conversationId: CONVERSATION_ID, turnId: TURN_ID });

    expect(conversations.cancelTurn).toHaveBeenCalledWith({ ownerId: OWNER_ID, conversationId: CONVERSATION_ID, turnId: TURN_ID });
    expect(runtime.cancel).toHaveBeenCalledWith(TURN_ID);
    expect(order).toEqual(['intent-persisted', 'runtime-signaled', `final-status-persisted:${expectedStatus}`]);
    expect(result.resource.status).toBe(expectedStatus);
  });
});
