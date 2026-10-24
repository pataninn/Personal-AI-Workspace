import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';

import { HomeChatPreviewApi } from './home-chat-preview-fixtures';
import { makeConversation, makeMessage, makeTurn } from './home-chat-preview-data';
import { captureScreenshot, openHomeAsk, signIn } from './home-chat-preview-test-utils';
import {
  ACCEPT_ITEM_ONE_ID,
  ACCEPT_ITEM_THREE_ID,
  ACCEPT_PROPOSAL_ID,
  ACTIVE_WORKSPACE_ID,
  ARCHIVED_WORKSPACE_ID,
  CONFLICT_RECEIPT_ID,
  DRAFT_ITEM_ONE_ID,
  DRAFT_ITEM_TWO_ID,
  DRAFT_PROPOSAL_ID,
  FIRST_UP_NEXT_TASK_ID,
  HOME_SUMMARY_CONVERSATION_ID,
  HOME_SUMMARY_MESSAGE_ID,
  HOME_SUMMARY_TURN_ID,
  HomePlanningRecordsPreviewApi,
  HomeSummariesPreviewApi,
  RETRY_RECEIPT_ID,
  SECOND_UP_NEXT_TASK_ID,
  savePreviewBrowserEvidence,
  setPreviewBrowserEvidenceMetadata,
  startPreviewBrowserEvidence
} from './home-summaries-preview-fixtures';

const summaryFixtureByPage = new WeakMap<Page, HomeSummariesPreviewApi>();
const planningFixtureByPage = new WeakMap<Page, HomePlanningRecordsPreviewApi>();
const homeFixtureByPage = new WeakMap<Page, HomeChatPreviewApi>();

test.beforeEach(async ({ page }) => startPreviewBrowserEvidence(page));

test.afterEach(async ({ page }, testInfo) => {
  const fixture = summaryFixtureByPage.get(page);
  if (fixture) await savePreviewBrowserEvidence(
    page,
    fixture,
    testInfo.title,
    testInfo,
    planningFixtureByPage.get(page),
    homeFixtureByPage.get(page)?.getBlockedExternalRequests()
  );
});

test('renders bounded Up next actions and complete active/archive workspace summaries', async ({ page }, testInfo) => {
  const homeApi = new HomeChatPreviewApi(page);
  await homeApi.install();
  homeFixtureByPage.set(page, homeApi);

  const summaries = new HomeSummariesPreviewApi(page);
  summaryFixtureByPage.set(page, summaries);
  await summaries.install();

  await signIn(page);

  const upNext = page.getByTestId('home-up-next-section');
  await expect(upNext.getByRole('heading', { name: 'Up next' })).toBeVisible();
  await expect(page.getByTestId(`home-up-next-task-${FIRST_UP_NEXT_TASK_ID}`)).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(page.getByTestId(`home-up-next-task-${SECOND_UP_NEXT_TASK_ID}`)).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(upNext.getByText('High', { exact: true })).toBeVisible();
  await expect(upNext.getByText('No deadline', { exact: true })).toBeVisible();
  await expect(upNext).not.toContainText(/\b\d+\s+tasks?\b/iu);

  await expect(page.getByTestId('home-add-task-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('home-view-all-tasks')).toHaveAttribute('href', '/tasks');
  await expect(page.getByTestId('home-inbox-count')).toHaveCount(0);

  const workspaces = page.getByTestId('home-workspace-list');
  await expect(workspaces.getByTestId(`home-workspace-link-${ACTIVE_WORKSPACE_ID}`)).toHaveAttribute('href', `/projects/${ACTIVE_WORKSPACE_ID}`);
  await expect(workspaces.getByTestId(`home-workspace-link-${ACTIVE_WORKSPACE_ID}`)).toContainText('Synthetic Planning Workspace');
  await expect(workspaces.getByTestId(`home-workspace-link-${ACTIVE_WORKSPACE_ID}`)).toContainText('Last active');

  const archived = workspaces.getByTestId(`home-workspace-link-${ARCHIVED_WORKSPACE_ID}`);
  await expect(archived).toHaveAttribute('href', `/projects/${ARCHIVED_WORKSPACE_ID}`);
  await expect(archived).toContainText('Archived');
  await expect(archived).toContainText('read only');
  await expect(archived).not.toContainText(/Last active|Updated/iu);

  expect(summaries.calls.overview).toEqual(['?taskLimit=6']);
  expect(summaries.calls.projectLists).toEqual(['?includeArchived=true']);
  expect(summaries.calls.inboxCount).toBe(0);

  await page.keyboard.press('Tab');
  setPreviewBrowserEvidenceMetadata(page, 'keyboardFocusAfterSummaryRender', await page.evaluate(() => ({
    activeElement: document.activeElement?.tagName ?? null,
    activeText: document.activeElement?.textContent?.trim().slice(0, 80) ?? null
  })));

  await captureScreenshot(page, testInfo, 'home-summaries-desktop.png');
  await page.setViewportSize({ width: 320, height: 780 });
  const mobileMetrics = await page.getByTestId('home-overview-widget').evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    pageClientWidth: document.documentElement.clientWidth,
    pageScrollWidth: document.documentElement.scrollWidth
  }));
  expect(mobileMetrics.scrollWidth).toBeLessThanOrEqual(mobileMetrics.clientWidth + 1);
  expect(mobileMetrics.pageScrollWidth).toBeLessThanOrEqual(mobileMetrics.pageClientWidth + 1);
  setPreviewBrowserEvidenceMetadata(page, 'mobile320Width', mobileMetrics);
  await captureScreenshot(page, testInfo, 'home-summaries-mobile-320.png');

  expect(homeApi.getBlockedExternalRequests()).toEqual([]);
});

