import { InMemoryProviderPermissionRepository } from '@/infrastructure/ai-runs/in-memory-provider-permission-repository';
import { ListProviderPermissionsUseCase, RevokeProviderPermissionUseCase } from '@/modules/ai-runs/use-cases/provider-permission-use-cases';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const FOREIGN_PROJECT_ID = '44444444-4444-4444-8444-444444444444';
const scope = { ownerId: OWNER_ID, projectId: PROJECT_ID, providerProfile: 'nvidia-hosted-nim', model: 'nvidia/nemotron-3-super-120b-a12b' } as const;

describe('provider permission management use cases', () => {
  it('lists records only for the requested owner and project', async () => {
    const repository = new InMemoryProviderPermissionRepository();
    const permission = await repository.grant(scope);
    await repository.grant({ ...scope, projectId: FOREIGN_PROJECT_ID });
    const list = new ListProviderPermissionsUseCase(repository);

    await expect(list.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID })).resolves.toEqual([permission]);
  });

  it('rejects revocation attempts outside the permission project and keeps the permission active', async () => {
    const repository = new InMemoryProviderPermissionRepository();
    const permission = await repository.grant(scope);
    const revoke = new RevokeProviderPermissionUseCase(repository);

    await expect(revoke.execute({ ownerId: OWNER_ID, projectId: FOREIGN_PROJECT_ID, permissionId: permission.id })).rejects.toMatchObject({ code: 'PROVIDER_PERMISSION_NOT_FOUND' });
    await expect(repository.findActive(scope)).resolves.toEqual(permission);
  });

  it('records revocation and prevents the grant from authorizing another request', async () => {
    const repository = new InMemoryProviderPermissionRepository();
    const permission = await repository.grant(scope);
    const revoke = new RevokeProviderPermissionUseCase(repository);

    const result = await revoke.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, permissionId: permission.id });

    expect(result.revokedAt).toBeInstanceOf(Date);
    await expect(repository.findActive(scope)).resolves.toBeNull();
    await expect(repository.listForProjectOwner({ ownerId: OWNER_ID, projectId: PROJECT_ID })).resolves.toEqual([result]);
  });
});
