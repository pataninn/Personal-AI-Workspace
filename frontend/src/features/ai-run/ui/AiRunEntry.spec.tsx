import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { userSessionReducer } from '@/entities/user-session';
import type { AiRunIntent, AiRunSnapshot, EgressFactDisclosure, EgressManifest } from '@/entities/ai-run';
import type { ProjectFact } from '@/entities/project-fact';
import { ApiClientError } from '@/shared/api';
import { AiRunEntry } from '@/features/ai-run/ui/AiRunEntry';

const { createAiRunMock, getAiRunMock, getEgressManifestMock, decideEgressMock, startAiRunMock, listFactsMock } = vi.hoisted(() => ({
  createAiRunMock: vi.fn(),
  getAiRunMock: vi.fn(),
  getEgressManifestMock: vi.fn(),
  decideEgressMock: vi.fn(),
  startAiRunMock: vi.fn(),
  listFactsMock: vi.fn()
}));

vi.mock('@/entities/ai-run/api/ai-run-api', () => ({
  createAiRun: createAiRunMock,
  getAiRun: getAiRunMock,
  getEgressManifest: getEgressManifestMock,
  decideEgress: decideEgressMock,
  startAiRun: startAiRunMock
}));

vi.mock('@/entities/project-fact/api/project-fact-api', () => ({ listProjectFacts: listFactsMock }));

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '44444444-4444-4444-8444-000000000001';
const RUN_ID = '77777777-7777-4777-8777-000000000001';
const HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FACT_ID = '55555555-5555-4555-8555-000000000001';

const projectFact: ProjectFact = {
  id: FACT_ID,
  projectId: PROJECT_ID,
  title: 'Preferred language',
  content: 'This project uses TypeScript.',
  source: { kind: 'user', label: 'Added by you', reference: null },
  createdAt: '2026-09-26T00:00:00.000Z',
  updatedAt: '2026-09-26T00:00:00.000Z',
  version: 1,
  verifiedAt: null,
  verificationStatus: 'needs_review'
};

const disclosedFact: EgressFactDisclosure = {
  ...projectFact,
  sizeBytes: 83,
  sourceHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
};

const pending: AiRunSnapshot = {
  runId: RUN_ID,
  projectId: PROJECT_ID,
  conversationId: CONVERSATION_ID,
  status: 'pending_approval',
  phase: 'decision',
  manifestHash: HASH,
  decision: 'pending',
  safeMessage: 'Review the provider disclosure before continuing.',
  cleanup: 'not_started',
  providerTransmission: 'not_started_confirmed',
  stagingItemCount: 0
};

const manifest: EgressManifest = {
  runId: RUN_ID,
  manifestHash: HASH,
  status: 'pending_approval',
  provider: 'NVIDIA hosted NIM',
  providerProfile: 'nvidia-hosted-nim',
  model: 'nvidia/nemotron-3-super-120b-a12b',
  categories: ['Request', 'Project files'],
  relativePaths: ['src/index.ts'],
  itemCount: 1,
  messageCount: 0,
  facts: [],
  byteEstimate: 1200,
  tokenEstimate: 300,
  excludedItemCount: 0,
  omittedItemCount: 0,
  omissionSummary: 'No selected items were excluded.',
  bestEffortSecretDetection: true,
  preConsentNotice: 'Nothing has been sent to NVIDIA yet.'
};

const session = {
  status: 'authenticated' as const,
  principal: { id: 'user-1', displayName: 'Local user' },
  csrfToken: 'csrf-token',
  expiresAt: '2026-09-13T00:00:00.000Z',
  errorCode: null
};

function renderEntry(request = 'Inspect the project'): void {
  const store = configureStore({ reducer: { userSession: userSessionReducer }, preloadedState: { userSession: session } });
  render(
    <Provider store={store}>
      <AiRunEntry projectId={PROJECT_ID} conversationId={CONVERSATION_ID} request={request} disabled={false} />
    </Provider>
  );
}

