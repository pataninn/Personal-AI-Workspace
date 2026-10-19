import type { SessionSnapshot } from '@/entities/user-session';

export interface DemoAvailability {
  readonly available: boolean;
}

export interface DemoAdmissionStatus {
  readonly state: 'pending' | 'ready';
}

export interface DemoAdmissionSession extends SessionSnapshot {
  readonly state: 'ready';
}

export type DemoAdmissionResult = DemoAdmissionStatus | DemoAdmissionSession;

export interface DemoShowcaseCopy {
  readonly state: 'pending' | 'ready' | 'failed';
  readonly projectId: string | null;
  readonly retryAllowed: boolean;
  readonly workspaceMode: 'planning' | 'file_backed' | null;
  readonly capabilities: { readonly planning: true; readonly fileAccess: boolean } | null;
}
