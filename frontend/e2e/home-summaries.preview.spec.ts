import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';

import { HomeChatPreviewApi } from './home-chat-preview-fixtures';
import { makeConversation, makeMessage, makeTurn } from './home-chat-preview-data';
import { captureScreenshot, signIn } from './home-chat-preview-test-utils';
import {
  ACCEPT_ITEM_ONE_ID,
  ACCEPT_ITEM_THREE_ID,
  ACCEPT_PROPOSAL_ID,
  ACCEPT_RECEIPT_ONE_ID,
  ACCEPT_RECEIPT_TWO_ID,
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
  PARTIAL_UPDATE_ITEM_ID,
  STATUS_ONLY_UPDATE_ITEM_ID,
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

test('renders bounded Up next, canonical Inbox count, and complete active/archive workspace summaries', async ({ page }, testInfo) => {
  const homeApi = new HomeChatPreviewApi(page);
  await homeApi.install();
  homeFixtureByPage.set(page, homeApi);

  const summaries = new HomeSummariesPreviewApi(page);
  summaryFixtureByPage.set(page, summaries);
  await summaries.install();

  await signIn(page);

  const upNext = page.getByTestId('home-up-next-section');
  await expect(upNext.getByRole('heading', { name: 'Up next' })).toBeVisible();
  await expect(page.getByTestId(`home-up-next-task-${FIRST_UP_NEXT_TASK_ID}`)).toHaveAttribute('href', `/tasks/${FIRST_UP_NEXT_TASK_ID}`);
  await expect(page.getByTestId(`home-up-next-task-${SECOND_UP_NEXT_TASK_ID}`)).toHaveAttribute('href', `/tasks/${SECOND_UP_NEXT_TASK_ID}`);
  await expect(upNext.getByText('High', { exact: true })).toBeVisible();
  await expect(upNext.getByText('No deadline', { exact: true })).toBeVisible();
  await expect(upNext).not.toContainText(/\b\d+\s+tasks?\b/iu);

  await expect(page.getByTestId('home-inbox-count')).toHaveText('03');
  await expect(page.getByRole('link', { name: 'All tasks', exact: true })).toHaveAttribute('href', '/tasks');

  const workspaces = page.getByTestId('home-workspace-list');
  await expect(workspaces.getByTestId(`home-workspace-link-${ACTIVE_WORKSPACE_ID}`)).toHaveAttribute('href', `/projects/${ACTIVE_WORKSPACE_ID}`);
  await expect(workspaces.getByTestId(`home-workspace-link-${ACTIVE_WORKSPACE_ID}`)).toContainText('Planning workspace');
  await expect(workspaces.getByTestId(`home-workspace-link-${ACTIVE_WORKSPACE_ID}`)).toContainText('Last active');

  const archived = workspaces.getByTestId(`home-workspace-link-${ARCHIVED_WORKSPACE_ID}`);
  await expect(archived).toHaveAttribute('href', `/projects/${ARCHIVED_WORKSPACE_ID}`);
  await expect(archived).toContainText('Archived');
  await expect(archived).toContainText('read only');
  await expect(archived).not.toContainText(/Last active|Updated/iu);

  expect(summaries.calls.overview).toEqual(['?taskLimit=6']);
  expect(summaries.calls.projectLists).toEqual(['?includeArchived=true']);
  expect(summaries.calls.inboxCount).toBe(1);

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

test('reloads saved receipt and draft state, supports keyboard edits, and retains a specific undo conflict', async ({ page }, testInfo) => {
  const { homeApi, summaries, planning } = await installPlanningScenario(page);
  await signIn(page);
  await page.goto(`/dashboard?conversation=${HOME_SUMMARY_CONVERSATION_ID}`);

  const conflictReceipt = page.getByTestId(`home-receipt-card-${CONFLICT_RECEIPT_ID}`);
  await expect(conflictReceipt.getByTestId(`home-receipt-target-${CONFLICT_RECEIPT_ID}`)).toHaveText('Synthetic task with a changed version');
  const draftCard = page.getByTestId(`home-proposal-card-${DRAFT_PROPOSAL_ID}`);
  const draftItem = page.getByTestId(`home-proposal-item-${DRAFT_ITEM_ONE_ID}`);
  const titleInput = draftItem.getByTestId(`home-proposal-${DRAFT_ITEM_ONE_ID}-title`);
  await expect(titleInput).toHaveValue('Prepare release checklist');

  await titleInput.fill('Edited synthetic release checklist');
  const saveItem = page.getByTestId(`home-proposal-edit-${DRAFT_ITEM_ONE_ID}`);
  await saveItem.focus();
  await expect(saveItem).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => planning.calls.proposalEdits.length).toBe(1);
  await expect(draftItem).toContainText('Edited synthetic release checklist');

  const partialUpdateItem = page.getByTestId(`home-proposal-item-${PARTIAL_UPDATE_ITEM_ID}`);
  const partialDeadline = partialUpdateItem.getByTestId(`home-proposal-${PARTIAL_UPDATE_ITEM_ID}-deadline`);
  await expect(partialDeadline).toBeVisible();
  await expect(partialUpdateItem.getByTestId(`home-proposal-${PARTIAL_UPDATE_ITEM_ID}-status`)).toHaveCount(0);
  await partialDeadline.fill('2026-12-01');
  await page.getByTestId(`home-proposal-edit-${PARTIAL_UPDATE_ITEM_ID}`).click();
  await expect.poll(() => planning.calls.proposalEdits.length).toBe(2);
  expect(planning.calls.proposalEdits[1]).toEqual({
    proposalId: DRAFT_PROPOSAL_ID,
    itemId: PARTIAL_UPDATE_ITEM_ID,
    body: { expectedRevision: 2, changes: { deadline: '2026-12-01' } }
  });

  const statusOnlyItem = page.getByTestId(`home-proposal-item-${STATUS_ONLY_UPDATE_ITEM_ID}`);
  await expect(statusOnlyItem.getByTestId(`home-proposal-${STATUS_ONLY_UPDATE_ITEM_ID}-status`)).toBeVisible();
  await expect(statusOnlyItem.getByTestId(`home-proposal-${STATUS_ONLY_UPDATE_ITEM_ID}-title`)).toHaveCount(0);
  await expect(statusOnlyItem.getByTestId(`home-proposal-${STATUS_ONLY_UPDATE_ITEM_ID}-deadline`)).toHaveCount(0);
  await statusOnlyItem.getByTestId(`home-proposal-${STATUS_ONLY_UPDATE_ITEM_ID}-status`).selectOption('done');
  await page.getByTestId(`home-proposal-edit-${STATUS_ONLY_UPDATE_ITEM_ID}`).click();
  await expect.poll(() => planning.calls.proposalEdits.length).toBe(3);
  expect(planning.calls.proposalEdits[2]).toEqual({
    proposalId: DRAFT_PROPOSAL_ID,
    itemId: STATUS_ONLY_UPDATE_ITEM_ID,
    body: { expectedRevision: 3, changes: { status: 'done' } }
  });

  const removeItem = page.getByTestId(`home-proposal-remove-${DRAFT_ITEM_TWO_ID}`);
  await removeItem.focus();
  await expect(removeItem).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId(`home-proposal-item-${DRAFT_ITEM_TWO_ID}`)).toHaveCount(0);
  expect(planning.calls.proposalRemovals).toEqual([{ proposalId: DRAFT_PROPOSAL_ID, itemId: DRAFT_ITEM_TWO_ID, ifMatch: '"4"' }]);
  await expect(draftCard.getByTestId(`home-proposal-accept-${DRAFT_PROPOSAL_ID}`)).toBeEnabled();

  await page.reload();
  await expect(page.getByTestId(`home-proposal-item-${DRAFT_ITEM_ONE_ID}`)).toContainText('Edited synthetic release checklist');
  await expect(page.getByTestId(`home-proposal-item-${DRAFT_ITEM_TWO_ID}`)).toHaveCount(0);
  await expect(page.getByTestId(`home-proposal-${PARTIAL_UPDATE_ITEM_ID}-deadline`)).toHaveValue('2026-12-01');
  await expect(page.getByTestId(`home-proposal-${STATUS_ONLY_UPDATE_ITEM_ID}-status`)).toHaveValue('done');
  await expect(page.getByTestId(`home-receipt-target-${CONFLICT_RECEIPT_ID}`)).toHaveText('Synthetic task with a changed version');
  expect(planning.calls.receiptReads.filter((id) => id === CONFLICT_RECEIPT_ID).length).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId(`home-receipt-target-${RETRY_RECEIPT_ID}`)).toHaveText('Synthetic task with an uncertain undo');
  const summaryRefreshBeforeUndo = {
    overview: summaries.calls.overview.length,
    projectLists: summaries.calls.projectLists.length,
    inboxCount: summaries.calls.inboxCount
  };

  await page.getByTestId(`home-receipt-undo-${CONFLICT_RECEIPT_ID}`).click();
  const conflict = page.getByTestId(`home-receipt-undo-conflict-${CONFLICT_RECEIPT_ID}`);
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText('changed after the action');
  expect(planning.calls.undoRequests).toHaveLength(1);
  expect(planning.calls.undoRequests[0]?.body).toEqual({});
  expect(planning.calls.undoRequests[0]?.idempotencyKey).toBeTruthy();

  await page.getByTestId(`home-receipt-undo-${RETRY_RECEIPT_ID}`).click();
  await expect(page.getByTestId(`home-receipt-retry-${RETRY_RECEIPT_ID}`)).toBeVisible();
  await page.getByTestId(`home-receipt-retry-${RETRY_RECEIPT_ID}`).click();
  await expect(page.getByTestId(`home-receipt-card-${RETRY_RECEIPT_ID}`)).toContainText('Undo completed');
  const retryRequests = planning.calls.undoRequests.filter((request) => request.receiptId === RETRY_RECEIPT_ID);
  expect(retryRequests).toHaveLength(2);
  expect(retryRequests[0]?.body).toEqual({});
  expect(retryRequests[1]?.body).toEqual({});
  expect(retryRequests[1]?.idempotencyKey).toBe(retryRequests[0]?.idempotencyKey);
  await expect.poll(() => summaries.calls.overview.length).toBe(summaryRefreshBeforeUndo.overview + 1);
  await expect.poll(() => summaries.calls.projectLists.length).toBe(summaryRefreshBeforeUndo.projectLists + 1);
  await expect.poll(() => summaries.calls.inboxCount).toBe(summaryRefreshBeforeUndo.inboxCount + 1);

  setPreviewBrowserEvidenceMetadata(page, 'proposalEditKeyboard', {
    editRequests: planning.calls.proposalEdits,
    removeRequests: planning.calls.proposalRemovals
  });
  setPreviewBrowserEvidenceMetadata(page, 'undoConflict', planning.calls.undoRequests);
  setPreviewBrowserEvidenceMetadata(page, 'undoSameKeyRetry', retryRequests);
  await captureScreenshot(page, testInfo, 'home-planning-undo-conflict.png');
  expect(homeApi.getBlockedExternalRequests()).toEqual([]);
  expect(summaries.calls.overview.length).toBeGreaterThan(0);
});

