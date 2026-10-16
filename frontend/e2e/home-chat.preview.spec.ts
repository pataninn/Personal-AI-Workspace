import { expect, test } from '@playwright/test';

import { HomeChatPreviewApi } from './home-chat-preview-fixtures';
import { makeConversation, makeEvent, makeMessage, makeTurn, SYNTHETIC_TIME, type SyntheticScope } from './home-chat-preview-data';
import { approveByKeyboard, archivedWorkspace, captureScreenshot, fileBackedProject, installFixture, saveBrowserEvidence, setBrowserEvidenceMetadata, signIn, startBrowserEvidence } from './home-chat-preview-test-utils';

const HOME_CONVERSATION_ID = 'c3100000-0000-4000-8000-000000000010';
const WORKSPACE_ID = 'c3100000-0000-4000-8000-000000000011';
const ARCHIVED_CONVERSATION_ID = 'c3100000-0000-4000-8000-000000000012';
const ACTIVE_TURN_ID = 'c3100000-0000-4000-8000-000000000013';
const SAVED_MESSAGE_ID = 'c3100000-0000-4000-8000-000000000014';
test.beforeEach(async ({ page }) => startBrowserEvidence(page));

test.afterEach(async ({ page }, testInfo) => {
  await saveBrowserEvidence(page, testInfo.title, testInfo.outputDir);
});

