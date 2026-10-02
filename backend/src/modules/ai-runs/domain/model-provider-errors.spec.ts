import { PROVIDER_TRUNCATED_MESSAGE, providerRejectionMessage, safeProviderFailureMessage } from '@/modules/ai-runs/domain/model-provider-errors';

describe('safe provider failure messages', () => {
  it('preserves actionable application-owned errors', () => {
    expect(safeProviderFailureMessage(PROVIDER_TRUNCATED_MESSAGE)).toBe(PROVIDER_TRUNCATED_MESSAGE);
    expect(safeProviderFailureMessage(providerRejectionMessage(401))).toContain('HTTP 401');
    expect(safeProviderFailureMessage('The NVIDIA provider returned an invalid response.')).toContain('could not validate');
  });

  it('does not save arbitrary runtime error text', () => {
    expect(safeProviderFailureMessage('token=secret-value raw provider body')).toBe('The assistant could not complete this run.');
  });
});