test('accepts a synthetic proposal partially, exposes its unknown item, and refreshes each summary once for the receipt batch', async ({ page, browser }, testInfo) => {
  const { homeApi, summaries, planning } = await installPlanningScenario(page, { includeInitialReceipts: false });
  await signIn(page);
  await page.goto(`/dashboard?conversation=${HOME_SUMMARY_CONVERSATION_ID}`);

  await expect(page.getByTestId(`home-proposal-item-${ACCEPT_ITEM_ONE_ID}`)).toBeVisible();
  await expect(page.getByTestId(`home-proposal-item-${ACCEPT_ITEM_ONE_ID}`)).toContainText('Resolved date: 2026-11-12');
  await expect(page.getByTestId(`home-proposal-item-${ACCEPT_ITEM_ONE_ID}`)).toContainText('America/Los_Angeles');
  await expect.poll(() => summaries.calls.overview.length).toBe(2);
  await expect.poll(() => summaries.calls.projectLists.length).toBe(2);
  await expect.poll(() => summaries.calls.inboxCount).toBe(2);

  const beforeRefresh = {
    overview: summaries.calls.overview.length,
    projectLists: summaries.calls.projectLists.length,
    inboxCount: summaries.calls.inboxCount
  };
  await page.getByTestId(`home-proposal-accept-${ACCEPT_PROPOSAL_ID}`).click();
  await expect.poll(() => planning.calls.proposalAcceptances.length).toBe(1);
  expect(planning.calls.proposalAcceptances[0]?.body).toEqual({ expectedRevision: 1 });

  const acceptedProposal = page.getByTestId(`home-proposal-card-${ACCEPT_PROPOSAL_ID}`);
  await expect(acceptedProposal.getByText('Partially completed')).toBeVisible();
  await expect(page.getByTestId(`home-receipt-target-${ACCEPT_RECEIPT_ONE_ID}`)).toHaveText('Prepare release checklist');
  await expect(page.getByTestId(`home-receipt-target-${ACCEPT_RECEIPT_TWO_ID}`)).toHaveText('Verify release handoff');
  await expect(page.getByTestId(`home-proposal-item-outcome-${ACCEPT_ITEM_THREE_ID}`)).toContainText('Needs review');
  await expect(acceptedProposal.getByTestId(`home-proposal-resume-${ACCEPT_PROPOSAL_ID}`)).toBeEnabled();

  await expect.poll(() => summaries.calls.overview.length).toBe(beforeRefresh.overview + 1);
  await expect.poll(() => summaries.calls.projectLists.length).toBe(beforeRefresh.projectLists + 1);
  await expect.poll(() => summaries.calls.inboxCount).toBe(beforeRefresh.inboxCount + 1);
  expect(planning.calls.undoRequests).toEqual([]);
  expect(planning.calls.proposalResumes).toEqual([]);

  const chat = page.getByTestId('home-chat');
  await page.setViewportSize({ width: 320, height: 780 });
  const mobileMetrics = await chat.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    pageClientWidth: document.documentElement.clientWidth,
    pageScrollWidth: document.documentElement.scrollWidth
  }));
  expect(mobileMetrics.scrollWidth).toBeLessThanOrEqual(mobileMetrics.clientWidth + 1);
  expect(mobileMetrics.pageScrollWidth).toBeLessThanOrEqual(mobileMetrics.pageClientWidth + 1);
  setPreviewBrowserEvidenceMetadata(page, 'receiptBatchSummaryInvalidation', {
    before: beforeRefresh,
    after: { overview: summaries.calls.overview.length, projectLists: summaries.calls.projectLists.length, inboxCount: summaries.calls.inboxCount },
    events: planning.calls.eventCursors
  });
  setPreviewBrowserEvidenceMetadata(page, 'mobile320Width', mobileMetrics);
  await captureScreenshot(page, testInfo, 'home-proposal-partial-mobile-320.png');

  await verifyTwoHundredPercentEquivalent(browser, testInfo);
  expect(homeApi.getBlockedExternalRequests()).toEqual([]);
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
    baseURL: process.env.PAI_PREVIEW_BASE_URL ?? 'http://127.0.0.1:5173',
    viewport: { width: 640, height: 450 },
    deviceScaleFactor: 2
  });
  try {
    const page = await context.newPage();
    startPreviewBrowserEvidence(page);
    const { homeApi, summaries, planning } = await installPlanningScenario(page);
    await signIn(page);
    await page.goto(`/dashboard?conversation=${HOME_SUMMARY_CONVERSATION_ID}`);
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
