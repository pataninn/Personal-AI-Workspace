import type { Page } from '@playwright/test';

export class LoginPage {
  public constructor(private readonly page: Page) {}

  public async open(): Promise<void> {
    await this.page.goto('/login');
  }

  public identifier() {
    return this.page.getByLabel('Account identifier');
  }

  public password() {
    return this.page.getByLabel('Password', { exact: true });
  }

  public async submit(): Promise<void> {
    await this.page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }

  public identifierError() {
    return this.page.getByText('Enter your account identifier.', { exact: true });
  }

  public serverError() {
    return this.page.getByTestId('login-error-message');
  }
}
