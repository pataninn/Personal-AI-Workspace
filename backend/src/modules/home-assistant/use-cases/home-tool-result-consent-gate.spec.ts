import type { HomeConsentDisclosureRecord, HomeTurn } from '@/modules/home-assistant/domain/home-conversation-types';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';
import type { HomePlanningProvider } from '@/modules/home-assistant/repositories/home-planning-runtime';
import { HomeTurnNotActiveError } from '@/modules/home-assistant/domain/home-conversation-errors';
import { HomeToolResultConsentGate } from '@/modules/home-assistant/use-cases/home-tool-result-consent-gate';

const OWNER = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const TURN = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-16T00:00:00.000Z');
const provider: HomePlanningProvider = { profile: 'nebius-token-factory', model: 'test-model', endpoint: 'https://example.invalid/v1' };

function makeTurn(status: HomeTurn['status']): HomeTurn {
  return {
    id: TURN, ownerId: OWNER, conversationId: CONVERSATION, sequence: 1, requestKey: 'submit-1', status,
    homePolicyRevision: null, workspacePolicyRevision: null, createdAt: NOW, updatedAt: NOW
  };
}

function makeDisclosure(draft: Parameters<IHomeConversationRepository['createToolResultDisclosure']>[0]['draft']): HomeConsentDisclosureRecord {
  return {
    disclosureId: draft.disclosureId, ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN,
    phase: 'tool_result', providerProfile: draft.provider.profile, providerName: 'Nebius Token Factory', model: draft.provider.model,
    scope: draft.scope, categories: draft.categories, itemCount: draft.itemCount, byteLimit: draft.byteLimit,
    runtimeRequestId: draft.runtimeRequestId, resultFingerprint: draft.resultFingerprint, decision: null,
    deliveryState: 'awaiting_decision', createdAt: NOW, updatedAt: NOW
  };
}

function setup(status: HomeTurn['status'] = 'running') {
  const conversations = {
    findTurnForOwner: jest.fn(async () => makeTurn(status)),
    createToolResultDisclosure: jest.fn(async (input: Parameters<IHomeConversationRepository['createToolResultDisclosure']>[0]) => ({
      disclosure: makeDisclosure(input.draft), replayed: false
    }))
  };
  return {
    gate: new HomeToolResultConsentGate(conversations as unknown as IHomeConversationRepository, provider),
    conversations
  };
}

describe('HomeToolResultConsentGate', () => {
  it('redacts and retains the bounded result only in process memory while persisting safe metadata', async () => {
    const { gate, conversations } = setup();
    const data = { name: 'Boiler', token: 'private-value', note: 'api_key=private-value', nested: { password: 'private-value' }, active: true };

    const descriptor = await gate.request({
      ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, requestId: 'fixture-read-1',
      scope: { kind: 'home' }, categories: ['task_metadata'], itemCount: 1, data
    });

    expect(descriptor).toMatchObject({ phase: 'tool_result', provider: { profile: provider.profile }, categories: ['task_metadata'] });
    const persisted = conversations.createToolResultDisclosure.mock.calls[0]?.[0];
    expect(persisted).toBeDefined();
    expect(persisted).not.toHaveProperty('data');
    expect(persisted?.draft).not.toHaveProperty('data');
    expect(persisted?.draft.resultFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(gate.take(descriptor.disclosureId)?.data).toEqual({ name: 'Boiler', token: '[REDACTED]', note: 'api_key=[REDACTED]', nested: { password: '[REDACTED]' }, active: true });
    expect(gate.take(descriptor.disclosureId)).toBeNull();
  });

  it('redacts nested authorization, cookie, and session credentials while preserving ordinary session metadata', async () => {
    const { gate } = setup();
    const data = {
      name: 'Boiler',
      request: {
        headers: {
          Authorization: 'Bearer auth-secret',
          COOKIE: 'session=private-cookie',
          cookieHeader: 'private-header-cookie'
        },
        session_id: 'private-session-snake',
        sessionID: 'private-session-camel',
        session_summary: 'The user checked the boiler yesterday.'
      }
    };

    const disclosure = await gate.request({
      ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, requestId: 'fixture-read-2',
      scope: { kind: 'home' }, categories: ['task_metadata'], itemCount: 1, data
    });

    expect(gate.take(disclosure.disclosureId)?.data).toEqual({
      name: 'Boiler',
      request: {
        headers: {
          Authorization: '[REDACTED]',
          COOKIE: '[REDACTED]',
          cookieHeader: '[REDACTED]'
        },
        session_id: '[REDACTED]',
        sessionID: '[REDACTED]',
        session_summary: 'The user checked the boiler yesterday.'
      }
    });
  });

  it('rechecks turn activity before saving a disclosure or retaining its result', async () => {
    const { gate, conversations } = setup('cancelled');

    await expect(gate.request({
      ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, requestId: 'fixture-read-1',
      scope: { kind: 'home' }, categories: ['task_metadata'], itemCount: 1, data: { name: 'Boiler' }
    })).rejects.toBeInstanceOf(HomeTurnNotActiveError);

    expect(conversations.createToolResultDisclosure).not.toHaveBeenCalled();
  });

  it('rejects oversized and non-JSON results before asking persistence to create a disclosure', async () => {
    const oversized = setup();
    await expect(oversized.gate.request({
      ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, requestId: 'fixture-read-1',
      scope: { kind: 'home' }, categories: ['task_metadata'], itemCount: 1, data: { value: 'x'.repeat(300_000) }
    })).rejects.toThrow('supported bounds');

    const invalid = setup();
    await expect(invalid.gate.request({
      ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, requestId: 'fixture-read-1',
      scope: { kind: 'home' }, categories: ['task_metadata'], itemCount: 1, data: { value: Number.NaN }
    })).rejects.toThrow('not valid JSON');
    expect(oversized.conversations.createToolResultDisclosure).not.toHaveBeenCalled();
    expect(invalid.conversations.createToolResultDisclosure).not.toHaveBeenCalled();
  });
});
