import { expect, test } from '@playwright/test';

import { CONVERSATION_ID, PROJECT_ID } from './project-chat-security-preview-data';
import { ProjectChatPreviewFixture, signInToProjectChat } from './project-chat-security-preview-fixture';

test('keeps a ready synthetic policy unobtrusive and submits without a permission or decision step', async ({ page }, testInfo) => {
  const fixture = new ProjectChatPreviewFixture(page, 'policy');
  await fixture.install();
  try {
    await openConversation(page);
    await expect(page.getByTestId('assistant-policy-readiness')).toHaveCount(0);
    await expect(page.getByTestId('provider-permission-manager')).toHaveCount(0);
    await expect(page.getByTestId('provider-consent-alert-dialog')).toHaveCount(0);
    await page.getByTestId('ai-run-submit').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('message-input')).toBeInViewport();
    await expect(page.getByTestId('ai-run-submit')).toBeInViewport();
    await fixture.screenshot(testInfo, 'workspace-policy-summary-desktop.png');

    const desktopViewport = page.viewportSize() ?? { width: 1280, height: 720 };
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileWidths = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
    expect(mobileWidths.document).toBeLessThanOrEqual(mobileWidths.viewport);
    await page.getByTestId('message-input').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('message-input')).toBeInViewport();
    await fixture.screenshot(testInfo, 'workspace-policy-summary-mobile.png');

    const request = 'Use the current workspace policy for this preview-only request.';
    const messageInput = page.getByTestId('message-input');
    await messageInput.fill(request);
    await messageInput.focus();
    await page.keyboard.press('Control+Enter');
    await expect.poll(() => fixture.submissionsCreated.length).toBe(1);
    await expect(page.getByTestId('provider-consent-alert-dialog')).toHaveCount(0);

    const submitted = fixture.submissionsCreated[0];
    expect(submitted?.path).toBe(`/api/v1/projects/${PROJECT_ID}/chat-runs`);
    expect(submitted?.csrfToken).toBe('preview-only-csrf-token');
    expect(submitted?.idempotencyKey).toBeTruthy();
    expect(submitted?.body).toMatchObject({ conversationId: CONVERSATION_ID, request });
    expect(fixture.policyReads.length).toBeGreaterThan(0);
    expect(fixture.starts).toEqual([]);
    expect(fixture.decisions).toEqual([]);
    expect(fixture.apiRequests.some((entry) => entry.path.includes('/provider-permissions'))).toBe(false);
    expect(fixture.evidence.blockedExternalRequests).toEqual([]);
    expect(fixture.unhandledApiCalls).toEqual([]);
    await fixture.screenshot(testInfo, 'workspace-policy-automatic-submit.png');
    await page.setViewportSize(desktopViewport);
  } finally {
    await fixture.saveEvidence(testInfo, 'workspace-policy-automatic');
  }
});

test('keeps the composer disabled when the synthetic runtime is unverified', async ({ page }, testInfo) => {
  const fixture = new ProjectChatPreviewFixture(page, 'policy-unavailable');
  await fixture.install();
  try {
    await openConversation(page);
    await expect(page.getByTestId('assistant-policy-readiness')).toHaveText('Assistant is temporarily unavailable. Try again shortly.');
    const draft = 'Keep this draft while the runtime is unavailable.';
    await page.getByTestId('message-input').fill(draft);
    await expect(page.getByTestId('ai-run-submit')).toBeDisabled();
    await expect(page.getByTestId('message-input')).toHaveValue(draft);
    expect(fixture.submissionsCreated).toEqual([]);
    expect(fixture.starts).toEqual([]);
    expect(fixture.decisions).toEqual([]);
    expect(fixture.evidence.blockedExternalRequests).toEqual([]);
    await fixture.screenshot(testInfo, 'workspace-policy-runtime-unavailable.png');
  } finally {
    await fixture.saveEvidence(testInfo, 'workspace-policy-runtime-unavailable');
  }
});

async function openConversation(page: import('@playwright/test').Page): Promise<void> {
  await signInToProjectChat(page);
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u);
  await page.goto(`/projects/${PROJECT_ID}/conversations/${CONVERSATION_ID}`);
  await expect(page.getByTestId('message-input')).toBeEnabled();
}
