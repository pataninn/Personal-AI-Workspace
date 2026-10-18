import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { expect, test } from '@playwright/test';

import { LoginPage } from './pages/login-page';

test('validates the blank identifier in the browser before sending a request', async ({ page }) => {
  let loginRequests = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/auth/login') loginRequests += 1;
  });
  const login = new LoginPage(page);

  await login.open();
  await expect(login.identifier()).toHaveValue('');
  await expect(login.password()).toHaveValue('');
  await login.submit();

  await expect(login.identifierError()).toBeVisible();
  await expect(login.identifier()).toBeFocused();
  expect(loginRequests).toBe(0);
});

test('signs in with an identifier and shows the safe generic credential error', async ({ page }, testInfo) => {
  const login = new LoginPage(page);
  let submittedCredentials: unknown;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/auth/login') {
      submittedCredentials = request.postDataJSON();
    }
  });
  await login.open();
  await login.identifier().fill('owner');
  await login.password().fill('preview-e2e-only');
  await login.submit();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u);
  expect(submittedCredentials).toEqual({ identifier: 'owner', password: 'preview-e2e-only' });

  const successScreenshot = testInfo.outputPath('login-identifier-success.png');
  await mkdir(dirname(successScreenshot), { recursive: true });
  await page.screenshot({ path: successScreenshot, fullPage: true });

  await page.context().clearCookies();
  const errorPage = await page.context().newPage();
  const errorLogin = new LoginPage(errorPage);
  await errorPage.route('**/api/v1/auth/login', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({
        data: null,
        error: { code: 'INVALID_CREDENTIALS', message: 'The account identifier or password was not accepted.' }
      })
    });
  });
  await errorLogin.open();
  await errorLogin.identifier().fill('unknown-user');
  await errorLogin.password().fill('wrong-preview-password');
  await errorLogin.submit();

  await expect(errorLogin.serverError()).toHaveText('That account identifier or password was not accepted. Check both and try again.');
  await expect(errorLogin.identifier()).toHaveValue('unknown-user');
  const errorScreenshot = testInfo.outputPath('login-generic-credential-error.png');
  await mkdir(dirname(errorScreenshot), { recursive: true });
  await errorPage.screenshot({ path: errorScreenshot, fullPage: true });
});