describe('AiRunEntry', () => {
  beforeEach(() => {
    createAiRunMock.mockReset();
    getAiRunMock.mockReset();
    getEgressManifestMock.mockReset();
    decideEgressMock.mockReset();
    startAiRunMock.mockReset();
    listFactsMock.mockReset().mockResolvedValue([projectFact]);
    createAiRunMock.mockResolvedValue({ ...pending, manifest } satisfies AiRunIntent);
    getEgressManifestMock.mockResolvedValue(manifest);
  });

  it('keeps Ask AI disabled for an empty request and explains the required action', () => {
    renderEntry('   ');

    expect(screen.getByTestId('ai-run-submit')).toBeDisabled();
    expect(screen.getByTestId('ai-run-entry')).toHaveTextContent('Ask AI first shows what will be sent to NVIDIA NIM.');
    expect(screen.getByTestId('ai-run-request-error')).toHaveTextContent('Enter a request before asking the assistant.');
    expect(createAiRunMock).not.toHaveBeenCalled();
  });

  it('shows the exact provider disclosure before a decision and keeps Save message separate', async () => {
    renderEntry();
    const user = userEvent.setup();

    await user.click(screen.getByTestId('ai-run-submit'));

    expect(await screen.findByTestId('provider-consent-alert-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('provider-consent-title')).toHaveTextContent('Send selected context to NVIDIA NIM?');
    expect(screen.getByTestId('provider-consent-provider')).toHaveTextContent('NVIDIA hosted NIM');
    expect(screen.getByTestId('provider-consent-model')).toHaveTextContent('nvidia/nemotron-3-super-120b-a12b');
    expect(screen.getByTestId('provider-consent-context')).toHaveTextContent('src/index.ts');
    expect(screen.getByTestId('provider-consent-no-staging-notice')).toHaveTextContent('Nothing has been sent to NVIDIA yet.');
    expect(screen.getByTestId('provider-consent-file-count')).toHaveTextContent('1');
    expect(screen.getByTestId('provider-consent-message-count')).toHaveTextContent('0');
    expect(decideEgressMock).not.toHaveBeenCalled();
  });

  it('sends only explicitly selected project facts and shows their exact content before consent', async () => {
    const factManifest: EgressManifest = {
      ...manifest,
      categories: ['Request', 'Project facts'],
      facts: [disclosedFact]
    };
    createAiRunMock.mockResolvedValue({ ...pending, manifest: factManifest } satisfies AiRunIntent);
    renderEntry();
    const user = userEvent.setup();

    await user.click(screen.getByTestId('memory-context-open'));
    const factCheckbox = await screen.findByTestId(`memory-context-fact-${FACT_ID}`);
    expect(factCheckbox).not.toBeChecked();
    await user.click(factCheckbox);
    await user.click(screen.getByTestId('memory-context-apply'));
    await user.click(screen.getByTestId('ai-run-submit'));

    await waitFor(() => expect(createAiRunMock).toHaveBeenCalledWith(
      PROJECT_ID,
      {
        conversationId: CONVERSATION_ID,
        request: 'Inspect the project',
        context: { relativePaths: [], includeRecentMessages: false, factIds: [FACT_ID] }
      },
      'csrf-token',
      expect.any(String)
    ));
    expect(listFactsMock).toHaveBeenCalledTimes(2);
    expect(await screen.findByTestId('provider-consent-fact-content')).toHaveTextContent('This project uses TypeScript.');
    expect(screen.getByTestId('provider-consent-fact-count')).toHaveTextContent('1');
    expect(screen.getByTestId('provider-consent-facts')).toHaveTextContent('Added by you');
    expect(decideEgressMock).not.toHaveBeenCalled();
  });

  it('records a rejection and reports that no project content was sent', async () => {
    decideEgressMock.mockResolvedValue({ ...pending, status: 'rejected', decision: 'rejected', safeMessage: 'This run was not started.' });
    renderEntry();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('ai-run-submit'));
    await user.click(await screen.findByTestId('provider-consent-reject'));

    await waitFor(() => expect(decideEgressMock).toHaveBeenCalledWith(RUN_ID, { manifestHash: HASH, decision: 'reject' }, 'csrf-token', expect.any(String)));
    expect(await screen.findByTestId('run-rejected')).toHaveTextContent('No project content was sent to NVIDIA.');
  });

  it('treats Escape as the safe rejection path instead of approval', async () => {
    decideEgressMock.mockResolvedValue({ ...pending, status: 'rejected', decision: 'rejected', safeMessage: 'This run was not started.' });
    renderEntry();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('ai-run-submit'));
    await screen.findByTestId('provider-consent-alert-dialog');
    await user.keyboard('{Escape}');

    await waitFor(() => expect(decideEgressMock).toHaveBeenCalledWith(RUN_ID, { manifestHash: HASH, decision: 'reject' }, 'csrf-token', expect.any(String)));
    expect(decideEgressMock).not.toHaveBeenCalledWith(RUN_ID, { manifestHash: HASH, decision: 'approve' }, expect.anything(), expect.anything());
  });

  it('approves only the displayed manifest and shows readiness without claiming an answer', async () => {
    decideEgressMock.mockResolvedValue({ ...pending, status: 'ready', phase: 'runtime', decision: 'approved', runtime: { kind: 'fake', sandboxReady: true } });
    startAiRunMock.mockReturnValue(new Promise(() => undefined));
    renderEntry();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('ai-run-submit'));
    await user.click(await screen.findByTestId('provider-consent-approve'));

    await waitFor(() => expect(decideEgressMock).toHaveBeenCalledWith(RUN_ID, { manifestHash: HASH, decision: 'approve' }, 'csrf-token', expect.any(String)));
    expect(await screen.findByTestId('run-ready')).toHaveTextContent('Provider access approved');
    expect(screen.getByTestId('run-ready-status')).toHaveTextContent('server-side NVIDIA NIM request');
    expect(screen.getByTestId('run-ready-status')).not.toHaveTextContent('Here is your answer');
  });

  it('blocks approval until a changed manifest is refreshed', async () => {
    decideEgressMock.mockRejectedValue(new ApiClientError(409, 'EGRESS_SOURCE_CHANGED', 'internal detail'));
    getAiRunMock.mockResolvedValue(pending);
    renderEntry();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('ai-run-submit'));
    await user.click(await screen.findByTestId('provider-consent-approve'));

    expect(await screen.findByTestId('provider-consent-error')).toHaveTextContent('This disclosure is no longer current.');
    expect(screen.getByTestId('provider-consent-approve')).toBeDisabled();
    expect(screen.getByTestId('provider-consent-refresh')).toHaveTextContent('Refresh disclosure');
  });

  it('fails closed when NVIDIA NIM is unavailable after approval', async () => {
    decideEgressMock.mockRejectedValue(new ApiClientError(503, 'RUNTIME_UNAVAILABLE', 'internal detail'));
    getAiRunMock.mockRejectedValue(new Error('status unavailable'));
    renderEntry();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('ai-run-submit'));
    await user.click(await screen.findByTestId('provider-consent-approve'));

    expect(await screen.findByTestId('run-error')).toHaveTextContent('NVIDIA NIM is unavailable. No provider request was started.');
    expect(screen.getByTestId('run-error')).not.toHaveTextContent('internal detail');
  });
});
