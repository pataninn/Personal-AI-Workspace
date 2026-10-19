import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { userSessionReducer } from '@/entities/user-session';
import type { AiRunIntent, AiRunSnapshot, EgressFactDisclosure, EgressManifest } from '@/entities/ai-run';
import type { ProjectFact } from '@/entities/project-fact';
import { ApiClientError } from '@/shared/api';
import { AiRunEntry } from '@/features/ai-run/ui/AiRunEntry';

const { createAiRunMock, getAiRunMock, getEgressManifestMock, decideEgressMock, startAiRunMock, listFactsMock, listPermissionsMock, revokePermissionMock } = vi.hoisted(() => ({
  createAiRunMock: vi.fn(),
  getAiRunMock: vi.fn(),
  getEgressManifestMock: vi.fn(),
  decideEgressMock: vi.fn(),
  startAiRunMock: vi.fn(),
  listFactsMock: vi.fn(),
  listPermissionsMock: vi.fn(),
  revokePermissionMock: vi.fn()
}));
const usageApi = vi.hoisted(() => ({ useAccountUsage: vi.fn() }));

vi.mock('@/entities/ai-run/api/ai-run-api', () => ({
  createAiRun: createAiRunMock,
  getAiRun: getAiRunMock,
  getEgressManifest: getEgressManifestMock,
  decideEgress: decideEgressMock,
  startAiRun: startAiRunMock,
  listProviderPermissions: listPermissionsMock,
  revokeProviderPermission: revokePermissionMock
}));

vi.mock('@/entities/project-fact/api/project-fact-api', () => ({ listProjectFacts: listFactsMock }));
vi.mock('@/entities/account-usage', async (importOriginal) => ({ ...await importOriginal<typeof import('@/entities/account-usage')>(), ...usageApi }));

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
  principal: { id: 'user-1', displayName: 'Local user', accountKind: 'regular' as const, role: 'user' as const },
  csrfToken: 'csrf-token',
  expiresAt: '2026-09-13T00:00:00.000Z',
  errorCode: null
};

function renderEntry(request = 'Inspect the project'): void {
  const store = configureStore({ reducer: { userSession: userSessionReducer }, preloadedState: { userSession: session } });
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[window.location.pathname + window.location.search]}>
        <AiRunEntry projectId={PROJECT_ID} conversationId={CONVERSATION_ID} request={request} disabled={false} />
        <LocationProbe />
      </MemoryRouter>
    </Provider>
  );
}

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <output data-testid="current-url">{location.pathname}{location.search}</output>;
}

