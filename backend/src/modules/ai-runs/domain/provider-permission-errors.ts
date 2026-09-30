import { AiRunDomainError } from '@/modules/ai-runs/domain/ai-run-errors';

export class ProviderPermissionNotFoundError extends AiRunDomainError {
  public constructor() {
    super('PROVIDER_PERMISSION_NOT_FOUND', 404, 'The provider permission was not found.');
    this.name = 'ProviderPermissionNotFoundError';
  }
}
