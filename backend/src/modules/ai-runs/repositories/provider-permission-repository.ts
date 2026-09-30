import type { ProviderPermission, ProviderPermissionScope } from '@/modules/ai-runs/domain/provider-permission';

export interface IProviderPermissionRepository {
  findActive(scope: ProviderPermissionScope): Promise<ProviderPermission | null>;
  findActiveById(input: { readonly ownerId: string; readonly projectId: string; readonly permissionId: string }): Promise<ProviderPermission | null>;
  listForProjectOwner(input: { readonly ownerId: string; readonly projectId: string }): Promise<readonly ProviderPermission[]>;
  grant(scope: ProviderPermissionScope): Promise<ProviderPermission>;
  revoke(input: { readonly ownerId: string; readonly projectId: string; readonly permissionId: string }): Promise<ProviderPermission | null>;
}
