import { expect, test } from '@playwright/test';

import { HomeChatPreviewApi } from './home-chat-preview-fixtures';
import { makeConversation, makeEvent, makeMessage, makeTurn, SYNTHETIC_TIME, type SyntheticScope } from './home-chat-preview-data';
import { archivedWorkspace, captureScreenshot, fileBackedProject, installFixture, openHomeAsk, saveBrowserEvidence, setBrowserEvidenceMetadata, signIn, startBrowserEvidence } from './home-chat-preview-test-utils';

const HOME_CONVERSATION_ID = 'c3100000-0000-4000-8000-000000000010';
const SECOND_HOME_CONVERSATION_ID = 'c3100000-0000-4000-8000-000000000015';
const WORKSPACE_ID = 'c3100000-0000-4000-8000-000000000011';
const ARCHIVED_CONVERSATION_ID = 'c3100000-0000-4000-8000-000000000012';
const ACTIVE_TURN_ID = 'c3100000-0000-4000-8000-000000000013';
const SAVED_MESSAGE_ID = 'c3100000-0000-4000-8000-000000000014';
test.beforeEach(async ({ page }) => startBrowserEvidence(page));

test.afterEach(async ({ page }, testInfo) => {
  await saveBrowserEvidence(page, testInfo.title, testInfo.outputDir);
});

test('sends automatically from Home under an explicitly synthetic ready policy', async ({ page }, testInfo) => {
  const fixture = new HomeChatPreviewApi(page);
  await installFixture(page, fixture);
  await signIn(page);
  await openHomeAsk(page);

  const chat = page.getByTestId('home-chat');
  await expect(chat).toBeVisible();
  await expect(page.getByTestId('home-proposals-load-error')).toHaveCount(0);
  await expect(chat.getByRole('heading', { name: 'Assistant', exact: true })).toBeVisible();
  await expect(page.getByTestId('home-chat-policy-unavailable')).toHaveCount(0);

  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Help me plan the next release review.');
  await expect(composer).toBeFocused();
  await captureScreenshot(page, testInfo, 'home-chat-ready-policy-keyboard.png');
  await composer.press('Enter');

  await expect(page.getByTestId('home-chat-typing')).toBeVisible();
  await expect(composer).toHaveValue('');
  await expect(page.getByRole('dialog')).toBeVisible();
  await captureScreenshot(page, testInfo, 'home-chat-automatic-send-desktop.png');

  expect(fixture.calls.createRequests).toHaveLength(1);
  expect(fixture.calls.submitRequests).toHaveLength(1);
  expect(fixture.calls.createRequests[0]?.idempotencyKey).toBeTruthy();
  expect(fixture.calls.submitRequests[0]?.idempotencyKey).toBeTruthy();
  expect(fixture.calls.submitRequests[0]?.idempotencyKey).not.toBe(fixture.calls.createRequests[0]?.idempotencyKey);
  expect(fixture.calls.policyReads).toContain('home');
  expect(fixture.calls.retiredDecisionRequests).toBe(0);
  expect(fixture.getBlockedExternalRequests()).toEqual([]);

  await page.setViewportSize({ width: 320, height: 780 });
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
  await captureScreenshot(page, testInfo, 'home-chat-automatic-send-mobile-320.png');
});

