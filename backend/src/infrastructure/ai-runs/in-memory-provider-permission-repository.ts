import { randomUUID } from 'node:crypto';

import { PROVIDER_PERMISSION_CAPABILITY, type ProviderPermission, type ProviderPermissionScope } from '@/modules/ai-runs/domain/provider-permission';
import type { IProviderPermissionRepository } from '@/modules/ai-runs/repositories/provider-permission-repository';

export class InMemoryProviderPermissionRepository implements IProviderPermissionRepository {
  private readonly permissions = new Map<string, ProviderPermission>();

  public async findActive(scope: ProviderPermissionScope): Promise<ProviderPermission | null> {
    return [...this.permissions.values()].find((permission) => matchesScope(permission, scope) && permission.revokedAt === null) ?? null;
  }

  public async findActiveById(input: { readonly ownerId: string; readonly projectId: string; readonly permissionId: string }): Promise<ProviderPermission | null> {
    const permission = this.permissions.get(input.permissionId);
    return permission && permission.ownerId === input.ownerId && permission.projectId === input.projectId && permission.revokedAt === null ? permission : null;
  }

  public async listForProjectOwner(input: { readonly ownerId: string; readonly projectId: string }): Promise<readonly ProviderPermission[]> {
    return [...this.permissions.values()]
      .filter((permission) => permission.ownerId === input.ownerId && permission.projectId === input.projectId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  public async grant(scope: ProviderPermissionScope): Promise<ProviderPermission> {
    const active = await this.findActive(scope);
    if (active) return active;
    const permission: ProviderPermission = {
      id: randomUUID(),
      ...scope,
      capability: PROVIDER_PERMISSION_CAPABILITY,
      createdAt: new Date(),
      expiresAt: null,
      revokedAt: null
    };
    this.permissions.set(permission.id, permission);
    return permission;
  }

  public async revoke(input: { readonly ownerId: string; readonly projectId: string; readonly permissionId: string }): Promise<ProviderPermission | null> {
    const permission = this.permissions.get(input.permissionId);
    if (!permission || permission.ownerId !== input.ownerId || permission.projectId !== input.projectId) return null;
    if (permission.revokedAt !== null) return permission;
    const revoked: ProviderPermission = { ...permission, revokedAt: new Date() };
    this.permissions.set(revoked.id, revoked);
    return revoked;
  }
}

function matchesScope(permission: ProviderPermission, scope: ProviderPermissionScope): boolean {
  return permission.ownerId === scope.ownerId
    && permission.projectId === scope.projectId
    && permission.providerProfile === scope.providerProfile
    && permission.model === scope.model;
}