test('keeps saved previews read-only while supported receipt undo stays available', async ({ page }, testInfo) => {
  const { homeApi, summaries, planning } = await installPlanningScenario(page);
  await signIn(page);
  await openHomeAsk(page, HOME_SUMMARY_CONVERSATION_ID);

  const draftCard = page.getByTestId('home-proposal-card-' + DRAFT_PROPOSAL_ID);
  await expect(draftCard).toContainText('Saved planning preview');
  await expect(draftCard).toContainText('read-only and cannot be applied or resumed');
  await expect(draftCard.getByTestId('home-proposal-item-' + DRAFT_ITEM_ONE_ID)).toContainText('Prepare release checklist');
  await expect(draftCard.getByTestId('home-proposal-item-' + DRAFT_ITEM_TWO_ID)).toContainText('Confirm reviewer availability');
  await expect(draftCard.getByRole('button')).toHaveCount(0);
  await expect(draftCard.getByRole('textbox')).toHaveCount(0);

  const legacyAccepted = page.getByTestId('home-proposal-card-' + ACCEPT_PROPOSAL_ID);
  await expect(legacyAccepted).toContainText('Legacy accepted · blocked');
  await expect(legacyAccepted).toContainText('Verify release handoff');
  await expect(legacyAccepted.getByRole('button')).toHaveCount(0);
  expect(planning.calls.retiredProposalMutationRequests).toBe(0);

  const conflictReceipt = page.getByTestId('home-receipt-card-' + CONFLICT_RECEIPT_ID);
  await expect(conflictReceipt).toContainText('Created task · Assistant');
  await expect(conflictReceipt).toContainText('Applied');
  await expect(conflictReceipt.getByTestId('home-receipt-target-' + CONFLICT_RECEIPT_ID)).toHaveText('Synthetic task with a changed version');
  await page.getByTestId('home-receipt-undo-' + CONFLICT_RECEIPT_ID).click();
  const conflict = page.getByTestId('home-receipt-undo-conflict-' + CONFLICT_RECEIPT_ID);
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText('changed after the action');
  expect(planning.calls.undoRequests).toHaveLength(1);
  expect(planning.calls.undoRequests[0]?.body).toEqual({});
  expect(planning.calls.undoRequests[0]?.idempotencyKey).toBeTruthy();

  const retryReceipt = page.getByTestId('home-receipt-card-' + RETRY_RECEIPT_ID);
  await expect(retryReceipt.getByTestId('home-receipt-target-' + RETRY_RECEIPT_ID)).toHaveText('Synthetic task with an uncertain undo');
  await page.getByTestId('home-receipt-undo-' + RETRY_RECEIPT_ID).click();
  await expect(page.getByTestId('home-receipt-retry-' + RETRY_RECEIPT_ID)).toBeVisible();
  await page.getByTestId('home-receipt-retry-' + RETRY_RECEIPT_ID).click();
  await expect(page.getByTestId('home-receipt-card-' + RETRY_RECEIPT_ID)).toContainText('Undo completed');
  const retryRequests = planning.calls.undoRequests.filter((request) => request.receiptId === RETRY_RECEIPT_ID);
  expect(retryRequests).toHaveLength(2);
  expect(retryRequests[1]?.idempotencyKey).toBe(retryRequests[0]?.idempotencyKey);
  await page.reload();
  await openHomeAsk(page, HOME_SUMMARY_CONVERSATION_ID);
  await expect(page.getByTestId('home-proposal-card-' + DRAFT_PROPOSAL_ID)).toContainText('Saved planning preview');
  await expect(page.getByTestId('home-proposal-card-' + ACCEPT_PROPOSAL_ID)).toContainText('Legacy accepted · blocked');
  await expect(page.getByTestId('home-receipt-card-' + RETRY_RECEIPT_ID)).toContainText('Undo completed');
  await expect.poll(() => planning.calls.proposalDetails.length).toBeGreaterThan(0);
  expect(planning.calls.retiredProposalMutationRequests).toBe(0);
  expect(summaries.calls.inboxCount).toBe(0);
  setPreviewBrowserEvidenceMetadata(page, 'proposalMutations', planning.calls.retiredProposalMutationRequests);
  setPreviewBrowserEvidenceMetadata(page, 'receiptUndoRetry', retryRequests);
  await captureScreenshot(page, testInfo, 'home-planning-read-only-preview-and-receipts.png');
  expect(homeApi.calls.retiredDecisionRequests).toBe(0);
  expect(homeApi.getBlockedExternalRequests()).toEqual([]);
});

