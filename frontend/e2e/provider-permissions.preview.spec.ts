import { expect, test } from '@playwright/test';

import { CONVERSATION_ID, MODEL, PERMISSION_ID, PROJECT_ID, PROVIDER_PROFILE, readRecord } from './project-chat-security-preview-data';
import { ProjectChatPreviewFixture, signInToProjectChat } from './project-chat-security-preview-fixture';

test('denies without starting, remembers only the exact project grant, and requests consent again after revocation', async ({ page }, testInfo) => {
  const fixture = new ProjectChatPreviewFixture(page, 'permissions');
  await fixture.install();
  try {
    await openConversation(page);
    await page.getByTestId('message-input').fill('Keep this first request local.');
    await page.getByTestId('ai-run-submit').click();

    const firstConsent = page.getByTestId('provider-consent-alert-dialog');
    await expect(firstConsent).toBeVisible();
    await expect(firstConsent.getByTestId('provider-consent-manifest')).toContainText(MODEL);
    await expect(firstConsent.getByTestId('provider-consent-no-staging-notice')).toContainText('Nothing has been sent to NVIDIA hosted NIM yet.');
    await expect(firstConsent.getByTestId('provider-consent-remember')).not.toBeChecked();
    expect(fixture.starts).toHaveLength(0);
    await fixture.screenshot(testInfo, 'project-chat-pending-consent.png');
    const desktopViewport = page.viewportSize() ?? { width: 1280, height: 720 };
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileWidths = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
    expect(mobileWidths.document).toBeLessThanOrEqual(mobileWidths.viewport);
    await expect(firstConsent.getByTestId('provider-consent-reject')).toBeVisible();
    await expect(firstConsent.getByTestId('provider-consent-approve')).toBeVisible();
    await fixture.screenshot(testInfo, 'project-chat-mobile-consent.png');

    await page.setViewportSize(desktopViewport);
    await firstConsent.getByTestId('provider-consent-reject').focus();
    await page.keyboard.press('Enter');
    await expect(firstConsent).toBeHidden();
    await expect(page.getByTestId('message-input')).toHaveValue('Keep this first request local.');
    await expect(page.getByTestId('conversation-history').getByTestId('message-item')).toHaveCount(1);
    await expect(page.getByTestId('conversation-history').getByTestId('message-content')).toHaveText('Keep this first request local.');
    expect(fixture.starts).toHaveLength(0);
    expect(readRecord(fixture.decisions[0]?.body)?.decision).toBe('reject');
    await fixture.screenshot(testInfo, 'project-chat-denied-draft-retained.png');

    await page.getByTestId('message-input').fill('Approve this separate request for the project.');
    await page.getByTestId('ai-run-submit').click();
    const rememberedConsent = page.getByTestId('provider-consent-alert-dialog');
    await expect(rememberedConsent).toBeVisible();
    await expect(rememberedConsent.getByTestId('provider-consent-remember')).not.toBeChecked();
    expect(fixture.starts).toHaveLength(0);
    await rememberedConsent.getByTestId('provider-consent-remember').check();
    await expect(rememberedConsent.getByTestId('provider-consent-permission-scope')).toContainText('This project only');
    await expect(rememberedConsent.getByTestId('provider-consent-permission-scope')).toContainText('Until revoked');
    await fixture.screenshot(testInfo, 'project-chat-exact-permission-scope.png');
    await rememberedConsent.getByTestId('provider-consent-approve').click();
    await expect(rememberedConsent).toBeHidden();
    await expect(page.getByTestId('provider-permission-active-notice')).toBeVisible();
    await expect.poll(() => fixture.starts.length).toBe(1);
    const grant = readRecord(fixture.decisions[1]?.body);
    expect(grant?.decision).toBe('approve');
    expect(grant?.rememberProviderPermission).toBe(true);

    await page.getByTestId('message-input').fill('Use the exact saved permission for this request.');
    await page.getByTestId('ai-run-submit').click();
    await expect(page.getByTestId('provider-consent-alert-dialog')).toHaveCount(0);
    await expect(page.getByTestId('ai-run-remembered-permission-notice')).toContainText('Using saved provider permission');
    await expect.poll(() => fixture.starts.length).toBe(2);
    expect(fixture.createdRunIds).toHaveLength(3);

    await page.getByTestId('provider-permission-manager-toggle').click();
    const permissionItem = page.getByTestId('provider-permission-item');
    await expect(permissionItem).toContainText(MODEL);
    await permissionItem.getByTestId('provider-permission-revoke').click();
    await expect(permissionItem).toContainText('Revoked');
    const permissionPath = `/api/v1/projects/${PROJECT_ID}/provider-permissions`;
    const deletePath = `${permissionPath}/${PERMISSION_ID}`;
    const deleteResponseIndex = fixture.evidence.lifecycle.findIndex((entry) => entry.step === 'response'
      && entry.method === 'DELETE' && entry.path === deletePath && entry.status === 204);
    const refreshedPermissionIndex = fixture.evidence.lifecycle.findIndex((entry, index) => index > deleteResponseIndex
      && entry.step === 'response' && entry.method === 'GET' && entry.path === permissionPath && entry.status === 200);
    expect(deleteResponseIndex).toBeGreaterThan(-1);
    expect(refreshedPermissionIndex).toBeGreaterThan(deleteResponseIndex);
    expect(fixture.providerPermissionsRevoked).toHaveLength(1);

    await page.getByTestId('message-input').fill('Ask me again after the grant is revoked.');
    await page.getByTestId('ai-run-submit').click();
    const revokedConsent = page.getByTestId('provider-consent-alert-dialog');
    await expect(revokedConsent).toBeVisible();
    expect(fixture.starts).toHaveLength(2);
    await fixture.screenshot(testInfo, 'project-chat-consent-after-revocation.png');
    await revokedConsent.getByTestId('provider-consent-reject').click();
    await expect(revokedConsent).toBeHidden();
    expect(fixture.starts).toHaveLength(2);

    expect(fixture.submissionsCreated).toHaveLength(4);
    expect(fixture.submissionsCreated.every((request) => request.path === `/api/v1/projects/${PROJECT_ID}/chat-runs`
      && request.csrfToken === 'preview-only-csrf-token' && Boolean(request.idempotencyKey)
      && readRecord(request.body)?.conversationId === CONVERSATION_ID)).toBe(true);
    expect(new Set(fixture.submissionsCreated.map((request) => request.idempotencyKey)).size).toBe(4);
    expect(fixture.unhandledApiCalls).toEqual([]);
    expect(fixture.evidence.blockedExternalRequests).toEqual([]);
  } finally {
    await fixture.saveEvidence(testInfo, 'provider-permissions');
  }
});

async function openConversation(page: import('@playwright/test').Page): Promise<void> {
  await signInToProjectChat(page);
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u);
  await page.goto(`/projects/${PROJECT_ID}/conversations/${CONVERSATION_ID}`);
  await expect(page.getByTestId('provider-permission-manager')).toBeVisible();
  await expect(page.getByTestId('message-input')).toBeEnabled();
  await expect(page.getByTestId('ai-run-submit')).toBeDisabled();
}
