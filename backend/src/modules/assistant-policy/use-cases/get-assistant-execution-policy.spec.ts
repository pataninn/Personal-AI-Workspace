import type { IPrincipalAuthorization } from '@/modules/auth/use-cases/principal-authorization';
import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IAssistantScopePolicyRepository } from '@/modules/assistant-policy/repositories/assistant-scope-policy-repository';
import type { IAssistantRuntimeCapability } from '@/modules/assistant-policy/repositories/assistant-runtime-capability';
import { GetAssistantExecutionPolicyUseCase } from '@/modules/assistant-policy/use-cases/get-assistant-execution-policy';
import type { AssistantScopePolicy } from '@/modules/assistant-policy/domain/assistant-scope-policy';
import { ProjectNotFoundError } from '@/modules/projects/domain/project-errors';

const OWNER = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';

describe('GetAssistantExecutionPolicyUseCase', () => {
  it('returns an unavailable snapshot when a scope row is absent without trying to seed it', async () => {
    const { useCase, find, authorize } = createUseCase(null);
    const result = await useCase.execute({ ownerId: OWNER, scopeKind: 'home', projectId: null });

    expect(authorize).toHaveBeenCalledWith(OWNER);
    expect(find).toHaveBeenCalledWith({ ownerId: OWNER, scopeKind: 'home', projectId: null });
    expect(result).toMatchObject({ policy: null, readiness: { state: 'unavailable', reasonCode: 'policy_unavailable' } });
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('keeps stored grants distinct from runtime readiness and returns only display-safe policy data', async () => {
    const { useCase } = createUseCase(policyRow({ providerProfile: 'nvidia-hosted-nim', model: 'nemotron-test' }));
    const result = await useCase.execute({ ownerId: OWNER, scopeKind: 'home', projectId: null });

    expect(result).toMatchObject({
      scope: { kind: 'home', label: 'Home' },
      policy: {
        enabled: true,
        provider: { name: 'NVIDIA hosted NIM', model: 'nemotron-test' },
        included: { categories: ['current_message', 'bounded_home_history', 'task_metadata', 'workspace_metadata'] },
        exclusionsEnforced: true
      },
      readiness: { state: 'unavailable', reasonCode: 'runtime_unverified' }
    });
    expect(JSON.stringify(result)).not.toContain('endpoint');
    expect(JSON.stringify(result)).not.toContain('ownerId');
  });

  it('reports ready only when the trusted runtime port verifies this configured provider and model', async () => {
    const { useCase } = createUseCase(policyRow({ providerProfile: 'nvidia-hosted-nim', model: 'model-a' }), projectRow(), undefined, {
      assess: jest.fn(async () => ({ available: true as const }))
    });
    const result = await useCase.execute({ ownerId: OWNER, scopeKind: 'project', projectId: PROJECT });
    expect(result.readiness).toEqual({ state: 'ready' });
  });

  it('hides foreign/archived workspaces and reports only safe project-relative selected paths', async () => {
    const project = projectRow();
    const policy = policyRow({ scopeKind: 'project', projectId: PROJECT, policyProfile: 'workspace_in_scope_v1' });
    const { useCase } = createUseCase(policy, project, {
      get: jest.fn(async () => ({ relativePaths: ['src/index.ts'], factIds: ['fact-id'], includeProjectConversations: true, excludedPaths: ['.env'] }))
    });
    const result = await useCase.execute({ ownerId: OWNER, scopeKind: 'project', projectId: PROJECT });

    expect(result.scope).toEqual({ kind: 'workspace', label: 'Example workspace' });
    expect(result.fileAccess).toBe(true);
    expect(result.policy?.included.items).toEqual([{ kind: 'file', name: 'src/index.ts' }]);
    expect(JSON.stringify(result)).not.toContain('.env');
    expect(JSON.stringify(result)).not.toContain(PROJECT);
  });

  it('returns generic not found when the requested project is foreign or archived', async () => {
    const { useCase } = createUseCase(null, null);
    await expect(useCase.execute({ ownerId: OWNER, scopeKind: 'project', projectId: PROJECT })).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

function createUseCase(
  policy: AssistantScopePolicy | null,
  project: Project | null = projectRow(),
  projectContext?: { get(ownerId: string, projectId: string): Promise<{ relativePaths: readonly string[]; factIds: readonly string[]; includeProjectConversations: boolean; excludedPaths?: readonly string[] }> },
  runtimeCapability?: IAssistantRuntimeCapability
) {
  const find = jest.fn(async () => policy);
  const policies: IAssistantScopePolicyRepository = {
    find,
    synchronizeProviderConfiguration: async () => undefined,
    fillConfiguredProvider: async () => null,
    revoke: async () => null
  };
  const findByIdForOwner = jest.fn(async () => project);
  const projects = { findByIdForOwner } as unknown as Pick<IProjectRepository, 'findByIdForOwner'>;
  const authorize = jest.fn(async () => undefined);
  const principalAuthorization: Pick<IPrincipalAuthorization, 'assertActive'> = { assertActive: authorize };
  const useCase = new GetAssistantExecutionPolicyUseCase(policies, projects, principalAuthorization, projectContext, runtimeCapability);
  return { useCase, find, authorize, findByIdForOwner };
}

function policyRow(overrides: Partial<AssistantScopePolicy> = {}): AssistantScopePolicy {
  const now = new Date('2026-10-19T00:00:00.000Z');
  return {
    id: 'policy-id', ownerId: OWNER, scopeKind: 'home', projectId: null,
    policyProfile: 'home_in_scope_v1', providerProfile: null, model: null,
    enabled: true, revokedAt: null, revision: '3', createdAt: now, updatedAt: now,
    ...overrides
  };
}

function projectRow(overrides: Partial<Project> = {}): Project {
  const now = new Date('2026-10-19T00:00:00.000Z');
  return {
    id: PROJECT, ownerId: OWNER, name: 'Example workspace', slug: 'example-workspace',
    relativeRoot: 'projects/example', storageKind: 'managed', objective: null, status: 'active', version: 1,
    createdAt: now, updatedAt: now, ...overrides
  };
}