test('sends from Home through keyboard consent and keeps dynamic results behind a separate disclosure', async ({ page, browser }, testInfo) => {
  const fixture = new HomeChatPreviewApi(page, { dynamicConsentAfterAllow: true });
  await installFixture(page, fixture);
  await signIn(page);
  const chat = page.getByTestId('home-chat');
  await expect(chat).toBeVisible();
  await expect(chat.getByRole('heading', { name: 'Ask the Home assistant' })).toBeVisible();

  const composer = page.getByRole('textbox', { name: 'Message the assistant' });
  await composer.fill('Help me plan the next release review.');
  await composer.press('Control+Enter');

  const initialConsent = page.getByRole('dialog', { name: 'Allow this turn?' });
  await expect(initialConsent).toBeVisible();
  await expect(initialConsent.getByText('NVIDIA hosted NIM')).toBeVisible();
  await expect(initialConsent.getByText('synthetic-planner-1')).toBeVisible();
  await expect(initialConsent.getByText('Home', { exact: true })).toBeVisible();
  await expect(initialConsent.getByText('Current message', { exact: true })).toBeVisible();
  await expect(initialConsent.getByText('Task metadata', { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, 'home-chat-first-send-consent.png');
  await approveByKeyboard(page, initialConsent, 'Allow this turn');

  const dynamicConsent = page.getByRole('dialog', { name: 'Share this result?' });
  await expect(dynamicConsent).toBeVisible();
  await expect(dynamicConsent.getByText('Task metadata', { exact: true })).toBeVisible();
  await expect(dynamicConsent.getByText('The requested task or workspace result is not shown here.')).toBeVisible();
  await expect(page.getByText('SYNTHETIC_PRIVATE_RESULT', { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, 'home-chat-dynamic-consent.png');
  await approveByKeyboard(page, dynamicConsent, 'Keep private');
  await expect(chat.getByText('Assistant is responding…', { exact: true }).first()).toBeVisible();
  await expect(composer).toHaveValue('');

  const calls = fixture.calls;
  expect(calls.createRequests).toHaveLength(1);
  expect(calls.submitRequests).toHaveLength(1);
  expect(calls.createRequests[0]?.idempotencyKey).toBeTruthy();
  expect(calls.submitRequests[0]?.idempotencyKey).toBeTruthy();
  expect(calls.submitRequests[0]?.idempotencyKey).not.toBe(calls.createRequests[0]?.idempotencyKey);
  expect(calls.consentDecisions.map((item) => item.body.decision)).toEqual(['allow', 'deny']);
  expect(calls.consentDecisions.map((item) => item.phase)).toEqual(['initial', 'tool_result']);
  expect(fixture.getBlockedExternalRequests()).toEqual([]);

  const nativeZoomBefore = await page.evaluate(() => ({ width: window.innerWidth, ratio: window.devicePixelRatio }));
  await page.keyboard.press('Control+Shift+Equal');
  await page.keyboard.press('Control+Shift+Equal');
  await page.keyboard.press('Control+Shift+Equal');
  await page.keyboard.press('Control+Shift+Equal');
  await page.keyboard.press('Control+Shift+Equal');
  const zoom = await page.evaluate(() => ({ width: window.innerWidth, ratio: window.devicePixelRatio }));
  setBrowserEvidenceMetadata(page, 'nativeBrowserZoomProbe', { shortcut: 'Control+Shift+Equal × 5', before: nativeZoomBefore, after: zoom, honored: zoom.ratio >= 1.9 || zoom.width <= 650 });
  await page.keyboard.press('Control+Digit0');

  await page.setViewportSize({ width: 320, height: 780 });
  const historySummary = page.getByText(/^History/u);
  await expect(historySummary).toBeVisible();
  await historySummary.click();
  await expect(page.getByTestId('home-chat-messages').getByText('Help me plan the next release review.', { exact: true })).toBeVisible();
  const chatWidth = await chat.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const overflowElements = [...element.querySelectorAll<HTMLElement>('*')].map((node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return {
        tagName: node.tagName,
        className: typeof node.className === 'string' ? node.className : '',
        client: node.clientWidth,
        scroll: node.scrollWidth,
        left: Math.round(rect.left - bounds.left),
        right: Math.round(rect.right - bounds.left),
        minWidth: style.minWidth,
        width: style.width
      };
    }).filter((node) => node.scroll > node.client + 1 || node.right > bounds.width + 1);
    return { client: element.clientWidth, scroll: element.scrollWidth, overflowElements };
  });
  expect(chatWidth.scroll).toBeLessThanOrEqual(chatWidth.client + 1);
  setBrowserEvidenceMetadata(page, 'mobileChatWidth', { viewport: 320, ...chatWidth });
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await captureScreenshot(page, testInfo, 'home-chat-mobile-320.png');

  const zoomContext = await browser.newContext({
    baseURL: process.env.PAI_PREVIEW_BASE_URL ?? 'http://127.0.0.1:5173',
    viewport: { width: 640, height: 450 },
    deviceScaleFactor: 2
  });
  try {
    const zoomPage = await zoomContext.newPage();
    startBrowserEvidence(zoomPage);
    const zoomFixture = new HomeChatPreviewApi(zoomPage);
    await installFixture(zoomPage, zoomFixture);
    await signIn(zoomPage);
    await zoomPage.evaluate(() => window.scrollTo({ top: 0 }));
    const zoomChat = zoomPage.getByTestId('home-chat');
    await expect(zoomChat).toBeVisible();
    const zoomMetrics = await zoomPage.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, ratio: window.devicePixelRatio }));
    const equivalentChatWidth = await zoomChat.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(zoomMetrics).toEqual({ width: 640, height: 450, ratio: 2 });
    expect(equivalentChatWidth.scroll).toBeLessThanOrEqual(equivalentChatWidth.client + 1);
    setBrowserEvidenceMetadata(zoomPage, 'zoomEquivalentReflow', {
      screenReference: { width: 1280, height: 900, deviceScaleFactor: 1 },
      viewport: zoomMetrics,
      chatWidth: equivalentChatWidth,
      limitation: 'Device-scale and viewport simulation only; native browser zoom was not honored by headless Chromium.'
    });
    await captureScreenshot(zoomPage, testInfo, 'home-chat-200-percent-equivalent.png');
    await saveBrowserEvidence(zoomPage, 'home-chat-200-percent-equivalent', testInfo.outputDir);
  } finally {
    await zoomContext.close();
  }
});

