import { expect, test } from '@playwright/test';

import { CONVERSATION_ID, PROJECT_ID, readRecord } from './project-chat-security-preview-data';
import { ProjectChatPreviewFixture, signInToProjectChat } from './project-chat-security-preview-fixture';

test('reports cancellation only after the saved run confirms it', async ({ page }, testInfo) => {
  const fixture = new ProjectChatPreviewFixture(page, 'cancellation');
  await fixture.install();
  try {
    await openConversation(page);
    await submitMessage(page, 'Cancel only after the server has saved the result.');
    await expect.poll(() => fixture.submissionsCreated.length).toBe(1);
    expect(fixture.starts).toEqual([]);
    await expect(page.getByTestId('ai-run-cancel')).toBeEnabled();

    const runId = fixture.createdRunIds[0] ?? '';
    expect(runId).not.toBe('');
    await page.getByTestId('ai-run-cancel').click();
    await expect(page.getByTestId('ai-run-cancel-status')).toContainText('Stopping assistant run');
    await assertReachableAcrossViewports(page, page.getByTestId('ai-run-cancel-status'));
    await expect(page.getByTestId('run-cancelled')).toHaveCount(0);
    expect(fixture.cancellations).toHaveLength(1);
    expect(fixture.cancellations[0]?.csrfToken).toBe('preview-only-csrf-token');
    expect(fixture.cancellations[0]?.idempotencyKey).toBeTruthy();
    await fixture.screenshot(testInfo, 'project-chat-cancellation-requested.png');

    fixture.confirmSavedCancellation(runId);
    await page.reload();
    await expect(page.getByTestId('run-cancelled')).toContainText('Run cancelled. No further assistant work will be applied.');
    await assertReachableAcrossViewports(page, page.getByTestId('run-cancelled').locator('p').first());
    expect(fixture.runReadStatuses).toContain('cancelled');
    expect(fixture.cancellations).toHaveLength(1);
    await fixture.screenshot(testInfo, 'project-chat-cancellation-confirmed.png');
    expect(fixture.unhandledApiCalls).toEqual([]);
    expect(fixture.evidence.blockedExternalRequests).toEqual([]);
  } finally {
    await fixture.saveEvidence(testInfo, 'run-cancellation');
  }
});