test('opens Home Ask by keyboard and preserves history selection and drafts across close, navigation, and reopen', async ({ page }, testInfo) => {
  const first = makeConversation(HOME_CONVERSATION_ID, { kind: 'home' }, 'First synthetic conversation');
  const second = makeConversation(SECOND_HOME_CONVERSATION_ID, { kind: 'home' }, 'Second synthetic conversation');
  const fixture = new HomeChatPreviewApi(page, { conversations: [first, second] });
  await installFixture(page, fixture);
  const homeHistoryResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && url.pathname === '/api/v1/home/conversations' && url.searchParams.get('scope') === 'home';
  });
  await signIn(page);
  expect((await homeHistoryResponse).status()).toBe(200);

  const launcher = page.getByTestId('home-ask-launcher');
  await launcher.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const desktopBounds = await dialog.boundingBox();
  const desktopViewport = page.viewportSize();
  if (!desktopBounds || !desktopViewport) throw new Error('The desktop Ask dialog should fit the viewport.');
  expect(desktopBounds.x).toBeGreaterThanOrEqual(0);
  expect(desktopBounds.y).toBeGreaterThanOrEqual(0);
  expect(desktopBounds.width).toBeLessThanOrEqual(440);
  expect(desktopBounds.x + desktopBounds.width).toBeLessThanOrEqual(desktopViewport.width + 1);
  expect(desktopBounds.y + desktopBounds.height).toBeLessThanOrEqual(desktopViewport.height + 1);
  setBrowserEvidenceMetadata(page, 'askDesktopDialog', { viewport: desktopViewport, bounds: desktopBounds });
  await captureScreenshot(page, testInfo, 'home-ask-desktop-dialog.png');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(launcher).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });

  await launcher.focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  const input = page.getByRole('textbox', { name: 'Message' });
  await expect(input).toBeEnabled();
  const conversationTrigger = page.getByTestId('home-chat-conversation-trigger');
  await expect(conversationTrigger).toBeFocused();
  await input.fill('Draft for the first conversation.');

  await conversationTrigger.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.getByTestId(`home-chat-history-item-${SECOND_HOME_CONVERSATION_ID}`).click();
  await expect(conversationTrigger).toHaveAttribute('aria-label', 'Conversation: Second synthetic conversation');
  await expect(input).toHaveValue('');
  await input.fill('Draft for the second conversation.');

  await conversationTrigger.press('Enter');
  await page.getByTestId(`home-chat-history-item-${HOME_CONVERSATION_ID}`).click();
  await expect(conversationTrigger).toHaveAttribute('aria-label', 'Conversation: First synthetic conversation');
  await expect(input).toHaveValue('Draft for the first conversation.');

  await conversationTrigger.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(launcher).toBeFocused();

  await page.getByTestId('home-view-all-tasks').click();
  await expect(page).toHaveURL(/\/tasks$/u);
  await launcher.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Draft for the first conversation.');
  await expect(page.getByTestId('home-chat-conversation-trigger')).toHaveAttribute('aria-label', 'Conversation: First synthetic conversation');
  await expect(page.getByTestId('home-chat-send')).toBeVisible();

  const bounds = await page.getByRole('dialog').boundingBox();
  if (!bounds) throw new Error('The mobile Ask panel should have a measurable viewport box.');
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(391);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(845);
  const width = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(width.scroll).toBeLessThanOrEqual(width.client + 1);
  expect(fixture.calls.listQueries).toContainEqual({ scope: 'home', workspaceId: null });
  expect(fixture.getBlockedExternalRequests()).toEqual([]);
  setBrowserEvidenceMetadata(page, 'askMobileDialog', { viewport: { width: 390, height: 844 }, bounds, width, conversations: fixture.calls.listQueries });
  await captureScreenshot(page, testInfo, 'home-ask-mobile-history-navigation.png');
});

test('blocks sends when the policy reports an unavailable synthetic runtime', async ({ page }, testInfo) => {
  const fixture = new HomeChatPreviewApi(page, { policyState: 'unavailable' });
  await installFixture(page, fixture);
  await signIn(page);
  await openHomeAsk(page);

  await expect(page.getByTestId('home-chat-policy-unavailable')).toBeVisible();
  await expect(page.getByTestId('home-chat-policy-unavailable')).toContainText('Unable to connect');
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeDisabled();
  await expect(page.getByTestId('home-chat-send')).toBeDisabled();
  expect(fixture.calls.createRequests).toHaveLength(0);
  expect(fixture.calls.submitRequests).toHaveLength(0);
  expect(fixture.calls.retiredDecisionRequests).toBe(0);
  expect(fixture.getBlockedExternalRequests()).toEqual([]);
  await captureScreenshot(page, testInfo, 'home-chat-policy-unavailable.png');
});

test('fails closed when policy availability cannot be reached', async ({ page }, testInfo) => {
  const fixture = new HomeChatPreviewApi(page, { failPolicyReads: 1 });
  await installFixture(page, fixture);
  await signIn(page);
  await openHomeAsk(page);

  await expect(page.getByTestId('home-chat-policy-unavailable')).toContainText('Unable to connect');
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeDisabled();
  await expect(page.getByTestId('home-chat-send')).toBeDisabled();
  expect(fixture.calls.policyNetworkFailures).toBe(1);
  expect(fixture.calls.createRequests).toHaveLength(0);
  expect(fixture.calls.submitRequests).toHaveLength(0);
  expect(fixture.calls.retiredDecisionRequests).toBe(0);
  expect(fixture.getBlockedExternalRequests()).toEqual([]);
  await captureScreenshot(page, testInfo, 'home-chat-policy-network-error.png');
});

