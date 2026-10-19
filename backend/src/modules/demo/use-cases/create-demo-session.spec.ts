import { DemoAdmissionUnavailableError, DemoProvisioningFailedError } from '@/modules/demo/domain/demo-admission-errors';
import type { DemoAbuseLimitValues, IDemoAdmissionRepository, IDemoStorageBootstrap } from '@/modules/demo/domain/demo-admission-types';
import type { IOpaqueTokenProvider } from '@/modules/auth/repositories/security-providers';
import { CreateDemoSessionUseCase, deriveNetworkIdentity, digestIdempotencyKey } from '@/modules/demo/use-cases/create-demo-session';

const OWNER_ID = 'd3330000-0000-4000-8000-000000000001';
const ADMISSION_ID = 'd3330000-0000-4000-8000-000000000002';
const key = Buffer.alloc(32, 11).toString('base64url');
const limits: DemoAbuseLimitValues = {
  globalAdmissionMax: 10, globalAdmissionWindowSeconds: 3600,
  networkAdmissionMax: 2, networkAdmissionWindowSeconds: 900,
  runStartMax: 2, runStartWindowSeconds: 3600
};
const principal = { id: OWNER_ID, displayName: 'Demo workspace', accountKind: 'demo' as const, role: 'user' as const };
const expiresAt = new Date('2026-10-20T12:00:00.000Z');

function repository(overrides: Partial<IDemoAdmissionRepository> = {}): jest.Mocked<IDemoAdmissionRepository> {
  return {
    findStatusByRequestDigest: jest.fn(async () => null),
    beginAdmission: jest.fn(async () => ({ kind: 'created' as const, admission: { admissionId: ADMISSION_ID, ownerId: OWNER_ID, principal, expiresAt } })),
    recordProvisioningAttempt: jest.fn(async () => 1),
    markProvisioningFailed: jest.fn(async () => undefined),
    completeWithSession: jest.fn(async () => ({ principal, expiresAt, sessionId: 'd3330000-0000-4000-8000-000000000003' })),
    ...overrides
  } as jest.Mocked<IDemoAdmissionRepository>;
}

function tokenProvider(): IOpaqueTokenProvider {
  return {
    createToken: jest.fn(() => 'random-opaque-demo-token-with-32-byte-source'),
    digestToken: jest.fn((token) => `digest:${token}`),
    createCsrfToken: jest.fn((token) => `csrf:${token}`)
  };
}

