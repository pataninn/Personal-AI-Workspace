export interface DemoShowcaseCopyDto {
  readonly state: 'pending' | 'ready' | 'failed';
  readonly projectId: string | null;
  readonly retryAllowed: boolean;
  readonly workspaceMode: 'planning' | 'file_backed' | null;
  readonly capabilities: { readonly planning: true; readonly fileAccess: boolean } | null;
}

export interface IDemoShowcaseCopyManager {
  isReady(ownerId: string): Promise<boolean>;
  getStatus(ownerId: string): Promise<DemoShowcaseCopyDto>;
  provision(admissionId: string, ownerId: string): Promise<void>;
  retry(ownerId: string): Promise<DemoShowcaseCopyDto>;
}
