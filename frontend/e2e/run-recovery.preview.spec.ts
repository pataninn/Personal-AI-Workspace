import { expect, test } from '@playwright/test';

import { CONVERSATION_ID, PROJECT_ID, readRecord } from './project-chat-security-preview-data';
import { ProjectChatPreviewFixture, signInToProjectChat } from './project-chat-security-preview-fixture';

test('reports cancellation only after the saved run confirms it', async ({ page }, testInfo) => {
  const fixture = new ProjectChatPreviewFixture(page, 'cancellation');
  await fixture.install();
  try {
    await openConversation(page);
    await approveMessage(page, 'Cancel only after the server has saved the result.');
    await expect.poll(() => fixture.starts.length).toBe(1);
    await expect(page.getByTestId('ai-run-cancel')).toBeEnabled();

    const runId = fixture.createdRunIds[0] ?? '';
    expect(runId).not.toBe('');
    await page.getByTestId('ai-run-cancel').click();
    await expect(page.getByTestId('ai-run-cancel-status')).toContainText('Stopping assistant run');
    await expect(page.getByTestId('run-cancelled')).toHaveCount(0);
    expect(fixture.cancellations).toHaveLength(1);
    expect(fixture.cancellations[0]?.csrfToken).toBe('preview-only-csrf-token');
    expect(fixture.cancellations[0]?.idempotencyKey).toBeTruthy();
    await fixture.screenshot(testInfo, 'project-chat-cancellation-requested.png');

    fixture.confirmSavedCancellation(runId);
    await page.reload();
    await expect(page.getByTestId('run-cancelled')).toContainText('Run cancelled. No further assistant work will be applied.');
    expect(fixture.runReadStatuses).toContain('cancelled');
    expect(fixture.cancellations).toHaveLength(1);
    await fixture.screenshot(testInfo, 'project-chat-cancellation-confirmed.png');
    expect(fixture.unhandledApiCalls).toEqual([]);
    expect(fixture.evidence.blockedExternalRequests).toEqual([]);
  } finally {
    await fixture.saveEvidence(testInfo, 'run-cancellation');
  }
});

test('allows live confirmed-not-sent retry with fresh consent and blocks a mismatched restored request', async ({ page }, testInfo) => {
  const fixture = new ProjectChatPreviewFixture(page, 'recovery');
  await fixture.install();
  try {
    await openConversation(page);
    const requestText = 'Review the project and return the result.';
    await approveMessage(page, requestText);
    await expect(page.getByTestId('ai-run-review-required')).toBeVisible();
    await expect(page.getByTestId('ai-run-safe-retry')).toBeEnabled();
    await expect(page.getByTestId('ai-run-separate-request')).toHaveCount(0);
    const originalRunId = new URL(page.url()).searchParams.get('runId') ?? '';
    expect(originalRunId).not.toBe('');

    await page.getByTestId('ai-run-safe-retry').click();
    const retryConsent = page.getByTestId('provider-consent-alert-dialog');
    await expect(retryConsent).toBeVisible();
    const retryRunId = new URL(page.url()).searchParams.get('runId') ?? '';
    expect(retryRunId).not.toBe('');
    expect(retryRunId).not.toBe(originalRunId);
    expect(fixture.submissionsCreated).toHaveLength(2);
    expect(fixture.submissionsCreated[0]?.idempotencyKey).not.toBe(fixture.submissionsCreated[1]?.idempotencyKey);
    expect(readRecord(fixture.submissionsCreated[0]?.body)?.request).toBe(requestText);
    expect(readRecord(fixture.submissionsCreated[1]?.body)?.request).toBe(requestText);
    expect(fixture.disclosedManifestHashes).toHaveLength(2);
    expect(new Set(fixture.disclosedManifestHashes).size).toBe(2);
    expect(fixture.starts).toHaveLength(1);
    await expect(retryConsent.getByTestId('provider-consent-manifest')).toContainText('Request included');
    await fixture.screenshot(testInfo, 'project-chat-safe-retry-fresh-disclosure.png');

    await retryConsent.getByTestId('provider-consent-approve').click();
    await expect(retryConsent).toBeHidden();
    await expect(page.getByTestId('ai-run-review-required')).toBeVisible();
    await expect(page.getByTestId('ai-run-safe-retry')).toHaveCount(0);
    await expect(page.getByTestId('ai-run-separate-request')).toBeVisible();
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
    await expect(page.getByTestId('ai-run-safe-retry')).toHaveCount(0);
    await expect(page.getByTestId('ai-run-separate-request')).toHaveCount(0);
    await fixture.screenshot(testInfo, 'project-chat-restored-request-review-only.png');
    await page.getByTestId('ai-run-restored-request-refresh').click();
    await expect(page.getByTestId('ai-run-restored-request-unavailable')).toBeVisible();
    expect(fixture.submissionsCreated).toHaveLength(2);
    expect(fixture.starts).toHaveLength(2);
    expect(fixture.runReadStatuses).toContain('review_required');
    expect(fixture.unhandledApiCalls).toEqual([]);
    expect(fixture.evidence.blockedExternalRequests).toEqual([]);
  } finally {
    await fixture.saveEvidence(testInfo, 'run-recovery');
  }
});

async function openConversation(page: import('@playwright/test').Page): Promise<void> {
  await signInToProjectChat(page);
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u);
  await page.goto(`/projects/${PROJECT_ID}/conversations/${CONVERSATION_ID}`);
  await expect(page.getByTestId('provider-permission-manager')).toBeVisible();
  await expect(page.getByTestId('message-input')).toBeEnabled();
}

async function approveMessage(page: import('@playwright/test').Page, message: string): Promise<void> {
  await page.getByTestId('message-input').fill(message);
  await page.getByTestId('ai-run-submit').click();
  const consent = page.getByTestId('provider-consent-alert-dialog');
  await expect(consent).toBeVisible();
  await expect(consent.getByTestId('provider-consent-approve')).toBeEnabled();
  await consent.getByTestId('provider-consent-approve').click();
  await expect(consent).toBeHidden();
}