test('shows saved proposal outcomes and receipts at mobile and zoom-equivalent sizes without retired actions', async ({ page, browser }, testInfo) => {
  const { homeApi, summaries, planning } = await installPlanningScenario(page, { includeInitialReceipts: false });
  await signIn(page);
  await openHomeAsk(page, HOME_SUMMARY_CONVERSATION_ID);

  const legacyAccepted = page.getByTestId('home-proposal-card-' + ACCEPT_PROPOSAL_ID);
  const savedItem = page.getByTestId('home-proposal-item-' + ACCEPT_ITEM_ONE_ID);
  await expect(legacyAccepted).toContainText('Legacy accepted · blocked');
  await expect(savedItem).toContainText('Prepare release checklist');
  await expect(savedItem).toContainText('Saved');
  const unknownItem = page.getByTestId('home-proposal-item-' + ACCEPT_ITEM_THREE_ID);
  await expect(unknownItem).toContainText('Needs review');
  await expect(legacyAccepted.getByRole('button')).toHaveCount(0);
  await expect(legacyAccepted.getByRole('textbox')).toHaveCount(0);
  expect(planning.calls.retiredProposalMutationRequests).toBe(0);

  await page.setViewportSize({ width: 320, height: 780 });
  const chat = page.getByTestId('home-chat');
  const mobileMetrics = await chat.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    pageClientWidth: document.documentElement.clientWidth,
    pageScrollWidth: document.documentElement.scrollWidth
  }));
  expect(mobileMetrics.scrollWidth).toBeLessThanOrEqual(mobileMetrics.clientWidth + 1);
  expect(mobileMetrics.pageScrollWidth).toBeLessThanOrEqual(mobileMetrics.pageClientWidth + 1);
  setPreviewBrowserEvidenceMetadata(page, 'mobile320Width', mobileMetrics);
  await captureScreenshot(page, testInfo, 'home-proposal-read-only-mobile-320.png');
  await verifyTwoHundredPercentEquivalent(browser, testInfo);
  expect(homeApi.calls.retiredDecisionRequests).toBe(0);
  expect(homeApi.getBlockedExternalRequests()).toEqual([]);
  expect(summaries.calls.overview.length).toBeGreaterThan(0);
});
async function installPlanningScenario(page: Page, options: { readonly includeInitialReceipts?: boolean } = {}): Promise<{
  readonly homeApi: HomeChatPreviewApi;
  readonly summaries: HomeSummariesPreviewApi;
  readonly planning: HomePlanningRecordsPreviewApi;
}> {
  const conversation = makeConversation(HOME_SUMMARY_CONVERSATION_ID, { kind: 'home' }, 'Saved release planning');
  const turn = makeTurn(HOME_SUMMARY_CONVERSATION_ID, HOME_SUMMARY_TURN_ID, 'completed');
  const message = makeMessage(HOME_SUMMARY_TURN_ID, HOME_SUMMARY_MESSAGE_ID, 'assistant', 'Synthetic saved planning results.');
  const homeApi = new HomeChatPreviewApi(page, { conversations: [conversation], turns: [turn], messages: [message] });
  await homeApi.install();
  homeFixtureByPage.set(page, homeApi);

  const summaries = new HomeSummariesPreviewApi(page);
  await summaries.install();
  summaryFixtureByPage.set(page, summaries);

  const planning = new HomePlanningRecordsPreviewApi(page, options);
  await planning.install();
  planningFixtureByPage.set(page, planning);
  return { homeApi, summaries, planning };
}

async function verifyTwoHundredPercentEquivalent(browser: Browser, testInfo: TestInfo): Promise<void> {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: { width: 640, height: 450 },
    deviceScaleFactor: 2
  });
  try {
    const page = await context.newPage();
    startPreviewBrowserEvidence(page);
    const { homeApi, summaries, planning } = await installPlanningScenario(page);
    await signIn(page);
    await openHomeAsk(page, HOME_SUMMARY_CONVERSATION_ID);
    const chat = page.getByTestId('home-chat');
    await expect(page.getByTestId(`home-receipt-target-${CONFLICT_RECEIPT_ID}`)).toBeVisible();
    const width = await chat.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(width.scrollWidth).toBeLessThanOrEqual(width.clientWidth + 1);
    setPreviewBrowserEvidenceMetadata(page, 'zoomEquivalentReflow', {
      referenceViewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
      viewport: await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio })),
      chat: width,
      limitation: '640x450 CSS viewport at deviceScaleFactor 2; this is a reflow simulation, not native browser zoom.'
    });
    await captureScreenshot(page, testInfo, 'home-planning-200-percent-equivalent.png');
    await savePreviewBrowserEvidence(page, summaries, 'home-planning-200-percent-equivalent', testInfo, planning, homeApi.getBlockedExternalRequests());
  } finally {
    await context.close();
  }
}