test('recovers history and retries an uncertain send with the same key before reloading saved history', async ({ page }, testInfo) => {
  const conversation = makeConversation(HOME_CONVERSATION_ID);
  const fixture = new HomeChatPreviewApi(page, { conversations: [conversation], failEventReads: 1, failTurnSubmissions: 1 });
  await installFixture(page, fixture);
  await signIn(page);
  await openHomeAsk(page, HOME_CONVERSATION_ID);
  const historyError = page.getByTestId('home-chat-history-error');
  await expect(historyError).toBeVisible();
  await historyError.getByRole('button', { name: 'Refresh history' }).click();
  await expect(page.getByTestId('home-chat-empty')).toBeVisible();

  const draft = 'Retry this saved conversation safely.';
  await page.getByRole('textbox', { name: 'Message' }).fill(draft);
  await page.getByTestId('home-chat-send').click();
  const uncertain = page.getByTestId('home-chat-send-error');
  await expect(uncertain).toBeVisible();
  await expect(uncertain.getByRole('button', { name: 'Retry same send' })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(draft);
  expect(fixture.calls.submitRequests).toHaveLength(1);

  await uncertain.getByRole('button', { name: 'Retry same send' }).click();
  await expect(page.getByTestId('home-chat-typing')).toBeVisible();
  expect(fixture.calls.submitRequests).toHaveLength(2);
  expect(fixture.calls.submitRequests[1]?.idempotencyKey).toBe(fixture.calls.submitRequests[0]?.idempotencyKey);
  expect(fixture.calls.submitRequests[1]?.body.message).toBe(fixture.calls.submitRequests[0]?.body.message);
  expect(fixture.calls.retiredDecisionRequests).toBe(0);
  await page.reload();
  await openHomeAsk(page);
  const savedMessage = page.getByText(draft, { exact: true });
  await expect(savedMessage).toBeVisible();
  await expect(savedMessage).toHaveCount(1);
  await captureScreenshot(page, testInfo, 'home-chat-reconnected-saved-history.png');
  expect(fixture.calls.submitRequests).toHaveLength(2);
  expect(fixture.getBlockedExternalRequests()).toEqual([]);
});

test('keeps a pending legacy consent turn read-only without runtime polling or decision posts', async ({ page }, testInfo) => {
  const conversation = makeConversation(HOME_CONVERSATION_ID);
  const turn = makeTurn(HOME_CONVERSATION_ID, ACTIVE_TURN_ID, 'pending');
  const message = makeMessage(ACTIVE_TURN_ID, SAVED_MESSAGE_ID, 'user', 'This request predates stored policy binding.');
  const fixture = new HomeChatPreviewApi(page, {
    conversations: [conversation],
    messages: [message],
    turns: [turn],
    events: [makeEvent(1, 'consent.requested', ACTIVE_TURN_ID, 'pending')]
  });
  await installFixture(page, fixture);
  await signIn(page);
  await openHomeAsk(page, HOME_CONVERSATION_ID);

  await expect(page.getByTestId('home-chat-legacy-blocked')).toContainText('This saved action cannot be resumed.');
  await expect(page.getByTestId('home-chat-messages')).toContainText('This request predates stored policy binding.');
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(fixture.calls.turnStatusReads).toBe(0);
  expect(fixture.calls.retiredDecisionRequests).toBe(0);
  expect(fixture.calls.submitRequests).toHaveLength(0);
  expect(fixture.getBlockedExternalRequests()).toEqual([]);
  await captureScreenshot(page, testInfo, 'home-chat-legacy-turn-blocked.png');
});
test('shows stopping until a status read confirms cancellation', async ({ page }, testInfo) => {
  const conversation = makeConversation(HOME_CONVERSATION_ID);
  const turn = makeTurn(HOME_CONVERSATION_ID, ACTIVE_TURN_ID, 'running');
  const message = makeMessage(ACTIVE_TURN_ID, SAVED_MESSAGE_ID, 'user', 'Stop the current planning turn.');
  const fixture = new HomeChatPreviewApi(page, {
    conversations: [conversation],
    messages: [message],
    turns: [turn],
    turnReadStatuses: []
  });
  await installFixture(page, fixture);
  await signIn(page);
  await openHomeAsk(page, HOME_CONVERSATION_ID);
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop response' }).click();
  const statusReadsBeforeCancel = fixture.calls.turnStatusReads;
  fixture.queueTurnStatuses(['cancel_requested', 'cancelled']);
  await expect(page.getByTestId('home-chat-typing')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check status' })).toBeVisible();
  expect(fixture.calls.cancellationRequests).toBe(1);

  await page.getByRole('button', { name: 'Check status' }).click();
  await expect(page.getByTestId('home-chat-typing')).toBeVisible();
  expect(fixture.calls.cancellationRequests).toBe(1);
  await page.getByRole('button', { name: 'Check status' }).click();
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
  expect(fixture.calls.cancellationRequests).toBe(1);
  expect(fixture.calls.turnStatusReads - statusReadsBeforeCancel).toBe(2);
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
  await openHomeAsk(page, HOME_CONVERSATION_ID);
  await expect(page.getByTestId('home-chat-typing')).toBeVisible();
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
  await expect(page.getByTestId('planning-chat-read-only')).toContainText('You can still read past conversations');
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
  await openHomeAsk(page, HOME_CONVERSATION_ID);
  const unknownStatus = page.getByTestId('home-chat-unknown-status');
  await expect(unknownStatus).toBeVisible();
  await unknownStatus.getByRole('button', { name: 'Check status' }).click();
  await expect(unknownStatus).toBeVisible();
  expect(fixture.calls.cancellationRequests).toBe(0);
  expect(fixture.calls.turnStatusReads).toBe(1);
  await captureScreenshot(page, testInfo, 'home-chat-unknown-status-refresh.png');
});
