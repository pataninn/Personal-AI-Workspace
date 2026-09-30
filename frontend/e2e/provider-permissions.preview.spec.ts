import { expect, test } from '@playwright/test';

const PROJECT_ID = '873c096a-bc57-4a0c-85da-10d4febde96b';
const CONVERSATION_ID = '489541da-57a5-416d-afb6-45b19ad7bc98';
const OWNER_ID = '116cfd7c-e76f-4de4-bda1-001d6c3fbf16';
const PERMISSION_ID = 'ac8a4caa-5f69-4f65-aece-5c8d201f9a17';
const PROVIDER_PROFILE = 'nvidia-hosted-nim';
const MODEL = 'nvidia/nemotron-3-super-120b-a12b';

test('discloses a remembered permission, auto-uses its exact scope, then revokes it', async ({ page }) => {
  let permissions: Array<Record<string, unknown>> = [];
  let firstManifest: Record<string, unknown> | null = null;
  let createCount = 0;
  let decisionBody: Record<string, unknown> | null = null;
  let revokeHeaders: Record<string, string> | null = null;

  await page.route(`**/api/v1/projects/${PROJECT_ID}/provider-permissions**`, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { permissions }, error: null }) });
      return;
    }
    if (route.request().method() === 'DELETE') {
      revokeHeaders = await route.request().allHeaders();
      permissions = permissions.map((permission) => ({ ...permission, revokedAt: '2026-09-30T00:00:00.000Z' }));
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    await route.fallback();
  });

  await page.route(`**/api/v1/projects/${PROJECT_ID}/ai-runs`, async (route) => {
    createCount += 1;
    const previewResponse = await route.fetch();
    const payload = await previewResponse.json() as { data: { run: Record<string, unknown>; manifest: Record<string, unknown> } };
    if (createCount === 1) {
      firstManifest = payload.data.manifest;
      await route.fulfill({ response: previewResponse });
      return;
    }

    const runId = 'b7fa23e0-9a91-4b77-9c0c-7a310b40576f';
    const manifestHash = 'a'.repeat(64);
    const manifest = { ...firstManifest, runId, manifestHash };
    const run = {
      ...payload.data.run,
      runId,
      manifestHash,
      status: 'ready',
      phase: 'runtime',
      decision: 'approved',
      providerApprovalMode: 'remembered_permission',
      safeMessage: 'A matching project permission approved this request.'
    };
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ data: { run, manifest }, error: null }) });
  });

  await page.route('**/api/v1/ai-runs/*/egress-decision', async (route) => {
    decisionBody = route.request().postDataJSON() as Record<string, unknown>;
    if (decisionBody.rememberProviderPermission === true) {
      permissions = [{
        id: PERMISSION_ID,
        subject: { ownerId: OWNER_ID },
        projectId: PROJECT_ID,
        providerProfile: PROVIDER_PROFILE,
        model: MODEL,
        capability: 'send_selected_context',
        persistence: 'until_revoked',
        expiresAt: null,
        createdAt: '2026-09-30T00:00:00.000Z',
        revokedAt: null
      }];
    }
    await route.continue();
  });

  await page.goto('/login');
  await page.getByTestId('login-password-input').fill('preview-e2e-only');
  await page.getByTestId('login-submit-button').click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u);
  await page.goto(`/projects/${PROJECT_ID}/conversations/${CONVERSATION_ID}`);
  await expect(page.getByTestId('provider-permission-manager')).toBeVisible();
  await page.getByTestId('message-input').fill('Summarize the current project request.');
  await expect(page.getByTestId('ai-run-submit')).toBeEnabled();
  await page.getByTestId('ai-run-submit').click();
  const consent = page.getByTestId('provider-consent-alert-dialog');
  await expect(consent).toBeVisible();
  await expect(consent.getByTestId('provider-consent-sensitive-classification')).toContainText('Sensitive action');
  await expect(consent.getByText('Nothing has been sent to NVIDIA yet.')).toBeVisible();
  await expect(consent.getByTestId('provider-consent-remember-permission')).not.toBeChecked();
  await consent.getByTestId('provider-consent-remember-permission').check();
  await expect(consent.getByTestId('provider-consent-permission-scope')).toContainText('This project only');
  await expect(consent.getByTestId('provider-consent-permission-scope')).toContainText('Until revoked');
  await consent.getByTestId('provider-consent-approve').click();
  await expect(consent).toBeHidden();
  await expect.poll(() => decisionBody?.rememberProviderPermission).toBe(true);
  await expect(page.getByTestId('provider-permission-active-notice')).toContainText('Sensitive permission active');

  await page.getByTestId('ai-run-submit').click();
  await expect(page.getByTestId('provider-consent-alert-dialog')).toHaveCount(0);
  await expect(page.getByTestId('ai-run-remembered-permission-notice')).toContainText('saved project permission');
  expect(createCount).toBe(2);

  await page.getByTestId('provider-permission-manager-toggle').click();
  const permissionItem = page.getByTestId('provider-permission-item');
  await expect(permissionItem).toContainText(MODEL);
  await permissionItem.getByTestId('provider-permission-revoke').click();
  await expect(permissionItem).toContainText('Revoked');
  await expect.poll(() => revokeHeaders?.['x-csrf-token']).toBeTruthy();
  expect(revokeHeaders?.origin).toMatch(/^https?:\/\//u);
  await expect(page.getByTestId('provider-permission-revocation-note')).toContainText('cannot be recalled');
});