describe('CreateDemoSessionUseCase', () => {
  it('accepts only canonical 32-byte unpadded base64url keys and stores a one-way digest', () => {
    expect(digestIdempotencyKey(key)).toMatch(/^[0-9a-f]{64}$/u);
    expect(digestIdempotencyKey(key)).not.toContain(key);
    for (const invalid of ['', 'short', `${key}=`, `${key.slice(0, -1)}B`, 'a'.repeat(43)]) {
      expect(() => digestIdempotencyKey(invalid)).toThrow();
    }
  });

  it('derives stable HMAC network identities without storing the address', () => {
    const secret = 'dedicated-demo-network-secret-32-bytes-min';
    const first = deriveNetworkIdentity(secret, '198.51.100.20');
    expect(first).toEqual(deriveNetworkIdentity(secret, '198.51.100.20'));
    expect(first.hash).not.toContain('198.51.100.20');
    expect(deriveNetworkIdentity(secret, '198.51.100.21').hash).not.toBe(first.hash);
    expect(first.keyId).toMatch(/^[0-9a-f]{16}$/u);
    expect(() => deriveNetworkIdentity('too-short', '198.51.100.20')).toThrow(DemoAdmissionUnavailableError);
  });

  it('does not start a new admission when operator abuse configuration is incomplete', async () => {
    const repo = repository();
    const bootstrap: IDemoStorageBootstrap = { initializeEmptyAccount: jest.fn() };
    const useCase = new CreateDemoSessionUseCase(repo, bootstrap, tokenProvider(), { lifetimeMs: 86_400_000 });

    await expect(useCase.execute({ idempotencyKey: key, clientIp: '198.51.100.20' }))
      .rejects.toThrow(DemoAdmissionUnavailableError);
    expect(repo.beginAdmission).not.toHaveBeenCalled();
    expect(bootstrap.initializeEmptyAccount).not.toHaveBeenCalled();
  });

  it('returns only persisted status for a globally known retry from any address', async () => {
    const repo = repository({ findStatusByRequestDigest: jest.fn(async () => ({ state: 'ready' as const })) });
    const bootstrap: IDemoStorageBootstrap = { initializeEmptyAccount: jest.fn() };
    const provider = tokenProvider();
    const useCase = new CreateDemoSessionUseCase(repo, bootstrap, provider, {
      limits, networkHashSecret: 'dedicated-demo-network-secret-32-bytes-min', lifetimeMs: 86_400_000
    });

    await expect(useCase.execute({ idempotencyKey: key, clientIp: '203.0.113.77' }))
      .resolves.toEqual({ kind: 'status', state: 'ready' });
    expect(repo.beginAdmission).not.toHaveBeenCalled();
    expect(repo.completeWithSession).not.toHaveBeenCalled();
    expect(bootstrap.initializeEmptyAccount).not.toHaveBeenCalled();
    expect(provider.createToken).not.toHaveBeenCalled();
  });

  it('creates one session only after the new owner storage bootstrap succeeds', async () => {
    const repo = repository();
    const bootstrap: IDemoStorageBootstrap = { initializeEmptyAccount: jest.fn(async () => undefined) };
    const provider = tokenProvider();
    const useCase = new CreateDemoSessionUseCase(repo, bootstrap, provider, {
      limits, networkHashSecret: 'dedicated-demo-network-secret-32-bytes-min', lifetimeMs: 86_400_000
    });

    const result = await useCase.execute({ idempotencyKey: key, clientIp: '198.51.100.20' });

    expect(result).toEqual({ kind: 'created', session: {
      principal, rawToken: 'random-opaque-demo-token-with-32-byte-source', csrfToken: 'csrf:random-opaque-demo-token-with-32-byte-source', expiresAt
    } });
    expect(repo.beginAdmission).toHaveBeenCalledWith(expect.objectContaining({
      requestDigest: digestIdempotencyKey(key), networkHash: deriveNetworkIdentity('dedicated-demo-network-secret-32-bytes-min', '198.51.100.20').hash,
      lifetimeMs: 86_400_000
    }));
    expect(bootstrap.initializeEmptyAccount).toHaveBeenCalledWith(ADMISSION_ID, OWNER_ID);
    expect(repo.completeWithSession).toHaveBeenCalledWith({ admissionId: ADMISSION_ID, ownerId: OWNER_ID, tokenHash: 'digest:random-opaque-demo-token-with-32-byte-source' });
  });

  it('returns the session while durable showcase-copy provisioning continues', async () => {
    const repo = repository();
    const bootstrap: IDemoStorageBootstrap = { initializeEmptyAccount: jest.fn(async () => undefined) };
    const provider = tokenProvider();
    const provisionShowcaseCopy = jest.fn(() => new Promise<void>(() => undefined));
    const useCase = new CreateDemoSessionUseCase(repo, bootstrap, provider, {
      limits, networkHashSecret: 'dedicated-demo-network-secret-32-bytes-min', lifetimeMs: 86_400_000,
      isShowcaseAvailable: async () => true,
      provisionShowcaseCopy
    });

    const result = await useCase.execute({ idempotencyKey: key, clientIp: '198.51.100.20' });

    expect(result.kind).toBe('created');
    expect(provisionShowcaseCopy).toHaveBeenCalledWith(ADMISSION_ID, OWNER_ID);
  });

  it('bounds storage bootstrap attempts and never creates a session on provisioning failure', async () => {
    const repo = repository({ recordProvisioningAttempt: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(3) });
    const bootstrap: IDemoStorageBootstrap = { initializeEmptyAccount: jest.fn().mockRejectedValue(new Error('private file detail')) };
    const provider = tokenProvider();
    const useCase = new CreateDemoSessionUseCase(repo, bootstrap, provider, {
      limits, networkHashSecret: 'dedicated-demo-network-secret-32-bytes-min', lifetimeMs: 86_400_000
    });

    await expect(useCase.execute({ idempotencyKey: key, clientIp: '198.51.100.20' })).rejects.toThrow(DemoProvisioningFailedError);
    expect(bootstrap.initializeEmptyAccount).toHaveBeenCalledTimes(3);
    expect(repo.markProvisioningFailed).toHaveBeenCalledWith(ADMISSION_ID, OWNER_ID, 'storage_unavailable');
    expect(repo.completeWithSession).not.toHaveBeenCalled();
    expect(provider.createToken).not.toHaveBeenCalled();
  });
});