test('keeps a denied first message in history and the composer without provider egress', async ({ page }, testInfo) => {
  const fixture = new HomeChatPreviewApi(page);
  await installFixture(page, fixture);
  await signIn(page);
  const draft = 'Keep this planning note private.';
  await page.getByRole('textbox', { name: 'Message the assistant' }).fill(draft);
  await page.getByTestId('home-chat-send').click();
  const consent = page.getByRole('dialog', { name: 'Allow this turn?' });
  await expect(consent).toBeVisible();
  await consent.getByRole('button', { name: 'Keep private' }).click();
  await expect(page.getByText('Kept private. Your message remains in this conversation and in the composer.')).toBeVisible();
  await expect(page.getByText('Cancelled — kept private', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message the assistant' })).toHaveValue(draft);
  expect(fixture.calls.consentDecisions.map((item) => item.body.decision)).toEqual(['deny']);
  expect(fixture.getBlockedExternalRequests()).toEqual([]);
  await captureScreenshot(page, testInfo, 'home-chat-kept-private.png');
});

test('recovers history and retries an uncertain send with the same key before reloading saved history', async ({ page }, testInfo) => {
  const conversation = makeConversation(HOME_CONVERSATION_ID);
  const fixture = new HomeChatPreviewApi(page, { conversations: [conversation], failEventReads: 2, failTurnSubmissions: 1 });
  await installFixture(page, fixture);
  await signIn(page);
  await page.goto(`/dashboard?conversation=${HOME_CONVERSATION_ID}`);
  const historyError = page.getByTestId('home-chat-history-error');
  await expect(historyError).toBeVisible();
  await historyError.getByRole('button', { name: 'Refresh history' }).click();
  await expect(page.getByTestId('home-chat-empty')).toBeVisible();

  const draft = 'Retry this saved conversation safely.';
  await page.getByRole('textbox', { name: 'Message the assistant' }).fill(draft);
  await page.getByTestId('home-chat-send').click();
  const uncertain = page.getByTestId('home-chat-send-error');
  await expect(uncertain).toBeVisible();
  await expect(uncertain.getByRole('button', { name: 'Retry same send' })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Message the assistant' })).toHaveValue(draft);
  expect(fixture.calls.submitRequests).toHaveLength(1);

  await uncertain.getByRole('button', { name: 'Retry same send' }).click();
  await expect(page.getByRole('dialog', { name: 'Allow this turn?' })).toBeVisible();
  expect(fixture.calls.submitRequests).toHaveLength(2);
  expect(fixture.calls.submitRequests[1]?.idempotencyKey).toBe(fixture.calls.submitRequests[0]?.idempotencyKey);
  expect(fixture.calls.submitRequests[1]?.body.message).toBe(fixture.calls.submitRequests[0]?.body.message);
  await page.getByRole('dialog', { name: 'Allow this turn?' }).getByRole('button', { name: 'Keep private' }).click();
  await expect(page.getByText('Cancelled — kept private', { exact: true })).toBeVisible();
  await page.reload();
  const savedMessage = page.getByText(draft, { exact: true });
  await expect(savedMessage).toBeVisible();
  await expect(savedMessage).toHaveCount(1);
  await captureScreenshot(page, testInfo, 'home-chat-reconnected-saved-history.png');
  expect(fixture.calls.submitRequests).toHaveLength(2);
  expect(fixture.getBlockedExternalRequests()).toEqual([]);
});

test('shows stopping until a status read confirms cancellation', async ({ page }, testInfo) => {
  const conversation = makeConversation(HOME_CONVERSATION_ID);
  const turn = makeTurn(HOME_CONVERSATION_ID, ACTIVE_TURN_ID, 'running');
  const message = makeMessage(ACTIVE_TURN_ID, SAVED_MESSAGE_ID, 'user', 'Stop the current planning turn.');
  const fixture = new HomeChatPreviewApi(page, {
    conversations: [conversation],
    messages: [message],
    turns: [turn],
    turnReadStatuses: ['cancel_requested', 'cancelled']
  });
  await installFixture(page, fixture);
  await signIn(page);
  await page.goto(`/dashboard?conversation=${HOME_CONVERSATION_ID}`);
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(page.getByText('Stopping…', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check status' })).toBeVisible();
  expect(fixture.calls.cancellationRequests).toBe(1);

  await page.getByRole('button', { name: 'Check status' }).click();
  await expect(page.getByText('Stopping…', { exact: true }).first()).toBeVisible();
  expect(fixture.calls.cancellationRequests).toBe(1);
  await page.getByRole('button', { name: 'Check status' }).click();
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
  expect(fixture.calls.cancellationRequests).toBe(1);
  expect(fixture.calls.turnStatusReads).toBe(2);
  await captureScreenshot(page, testInfo, 'home-chat-cancellation-confirmed.png');
});

test('keeps an interrupted cancel request as stopping until reconciliation reports unknown', async ({ page }, testInfo) => {
  const conversation = makeConversation(HOME_CONVERSATION_ID);
  const turn = makeTurn(HOME_CONVERSATION_ID, ACTIVE_TURN_ID, 'cancel_requested');
  const message = makeMessage(ACTIVE_TURN_ID, SAVED_MESSAGE_ID, 'user', 'Recover an interrupted planning turn.');
  const fixture = new HomeChatPreviewApi(page, {
    conversations: [conversation],
    messages: [message],
    turns: [turn],
    events: [makeEvent(1, 'turn.status_changed', ACTIVE_TURN_ID, 'cancel_requested')],
    turnReadStatuses: ['unknown']
  });
  await installFixture(page, fixture);
  await signIn(page);
  await page.goto(`/dashboard?conversation=${HOME_CONVERSATION_ID}`);
  await expect(page.getByTestId('home-chat-messages').getByText('Stopping…', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Check status' }).click();
  await expect(page.getByTestId('home-chat-unknown-status')).toBeVisible();
  await expect(page.getByTestId('home-chat-unknown-status')).toContainText('This response stopped before its result was confirmed.');
  expect(fixture.calls.cancellationRequests).toBe(0);
  expect(fixture.calls.turnStatusReads).toBe(1);
  await captureScreenshot(page, testInfo, 'home-chat-cancellation-needs-review.png');
});

test('keeps archived rootless chat read-only and redirects file-backed planning-chat URLs', async ({ page }, testInfo) => {
  const workspaceScope: SyntheticScope = { kind: 'workspace', workspaceId: WORKSPACE_ID };
  const conversation = makeConversation(ARCHIVED_CONVERSATION_ID, workspaceScope, 'Archived planning thread');
  const turn = makeTurn(ARCHIVED_CONVERSATION_ID, ACTIVE_TURN_ID, 'completed');
  const message = makeMessage(ACTIVE_TURN_ID, SAVED_MESSAGE_ID, 'assistant', 'The saved planning notes are available to read.');
  const fixture = new HomeChatPreviewApi(page, { scope: workspaceScope, conversations: [conversation], turns: [turn], messages: [message] });
  await installFixture(page, fixture);
  await page.route('**/api/v1/projects/**', async (route) => {
    const url = new URL(route.request().url());
    const project = url.pathname.endsWith('/file-backed-id') ? fileBackedProject(SYNTHETIC_TIME) : archivedWorkspace(WORKSPACE_ID, SYNTHETIC_TIME);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: project, error: null }) });
  });
  await signIn(page);
  await page.goto(`/projects/${WORKSPACE_ID}/planning-chat?conversation=${ARCHIVED_CONVERSATION_ID}`);
  const planningChat = page.getByTestId('planning-chat');
  await expect(planningChat).toBeVisible();
  await expect(planningChat.getByText('Planning workspace', { exact: true })).toBeVisible();
  await expect(page.getByText('The saved planning notes are available to read.')).toBeVisible();
  await expect(page.getByTestId('planning-chat-read-only')).toContainText('conversation history is read-only');
  await expect(page.getByRole('textbox', { name: 'Message the assistant' })).toBeDisabled();
  await expect(page.getByTestId('home-chat-send')).toBeDisabled();
  expect(fixture.calls.listQueries.some((query) => query.scope === 'workspace' && query.workspaceId === WORKSPACE_ID)).toBeTruthy();
  await captureScreenshot(page, testInfo, 'workspace-planning-chat-archived.png');

  await page.goto('/projects/file-backed-id/planning-chat');
  await expect(page).toHaveURL(/\/projects\/file-backed-id$/u);
});

test('refreshes an unknown turn without repeating cancellation', async ({ page }, testInfo) => {
  const conversation = makeConversation(HOME_CONVERSATION_ID);
  const turn = makeTurn(HOME_CONVERSATION_ID, ACTIVE_TURN_ID, 'unknown');
  const message = makeMessage(ACTIVE_TURN_ID, SAVED_MESSAGE_ID, 'user', 'Check an uncertain response.');
  const fixture = new HomeChatPreviewApi(page, {
    conversations: [conversation],
    messages: [message],
    turns: [turn],
    events: [makeEvent(1, 'turn.status_changed', ACTIVE_TURN_ID, 'unknown')],
    turnReadStatuses: ['unknown']
  });
  await installFixture(page, fixture);
  await signIn(page);
  await page.goto(`/dashboard?conversation=${HOME_CONVERSATION_ID}`);
  const unknownStatus = page.getByTestId('home-chat-unknown-status');
  await expect(unknownStatus).toBeVisible();
  await unknownStatus.getByRole('button', { name: 'Check status' }).click();
  await expect(unknownStatus).toBeVisible();
  expect(fixture.calls.cancellationRequests).toBe(0);
  expect(fixture.calls.turnStatusReads).toBe(1);
  await captureScreenshot(page, testInfo, 'home-chat-unknown-status-refresh.png');
});