describe('AiRunEntry', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    createAiRunMock.mockReset();
    getAiRunMock.mockReset();
    getEgressManifestMock.mockReset();
    decideEgressMock.mockReset();
    startAiRunMock.mockReset();
    listPermissionsMock.mockReset().mockResolvedValue([]);
    revokePermissionMock.mockReset().mockResolvedValue(undefined);
    listFactsMock.mockReset().mockResolvedValue([projectFact]);
    createAiRunMock.mockResolvedValue({ ...pending, manifest } satisfies AiRunIntent);
    getEgressManifestMock.mockResolvedValue(manifest);
    usageApi.useAccountUsage.mockReset().mockReturnValue({ state: { status: 'success', data: { availability: { status: 'available', canSubmit: true, reason: null } } }, refresh: vi.fn() });
  });

  it('restores the exact pending provider disclosure and consent dialog from the conversation URL', async () => {
    window.history.replaceState({}, '', `/?runId=${RUN_ID}`);
    getAiRunMock.mockResolvedValue(pending);
    renderEntry();

    expect(await screen.findByTestId('provider-consent-alert-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('provider-consent-context')).toHaveTextContent('src/index.ts');
    expect(createAiRunMock).not.toHaveBeenCalled();
  });

  it('rechecks the run scope when the same URL is opened in another conversation', async () => {
    window.history.replaceState({}, '', `/?runId=${RUN_ID}`);
    getAiRunMock.mockResolvedValue(pending);
    const store = configureStore({ reducer: { userSession: userSessionReducer }, preloadedState: { userSession: session } });
    const renderConversation = (conversationId: string): React.JSX.Element => (
      <Provider store={store}>
        <MemoryRouter initialEntries={[window.location.pathname + window.location.search]}>
          <AiRunEntry projectId={PROJECT_ID} conversationId={conversationId} request="Inspect the project" disabled={false} />
        </MemoryRouter>
      </Provider>
    );
    const view = render(renderConversation(CONVERSATION_ID));
    expect(await screen.findByTestId('provider-consent-alert-dialog')).toBeInTheDocument();

    view.rerender(renderConversation('44444444-4444-4444-8444-000000000002'));

    expect(await screen.findByTestId('ai-run-restore-error')).toHaveTextContent('could not be restored in this conversation');
    expect(screen.queryByTestId('provider-consent-alert-dialog')).not.toBeInTheDocument();
    expect(getAiRunMock).toHaveBeenCalledTimes(2);
  });

  it('blocks Ask AI while a restored run is still staging', async () => {
    window.history.replaceState({}, '', `/?runId=${RUN_ID}`);
    getAiRunMock.mockResolvedValue({ ...pending, status: 'staging', phase: 'staging', decision: 'approved' });
    renderEntry();

    expect(await screen.findByTestId('run-staging')).toBeInTheDocument();
    expect(screen.getByTestId('ai-run-submit')).toBeDisabled();
    expect(screen.getByTestId('ai-run-new-request-blocked')).toHaveTextContent('This run is still unresolved');
    expect(createAiRunMock).not.toHaveBeenCalled();
  });

  it('requires a duplicate-work warning before starting a separate run after ambiguous provider transmission', async () => {
    window.history.replaceState({}, '', `/?runId=${RUN_ID}`);
    getAiRunMock.mockResolvedValue({ ...pending, status: 'failed', phase: 'runtime', decision: 'approved', providerTransmission: 'unknown' });
    renderEntry();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('ai-run-separate-request'));
    expect(screen.getByTestId('ai-run-duplicate-work-warning')).toHaveTextContent('may repeat provider work');
    expect(createAiRunMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Confirm and start separate run' }));
    await waitFor(() => expect(createAiRunMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('current-url')).toHaveTextContent(`runId=${RUN_ID}`);
  });

  it('allows a safe retry from review only when no provider transmission is confirmed', async () => {
    window.history.replaceState({}, '', `/?runId=${RUN_ID}`);
    getAiRunMock.mockResolvedValue({ ...pending, status: 'review_required', phase: 'review', decision: 'approved', providerTransmission: 'not_started_confirmed' });
    renderEntry();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('ai-run-safe-retry'));

    await waitFor(() => expect(createAiRunMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('ai-run-duplicate-work-warning')).not.toBeInTheDocument();
  });

  it('keeps Ask AI disabled for an empty request and explains the required action', () => {
    renderEntry('   ');

    expect(screen.getByTestId('ai-run-submit')).toBeDisabled();
    expect(screen.getByTestId('ai-run-entry')).toHaveTextContent('Ask AI first shows what will be sent to your model provider.');
    expect(screen.getByTestId('ai-run-request-error')).toHaveTextContent('Enter a request before asking the assistant.');
    expect(createAiRunMock).not.toHaveBeenCalled();
  });

  it('blocks provider approval when the account is globally paused but still allows safe rejection', async () => {
    window.history.replaceState({}, '', `/?runId=${RUN_ID}`);
    getAiRunMock.mockResolvedValue(pending);
    usageApi.useAccountUsage.mockReturnValue({ state: { status: 'success', data: { availability: { status: 'paused', canSubmit: false, reason: 'AI inference is paused by an administrator.' } } }, refresh: vi.fn() });
    renderEntry();

    expect(await screen.findByTestId('provider-consent-alert-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('provider-consent-availability')).toHaveTextContent('AI inference is paused by an administrator.');
    expect(screen.getByTestId('provider-consent-approve')).toBeDisabled();
    expect(screen.getByTestId('provider-consent-reject')).toBeEnabled();
    expect(createAiRunMock).not.toHaveBeenCalled();
    expect(decideEgressMock).not.toHaveBeenCalled();
  });

  it('shows the exact provider disclosure before a decision and keeps Save message separate', async () => {
    renderEntry();
    const user = userEvent.setup();

    await user.click(screen.getByTestId('ai-run-submit'));

    expect(await screen.findByTestId('provider-consent-alert-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('provider-consent-title')).toHaveTextContent('Send selected context to NVIDIA hosted NIM?');
    expect(screen.getByTestId('provider-consent-provider')).toHaveTextContent('NVIDIA hosted NIM');
    expect(screen.getByTestId('provider-consent-model')).toHaveTextContent('nvidia/nemotron-3-super-120b-a12b');
    expect(screen.getByTestId('provider-consent-context')).toHaveTextContent('src/index.ts');
    expect(screen.getByTestId('provider-consent-no-staging-notice')).toHaveTextContent('Nothing has been sent to NVIDIA yet.');
    expect(screen.getByTestId('provider-consent-file-count')).toHaveTextContent('1');
    expect(screen.getByTestId('provider-consent-message-count')).toHaveTextContent('0');
    expect(decideEgressMock).not.toHaveBeenCalled();
  });

  it('shows the full remembered permission scope before saving it with explicit consent', async () => {
    decideEgressMock.mockResolvedValue({ ...pending, status: 'ready', phase: 'runtime', decision: 'approved', runtime: { kind: 'fake', sandboxReady: true } });
    startAiRunMock.mockReturnValue(new Promise(() => undefined));
    renderEntry();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('ai-run-submit'));
    await user.click(await screen.findByTestId('provider-consent-remember'));

    expect(screen.getByTestId('provider-consent-permission-scope')).toHaveTextContent('You, in this signed-in account');
    expect(screen.getByTestId('provider-consent-permission-scope')).toHaveTextContent('This project only');
    expect(screen.getByTestId('provider-consent-permission-scope')).toHaveTextContent('Send the request and explicitly selected project context');
    expect(screen.getByTestId('provider-consent-permission-scope')).toHaveTextContent('Until revoked');
    expect(screen.getByTestId('provider-consent-provider-terms')).toHaveTextContent('prohibit confidential or sensitive data');

    await user.click(screen.getByTestId('provider-consent-approve'));
    await waitFor(() => expect(decideEgressMock).toHaveBeenCalledWith(RUN_ID, {
      manifestHash: HASH,
      decision: 'approve',
      rememberProviderPermission: true
    }, 'csrf-token', expect.any(String)));
    expect(listPermissionsMock).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('keeps a remembered-approved legacy run paused without starting it again', async () => {
    createAiRunMock.mockResolvedValue({ ...pending, status: 'ready', phase: 'runtime', decision: 'approved', providerApprovalMode: 'remembered_permission', manifest } satisfies AiRunIntent);
    listPermissionsMock.mockResolvedValue([{
      id: '66666666-6666-4666-8666-666666666666',
      ownerId: 'user-1',
      projectId: PROJECT_ID,
      providerProfile: 'nvidia-hosted-nim',
      model: 'nvidia/nemotron-3-super-120b-a12b',
      capability: 'send_selected_context',
      persistence: 'until_revoked',
      expiresAt: null,
      createdAt: '2026-09-29T00:00:00.000Z',
      revokedAt: null
    }]);
    startAiRunMock.mockReturnValue(new Promise(() => undefined));
    renderEntry();
    const user = userEvent.setup();
    expect(await screen.findByTestId('provider-permission-active-notice')).toHaveTextContent('without another provider approval');
    await user.click(screen.getByTestId('ai-run-submit'));

    await waitFor(() => expect(screen.getByTestId('run-connection-status')).toHaveTextContent('This older approved run is paused'));
    expect(startAiRunMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('provider-consent-alert-dialog')).not.toBeInTheDocument();
    expect(await screen.findByTestId('ai-run-remembered-permission-notice')).toHaveTextContent('legacy record');
  });

  it('revokes the active permission with the current CSRF token', async () => {
    listPermissionsMock.mockResolvedValueOnce([{
      id: '66666666-6666-4666-8666-666666666666', ownerId: 'user-1', projectId: PROJECT_ID,
      providerProfile: 'nvidia-hosted-nim', model: 'nvidia/nemotron-3-super-120b-a12b',
      capability: 'send_selected_context', persistence: 'until_revoked', expiresAt: null,
      createdAt: '2026-09-29T00:00:00.000Z', revokedAt: null
    }]).mockResolvedValueOnce([]);
    renderEntry();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('provider-permission-manager-toggle'));
    await user.click(await screen.findByTestId('provider-permission-revoke'));

    await waitFor(() => expect(revokePermissionMock).toHaveBeenCalledWith(PROJECT_ID, '66666666-6666-4666-8666-666666666666', 'csrf-token'));
    expect(await screen.findByText('No remembered provider permissions for this project.')).toBeInTheDocument();
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
    expect(await screen.findByTestId('run-rejected')).toHaveTextContent('No project content was sent to the model provider.');
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
    expect(screen.getByTestId('run-ready-status')).toHaveTextContent('server-side model request');
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

  it('fails closed when the model provider is unavailable after approval', async () => {
    decideEgressMock.mockRejectedValue(new ApiClientError(503, 'RUNTIME_UNAVAILABLE', 'internal detail'));
    getAiRunMock.mockRejectedValue(new Error('status unavailable'));
    renderEntry();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('ai-run-submit'));
    await user.click(await screen.findByTestId('provider-consent-approve'));

    expect(await screen.findByTestId('run-error')).toHaveTextContent('The model provider is unavailable. No provider request was started.');
    expect(screen.getByTestId('run-error')).not.toHaveTextContent('internal detail');
    expect(startAiRunMock).not.toHaveBeenCalled();
  });
});
