import { describe, expect, it } from 'vitest';

import { ApiClientError } from '@/shared/api';
import { normalizeAiRunIntent, normalizeAiRunSnapshot, normalizeEgressManifest } from '@/entities/ai-run/api/ai-run-api';

const RUN_ID = '77777777-7777-4777-8777-000000000001';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '44444444-4444-4444-8444-000000000001';
const HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

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
});