test('retries only a confirmed-not-sent synthetic run without consent and blocks a mismatched restored request', async ({ page }, testInfo) => {
  const fixture = new ProjectChatPreviewFixture(page, 'recovery');
  await fixture.install();
  try {
    await openConversation(page);
    const requestText = 'Review the project and return the result.';
    await submitMessage(page, requestText);
    await expect(page.getByTestId('ai-run-review-required')).toBeVisible();
    await expect(page.getByTestId('ai-run-safe-retry')).toBeEnabled();
    await assertReachableAcrossViewports(page, page.getByTestId('ai-run-review-refresh'));
    await assertReachableAcrossViewports(page, page.getByTestId('ai-run-safe-retry'));
    await expect(page.getByTestId('ai-run-separate-request')).toHaveCount(0);
    const originalRunId = new URL(page.url()).searchParams.get('runId') ?? '';
    expect(originalRunId).not.toBe('');

    await page.getByTestId('ai-run-safe-retry').click();
    await expect(page.getByTestId('provider-consent-alert-dialog')).toHaveCount(0);
    const retryRunId = new URL(page.url()).searchParams.get('runId') ?? '';
    expect(retryRunId).not.toBe('');
    expect(retryRunId).not.toBe(originalRunId);
    expect(fixture.submissionsCreated).toHaveLength(2);
    expect(fixture.submissionsCreated[0]?.idempotencyKey).not.toBe(fixture.submissionsCreated[1]?.idempotencyKey);
    expect(readRecord(fixture.submissionsCreated[0]?.body)?.request).toBe(requestText);
    expect(readRecord(fixture.submissionsCreated[1]?.body)?.request).toBe(requestText);
    expect(fixture.disclosedManifestHashes).toHaveLength(2);
    expect(new Set(fixture.disclosedManifestHashes).size).toBe(2);
    expect(fixture.starts).toEqual([]);
    await fixture.screenshot(testInfo, 'project-chat-safe-retry-fresh-disclosure.png');

    await expect(page.getByTestId('provider-consent-alert-dialog')).toHaveCount(0);
    await expect(page.getByTestId('ai-run-review-required')).toBeVisible();
    await expect(page.getByTestId('ai-run-safe-retry')).toHaveCount(0);
    await expect(page.getByTestId('ai-run-separate-request')).toBeVisible();
    await assertReachableAcrossViewports(page, page.getByTestId('ai-run-separate-request'));
    await page.getByTestId('ai-run-separate-request').click();
    const duplicateWarning = page.getByTestId('ai-run-duplicate-work-warning');
    await expect(duplicateWarning).toBeVisible();
    await expect(duplicateWarning).toContainText('The provider may already have received the earlier request');
    await fixture.screenshot(testInfo, 'project-chat-uncertain-outcome-warning.png');
    await duplicateWarning.getByRole('button', { name: 'Keep current run' }).click();
    expect(fixture.submissionsCreated).toHaveLength(2);

    fixture.appendLaterMessage('A later unrelated request from another open session.');
    await page.reload();
    await expect(page.getByTestId('ai-run-review-required')).toBeVisible();
    await expect(page.getByTestId('conversation-history').getByTestId('message-content').last()).toHaveText('A later unrelated request from another open session.');
    await expect(page.getByTestId('ai-run-restored-request-unavailable')).toContainText('cannot be safely matched to its original request');
    await expect(page.getByTestId('ai-run-restored-request-refresh')).toBeEnabled();
    await assertReachableAcrossViewports(page, page.getByTestId('ai-run-restored-request-refresh'));
    await expect(page.getByTestId('ai-run-safe-retry')).toHaveCount(0);
    await expect(page.getByTestId('ai-run-separate-request')).toHaveCount(0);
    await fixture.screenshot(testInfo, 'project-chat-restored-request-review-only.png');
    await page.getByTestId('ai-run-restored-request-refresh').click();
    await expect(page.getByTestId('ai-run-restored-request-unavailable')).toBeVisible();
    expect(fixture.submissionsCreated).toHaveLength(2);
    expect(fixture.starts).toEqual([]);
    expect(fixture.runReadStatuses).toContain('review_required');
    expect(fixture.decisions).toEqual([]);
    expect(fixture.apiRequests.some((entry) => entry.path.includes('/provider-permissions'))).toBe(false);
    expect(fixture.unhandledApiCalls).toEqual([]);
    expect(fixture.evidence.blockedExternalRequests).toEqual([]);
  } finally {
    await fixture.saveEvidence(testInfo, 'run-recovery');
  }
});

async function assertReachableAcrossViewports(page: import('@playwright/test').Page, control: import('@playwright/test').Locator): Promise<void> {
  const originalViewport = page.viewportSize() ?? { width: 1280, height: 720 };
  for (const viewport of [originalViewport, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await control.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
    await expect(control).toBeInViewport({ ratio: 1 });
    await control.focus();
  }
  await page.setViewportSize(originalViewport);
  await control.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
  await expect(control).toBeInViewport({ ratio: 1 });
}

async function openConversation(page: import('@playwright/test').Page): Promise<void> {
  await signInToProjectChat(page);
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u);
  await page.goto(`/projects/${PROJECT_ID}/conversations/${CONVERSATION_ID}`);
  await expect(page.getByRole('region', { name: 'Assistant policy summary' })).toBeVisible();
  await expect(page.getByTestId('message-input')).toBeEnabled();
}

async function submitMessage(page: import('@playwright/test').Page, message: string): Promise<void> {
  await page.getByTestId('message-input').fill(message);
  await page.getByTestId('ai-run-submit').click();
  await expect.poll(async () => page.getByTestId('ai-run-submit').isDisabled()).toBeTruthy();
  await expect(page.getByTestId('provider-consent-alert-dialog')).toHaveCount(0);
}
