import { describe, expect, it } from 'vitest';

import { ApiClientError } from '@/shared/api';
import { normalizeAiRunIntent, normalizeAiRunSnapshot, normalizeEgressManifest, normalizeProviderPermissions } from '@/entities/ai-run/api/ai-run-api';

const RUN_ID = '77777777-7777-4777-8777-000000000001';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '44444444-4444-4444-8444-000000000001';
const HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const factDisclosure = {
  id: '55555555-5555-4555-8555-000000000001',
  title: 'Preferred test command',
  content: 'Run pnpm test from the repository root.',
  source: { kind: 'user', label: 'Added by you', reference: null },
  version: 2,
  verifiedAt: '2026-09-26T00:00:00.000Z',
  verificationStatus: 'verified',
  sizeBytes: 40,
  sourceHash: HASH
};

describe('AI run API normalizers', () => {
  it('normalizes the disclosure envelope without rendering absolute or traversal paths', () => {
    const manifest = normalizeEgressManifest({
      runId: RUN_ID,
      manifestHash: HASH,
      provider: 'NVIDIA hosted NIM',
      providerProfile: 'nvidia-hosted-nim',
      model: 'nvidia/nemotron-3-super-120b-a12b',
      content: {
        categories: ['Request', 'Project files'],
        relativePaths: ['/workspace/private.env', '../outside.txt', 'src/index.ts'],
        itemCount: 3,
        messageCount: 0,
        byteEstimate: 1234,
        tokenEstimate: 300
      },
      redaction: { excludedItemCount: 2, omittedItemCount: 0 }
    }, RUN_ID);

    expect(manifest.relativePaths).toEqual(['src/index.ts']);
    expect(manifest.preConsentNotice).toBe('Nothing has been sent to NVIDIA yet.');
    expect(manifest.omissionSummary).toBe('Some selected items were excluded by local safety policy.');
    expect(manifest.model).toBe('nvidia/nemotron-3-super-120b-a12b');
  });

  it('normalizes the backend run resource while keeping runtime data bounded', () => {
    const snapshot = normalizeAiRunSnapshot({
      id: RUN_ID,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      status: 'ready',
      phase: 'runtime',
      decision: 'approved',
      manifest: { manifestHash: HASH },
      cleanup: 'complete',
      providerTransmission: 'not_started_confirmed',
      stagingItemCount: 2,
      runtime: { kind: 'fake', sandboxReady: true },
      safeMessage: 'Private run environment ready.'
    });

    expect(snapshot).toMatchObject({ runId: RUN_ID, status: 'ready', decision: 'approved', stagingItemCount: 2, runtime: { kind: 'fake', sandboxReady: true } });
    expect(snapshot).not.toHaveProperty('request');
    expect(snapshot).not.toHaveProperty('relativeRoot');
    expect(normalizeAiRunSnapshot({
      runId: RUN_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID,
      status: 'succeeded', phase: 'terminal', decision: 'approved', manifestHash: HASH,
      cleanup: 'complete', providerTransmission: 'transmitted_confirmed',
      stagingItemCount: 0, safeMessage: 'Assistant response complete.'
    }).providerTransmission).toBe('transmitted_confirmed');
  });

  it('accepts only suggestions belonging to the owned run snapshot', () => {
    const run = {
      runId: RUN_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID,
      status: 'succeeded', phase: 'terminal', decision: 'approved', manifestHash: HASH,
      taskSuggestions: [{
        id: '88888888-8888-4888-8888-000000000001',
        projectId: PROJECT_ID, runId: RUN_ID, conversationId: CONVERSATION_ID,
        title: 'Update setup notes', details: null, status: 'pending', version: 1,
        taskId: null, source: { kind: 'assistant', label: 'Suggested by the assistant' },
        createdAt: '2026-09-26T00:00:00.000Z', resolvedAt: null
      }]
    };

    expect(normalizeAiRunSnapshot(run).taskSuggestions?.map((suggestion) => suggestion.title)).toEqual(['Update setup notes']);
    expect(() => normalizeAiRunSnapshot({ ...run, taskSuggestions: [{ ...run.taskSuggestions[0], projectId: 'foreign-project' }] })).toThrow(ApiClientError);
    expect(() => normalizeAiRunSnapshot({ ...run, taskSuggestions: [{ ...run.taskSuggestions[0], status: 'accepted', version: 0 }] })).toThrow(ApiClientError);
  });

  it('unwraps run and manifest resources returned by create and decision endpoints', () => {
    const intent = normalizeAiRunIntent({
      run: {
        id: RUN_ID,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
        status: 'pending_approval',
        phase: 'manifest',
        decision: 'pending',
        manifest: { manifestHash: HASH },
        safeMessage: 'Review the provider disclosure before continuing.'
      },
      manifest: {
        runId: RUN_ID,
        manifestHash: HASH,
        provider: 'NVIDIA hosted NIM',
        model: 'nvidia/nemotron-3-super-120b-a12b',
        content: { categories: ['Request'], relativePaths: [], itemCount: 0, messageCount: 0, byteEstimate: 12, tokenEstimate: 3 },
        redaction: { excludedItemCount: 0, omittedItemCount: 0 }
      }
    });

    expect(intent.runId).toBe(RUN_ID);
    expect(intent.manifest?.manifestHash).toBe(HASH);
    expect(intent.manifest?.categories).toEqual(['Request']);
  });

  it('rejects a non-SHA manifest hash instead of exposing an opaque identifier', () => {
    expect(() => normalizeEgressManifest({ manifestHash: 'run-secret-id' }, RUN_ID)).toThrow(ApiClientError);
  });

  it('preserves exact selected fact text and source metadata in the consent manifest', () => {
    const manifest = normalizeEgressManifest({
      runId: RUN_ID,
      manifestHash: HASH,
      content: { categories: ['Request', 'Project facts'], relativePaths: [], itemCount: 1, messageCount: 0, facts: [factDisclosure] },
      redaction: { excludedItemCount: 0, omittedItemCount: 0 }
    }, RUN_ID);

    expect(manifest.facts).toEqual([factDisclosure]);
    expect(manifest.categories).toContain('Project facts');
  });

  it('rejects a malformed selected fact instead of rendering an incomplete disclosure', () => {
    expect(() => normalizeEgressManifest({
      runId: RUN_ID,
      manifestHash: HASH,
      content: { facts: [{ ...factDisclosure, sourceHash: 'invalid' }] }
    }, RUN_ID)).toThrow(ApiClientError);
    expect(() => normalizeEgressManifest({
      runId: RUN_ID,
      manifestHash: HASH,
      content: { facts: [{ ...factDisclosure, verificationStatus: 'needs_review' }] }
    }, RUN_ID)).toThrow(ApiClientError);
  });

  it('normalizes persistent project/provider permissions and rejects widened scope or expiry', () => {
    const permission = {
      id: '66666666-6666-4666-8666-666666666666',
      subject: { ownerId: '99999999-9999-4999-8999-999999999999', label: 'Signed-in account' },
      projectId: PROJECT_ID,
      providerProfile: 'nvidia-hosted-nim',
      model: 'nvidia/nemotron-3-super-120b-a12b',
      capability: 'send_selected_context',
      persistence: 'until_revoked',
      expiresAt: null,
      createdAt: '2026-09-29T00:00:00.000Z',
      revokedAt: null
    };
    expect(normalizeProviderPermissions({ permissions: [permission] })).toEqual([{
      id: permission.id,
      ownerId: permission.subject.ownerId,
      projectId: permission.projectId,
      providerProfile: permission.providerProfile,
      model: permission.model,
      capability: 'send_selected_context',
      persistence: 'until_revoked',
      expiresAt: null,
      createdAt: permission.createdAt,
      revokedAt: null
    }]);
    expect(() => normalizeProviderPermissions({ permissions: [{ ...permission, capability: 'write_files' }] })).toThrow(ApiClientError);
    expect(() => normalizeProviderPermissions({ permissions: [{ ...permission, expiresAt: '2030-01-01T00:00:00.000Z' }] })).toThrow(ApiClientError);
  });
});
