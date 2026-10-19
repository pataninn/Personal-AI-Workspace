import { RuntimeCapabilityAdapter } from '@/infrastructure/assistant-policy/runtime-capability-adapter';

describe('RuntimeCapabilityAdapter', () => {
  it('fails closed when a runtime does not expose verified send admission', async () => {
    const adapter = new RuntimeCapabilityAdapter({});
    await expect(adapter.assess({ scopeKind: 'project', providerProfile: 'nvidia-hosted-nim', model: 'model-a' }))
      .resolves.toEqual({ available: false, reasonCode: 'runtime_unverified' });
  });

  it('asks the server-owned runtime for the exact configured provider/model and scope', async () => {
    const workspace = { supportsPolicyExecution: jest.fn(async () => true) };
    const home = { supportsPolicyExecution: jest.fn(async () => false) };
    const adapter = new RuntimeCapabilityAdapter(workspace, home);

    await expect(adapter.assess({ scopeKind: 'project', providerProfile: 'nvidia-hosted-nim', model: 'model-a' }))
      .resolves.toEqual({ available: true });
    await expect(adapter.assess({ scopeKind: 'home', providerProfile: 'nvidia-hosted-nim', model: 'model-a' }))
      .resolves.toEqual({ available: false, reasonCode: 'runtime_unverified' });
    expect(workspace.supportsPolicyExecution).toHaveBeenCalledWith({ providerProfile: 'nvidia-hosted-nim', model: 'model-a' });
    expect(home.supportsPolicyExecution).toHaveBeenCalledWith({ providerProfile: 'nvidia-hosted-nim', model: 'model-a' });
  });
});
