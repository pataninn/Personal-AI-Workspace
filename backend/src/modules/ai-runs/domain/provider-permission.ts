export const PROVIDER_PERMISSION_CAPABILITY = 'send_selected_context' as const;

export interface ProviderPermission {
  readonly id: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly providerProfile: string;
  readonly model: string;
  readonly capability: typeof PROVIDER_PERMISSION_CAPABILITY;
  readonly createdAt: Date;
  readonly expiresAt: null;
  readonly revokedAt: Date | null;
}

export interface ProviderPermissionScope {
  readonly ownerId: string;
  readonly projectId: string;
  readonly providerProfile: string;
  readonly model: string;
}
