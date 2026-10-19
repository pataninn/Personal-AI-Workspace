import type { LocalPrincipal } from '@/modules/auth/domain/auth-types';

export interface DemoAbuseLimitValues {
  readonly globalAdmissionMax: number;
  readonly globalAdmissionWindowSeconds: number;
  readonly networkAdmissionMax: number;
  readonly networkAdmissionWindowSeconds: number;
  readonly runStartMax: number;
  readonly runStartWindowSeconds: number;
}

export type DemoAdmissionState = 'pending' | 'ready' | 'failed';

export interface DemoAdmissionStatus {
  readonly state: DemoAdmissionState;
}

export interface CreatedDemoAdmission {
  readonly admissionId: string;
  readonly ownerId: string;
  readonly principal: LocalPrincipal;
  readonly expiresAt: Date;
}

export type BeginDemoAdmissionResult =
  | { readonly kind: 'created'; readonly admission: CreatedDemoAdmission }
  | { readonly kind: 'existing'; readonly status: DemoAdmissionStatus };

export interface CompleteDemoAdmissionInput {
  readonly admissionId: string;
  readonly ownerId: string;
  readonly tokenHash: string;
}

export interface CompletedDemoAdmission {
  readonly principal: LocalPrincipal;
  readonly expiresAt: Date;
  readonly sessionId: string;
}

export interface IDemoAdmissionRepository {
  findStatusByRequestDigest(requestDigest: string): Promise<DemoAdmissionStatus | null>;
  beginAdmission(input: {
    readonly requestDigest: string;
    readonly networkHash: string;
    readonly networkKeyId: string;
    readonly limits: DemoAbuseLimitValues;
    readonly lifetimeMs: number;
  }): Promise<BeginDemoAdmissionResult>;
  recordProvisioningAttempt(admissionId: string): Promise<number>;
  markProvisioningFailed(admissionId: string, ownerId: string, failureCode: 'storage_unavailable' | 'storage_not_empty' | 'session_unavailable'): Promise<void>;
  completeWithSession(input: CompleteDemoAdmissionInput): Promise<CompletedDemoAdmission>;
}

export interface IDemoStorageBootstrap {
  initializeEmptyAccount(admissionId: string, ownerId: string): Promise<void>;
}

export interface IDemoRunStartAdmission {
  admitDemoRunStart(ownerId: string, runId: string): Promise<void>;
}

export interface CreateDemoSessionResult {
  readonly principal: LocalPrincipal;
  readonly rawToken: string;
  readonly csrfToken: string;
  readonly expiresAt: Date;
}

export type DemoAdmissionAttemptResult =
  | { readonly kind: 'created'; readonly session: CreateDemoSessionResult }
  | { readonly kind: 'status'; readonly state: DemoAdmissionState };
