import { createHash, createHmac } from 'node:crypto';
import { isIP } from 'node:net';

import type { IOpaqueTokenProvider } from '@/modules/auth/repositories/security-providers';
import type { DemoAdmissionAttemptResult, IDemoAdmissionRepository, IDemoStorageBootstrap } from '@/modules/demo/domain/demo-admission-types';
import { DemoAdmissionRateLimitedError, DemoAdmissionUnavailableError, DemoAdmissionValidationError, DemoProvisioningFailedError, DemoShowcaseUnavailableError } from '@/modules/demo/domain/demo-admission-errors';

export interface CreateDemoSessionConfiguration {
  readonly networkHashSecret?: string;
  readonly isShowcaseAvailable?: () => Promise<boolean>;
  readonly provisionShowcaseCopy?: (admissionId: string, ownerId: string) => Promise<void>;
}

export class CreateDemoSessionUseCase {
  public constructor(
    private readonly repository: IDemoAdmissionRepository,
    private readonly storageBootstrap: IDemoStorageBootstrap,
    private readonly tokenProvider: IOpaqueTokenProvider,
    private readonly configuration: CreateDemoSessionConfiguration
  ) {}

  public async execute(input: { readonly idempotencyKey: string; readonly clientIp: string | undefined }): Promise<DemoAdmissionAttemptResult> {
    const requestDigest = digestIdempotencyKey(input.idempotencyKey);
    const previous = await this.repository.findStatusByRequestDigest(requestDigest);
    if (previous) return { kind: 'status', state: previous.state };

    const secret = this.configuration.networkHashSecret;
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32 || !input.clientIp || isIP(input.clientIp) === 0) {
      throw new DemoAdmissionUnavailableError();
    }
    if (this.configuration.isShowcaseAvailable) {
      let available = false;
      try { available = await this.configuration.isShowcaseAvailable(); } catch { available = false; }
      if (!available) throw new DemoShowcaseUnavailableError();
    }
    const network = deriveNetworkIdentity(secret, input.clientIp);

    let begun;
    try {
      begun = await this.repository.beginAdmission({
        requestDigest,
        networkHash: network.hash,
        networkKeyId: network.keyId
      });
    } catch (error: unknown) {
      if (error instanceof DemoAdmissionRateLimitedError || error instanceof DemoAdmissionUnavailableError) throw error;
      throw new DemoAdmissionUnavailableError();
    }
    if (begun.kind === 'existing') return { kind: 'status', state: begun.status.state };

    let bootstrapped = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const recordedAttempt = await this.repository.recordProvisioningAttempt(begun.admission.admissionId);
      if (recordedAttempt > 3) break;
      try {
        await this.storageBootstrap.initializeEmptyAccount(begun.admission.admissionId, begun.admission.ownerId);
        bootstrapped = true;
        break;
      } catch {
        // Storage failures are deliberately not logged or persisted with exception detail.
      }
    }
    if (!bootstrapped) {
      await this.repository.markProvisioningFailed(begun.admission.admissionId, begun.admission.ownerId, 'storage_unavailable');
      throw new DemoProvisioningFailedError();
    }

    const rawToken = this.tokenProvider.createToken();
    try {
      const completed = await this.repository.completeWithSession({
        admissionId: begun.admission.admissionId,
        ownerId: begun.admission.ownerId,
        tokenHash: this.tokenProvider.digestToken(rawToken)
      });
      const copyProvisioning = this.configuration.provisionShowcaseCopy?.(begun.admission.admissionId, begun.admission.ownerId);
      if (copyProvisioning) void copyProvisioning.catch(() => undefined);
      return {
        kind: 'created',
        session: {
          principal: completed.principal,
          rawToken,
          csrfToken: this.tokenProvider.createCsrfToken(rawToken),
          expiresAt: completed.expiresAt
        }
      };
    } catch {
      await this.repository.markProvisioningFailed(begun.admission.admissionId, begun.admission.ownerId, 'session_unavailable');
      throw new DemoProvisioningFailedError();
    }
  }
}

export function digestIdempotencyKey(value: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new DemoAdmissionValidationError();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== value) throw new DemoAdmissionValidationError();
  return createHash('sha256').update(decoded).digest('hex');
}

export function deriveNetworkIdentity(secret: string, clientIp: string): { readonly hash: string; readonly keyId: string } {
  if (Buffer.byteLength(secret, 'utf8') < 32 || isIP(clientIp) === 0) throw new DemoAdmissionUnavailableError();
  const keyId = createHash('sha256').update('demo-network-key-id:v1:').update(secret).digest('hex').slice(0, 16);
  const hash = createHmac('sha256', secret).update('demo-network:v1:').update(clientIp).digest('hex');
  return { hash, keyId };
}
