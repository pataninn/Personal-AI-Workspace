import { ProviderPermissionNotFoundError } from '@/modules/ai-runs/domain/provider-permission-errors';
import type { ProviderPermission } from '@/modules/ai-runs/domain/provider-permission';
import type { IProviderPermissionRepository } from '@/modules/ai-runs/repositories/provider-permission-repository';

export interface ListProviderPermissionsInput {
  readonly ownerId: string;
  readonly projectId: string;
}

export class ListProviderPermissionsUseCase {
  public constructor(private readonly permissionRepository: IProviderPermissionRepository) {}

  public execute(input: ListProviderPermissionsInput): Promise<readonly ProviderPermission[]> {
    return this.permissionRepository.listForProjectOwner(input);
  }
}

export interface RevokeProviderPermissionInput {
  readonly ownerId: string;
  readonly projectId: string;
  readonly permissionId: string;
}

export class RevokeProviderPermissionUseCase {
  public constructor(private readonly permissionRepository: IProviderPermissionRepository) {}

  public async execute(input: RevokeProviderPermissionInput): Promise<ProviderPermission> {
    const permission = await this.permissionRepository.revoke(input);
    if (!permission) throw new ProviderPermissionNotFoundError();
    return permission;
  }
}
