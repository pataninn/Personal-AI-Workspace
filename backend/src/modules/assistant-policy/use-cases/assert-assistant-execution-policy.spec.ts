import type { AssistantScopePolicy } from '@/modules/assistant-policy/domain/assistant-scope-policy';
import { AssistantExecutionPolicyChangedError, AssistantExecutionUnavailableError } from '@/modules/assistant-policy/domain/assistant-execution-errors';
import type { IAssistantRuntimeCapability } from '@/modules/assistant-policy/repositories/assistant-runtime-capability';
import type { IAssistantScopePolicyRepository } from '@/modules/assistant-policy/repositories/assistant-scope-policy-repository';
import { AssertAssistantExecutionPolicyUseCase } from '@/modules/assistant-policy/use-cases/assert-assistant-execution-policy';
import type { IPrincipalAuthorization } from '@/modules/auth/use-cases/principal-authorization';
import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';

const OWNER = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const PROVIDER = 'nvidia-hosted-nim';
const MODEL = 'nvidia/nemotron-3-super-120b-a12b';

describe('AssertAssistantExecutionPolicyUseCase', () => {
  it('authorizes only an active owned project with the exact provider/model and current policy revision', async () => {
    const policy = policyRow({ scopeKind: 'project', projectId: PROJECT, policyProfile: 'workspace_in_scope_v1' });
    const fixture = createUseCase([policy], projectRow(), { available: true });

    await expect(fixture.useCase.assertWorkspace({
      ownerId: OWNER, projectId: PROJECT, providerProfile: PROVIDER, model: MODEL, policyRevision: '7'
    })).resolves.toMatchObject({ policies: [policy], revisions: { workspace: '7' } });
    expect(fixture.authorize).toHaveBeenCalledWith(OWNER);
    expect(fixture.findProject).toHaveBeenCalledWith(OWNER, PROJECT);
    expect(fixture.findPolicy).toHaveBeenCalledWith({ ownerId: OWNER, scopeKind: 'project', projectId: PROJECT });
    expect(fixture.assess).toHaveBeenCalledWith({ scopeKind: 'project', providerProfile: PROVIDER, model: MODEL });
  });

  it('blocks before runtime capability when the policy is missing, revoked, or stale', async () => {
    const missing = createUseCase([], projectRow(), { available: true });
    await expect(missing.useCase.assertWorkspace({ ownerId: OWNER, projectId: PROJECT, providerProfile: PROVIDER, model: MODEL }))
      .rejects.toBeInstanceOf(AssistantExecutionUnavailableError);
    expect(missing.assess).not.toHaveBeenCalled();

    const stale = createUseCase([policyRow({ scopeKind: 'project', projectId: PROJECT, policyProfile: 'workspace_in_scope_v1', revision: '8' })], projectRow(), { available: true });
    await expect(stale.useCase.assertWorkspace({ ownerId: OWNER, projectId: PROJECT, providerProfile: PROVIDER, model: MODEL, policyRevision: '7' }))
      .rejects.toBeInstanceOf(AssistantExecutionPolicyChangedError);
    expect(stale.assess).not.toHaveBeenCalled();

    const revoked = createUseCase([policyRow({ scopeKind: 'project', projectId: PROJECT, policyProfile: 'workspace_in_scope_v1', enabled: false, revokedAt: new Date(), revision: '8' })], projectRow(), { available: true });
    await expect(revoked.useCase.assertWorkspace({ ownerId: OWNER, projectId: PROJECT, providerProfile: PROVIDER, model: MODEL }))
      .rejects.toBeInstanceOf(AssistantExecutionPolicyChangedError);
  });

  it('intersects Home and target workspace policies before accepting a Home dispatch', async () => {
    const home = policyRow();
    const workspace = policyRow({ scopeKind: 'project', projectId: PROJECT, policyProfile: 'workspace_in_scope_v1' });
    const fixture = createUseCase([home, workspace], projectRow(), { available: true });

    await expect(fixture.useCase.assertHome({
      ownerId: OWNER, projectId: PROJECT, providerProfile: PROVIDER, model: MODEL
    })).resolves.toMatchObject({ policies: [home, workspace], revisions: { home: '7', workspace: '7' } });
    expect(fixture.findPolicy).toHaveBeenCalledTimes(2);
    expect(fixture.assess).toHaveBeenCalledWith({ scopeKind: 'home', providerProfile: PROVIDER, model: MODEL });
  });

  it('fails closed when a trusted runtime capability is unavailable', async () => {
    const policy = policyRow({ scopeKind: 'project', projectId: PROJECT, policyProfile: 'workspace_in_scope_v1' });
    const fixture = createUseCase([policy], projectRow(), { available: false, reasonCode: 'runtime_unverified' });
    await expect(fixture.useCase.assertWorkspace({ ownerId: OWNER, projectId: PROJECT, providerProfile: PROVIDER, model: MODEL }))
      .rejects.toBeInstanceOf(AssistantExecutionUnavailableError);
  });
});

function createUseCase(
  policiesFound: readonly AssistantScopePolicy[],
  project: Project | null,
  capability: Awaited<ReturnType<IAssistantRuntimeCapability['assess']>>
) {
  const findPolicy = jest.fn(async (scope: { readonly ownerId: string; readonly scopeKind: 'home' | 'project'; readonly projectId: string | null }) =>
    policiesFound.find((policy) => policy.ownerId === scope.ownerId && policy.scopeKind === scope.scopeKind && policy.projectId === scope.projectId) ?? null);
  const policies: IAssistantScopePolicyRepository = {
    find: findPolicy,
    synchronizeProviderConfiguration: async () => undefined,
    fillConfiguredProvider: async () => null,
    revoke: async () => null
  };
  const findProject = jest.fn(async () => project);
  const projectRepository = { findByIdForOwner: findProject } as unknown as Pick<IProjectRepository, 'findByIdForOwner'>;
  const authorize = jest.fn(async () => undefined);
  const principalAuthorization: Pick<IPrincipalAuthorization, 'assertActive'> = { assertActive: authorize };
  const assess = jest.fn(async () => capability);
  const runtimeCapability: IAssistantRuntimeCapability = { assess };
  return {
    useCase: new AssertAssistantExecutionPolicyUseCase(policies, projectRepository, principalAuthorization, runtimeCapability),
    findPolicy,
    findProject,
    authorize,
    assess
  };
}

function policyRow(overrides: Partial<AssistantScopePolicy> = {}): AssistantScopePolicy {
  const now = new Date('2026-10-19T00:00:00.000Z');
  return {
    id: `policy-${overrides.scopeKind ?? 'home'}`, ownerId: OWNER, scopeKind: 'home', projectId: null,
    policyProfile: 'home_in_scope_v1', providerProfile: PROVIDER, model: MODEL,
    enabled: true, revokedAt: null, revision: '7', createdAt: now, updatedAt: now, ...overrides
  };
}

function projectRow(): Project {
  const now = new Date('2026-10-19T00:00:00.000Z');
  return {
    id: PROJECT, ownerId: OWNER, name: 'Workspace', slug: 'workspace', relativeRoot: 'projects/workspace',
    storageKind: 'managed', objective: null, status: 'active', version: 1, createdAt: now, updatedAt: now
  };
}
