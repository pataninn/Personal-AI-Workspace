import { ProjectNotFoundError } from '@/modules/projects/domain/project-errors';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IPrincipalAuthorization } from '@/modules/auth/use-cases/principal-authorization';
import { ASSISTANT_POLICY_PROFILES, intersectAssistantCapabilities, type AssistantScopePolicy, type AssistantScopePolicyScope, type AssistantToolCapability } from '@/modules/assistant-policy/domain/assistant-scope-policy';
import { AssistantExecutionPolicyChangedError, AssistantExecutionUnavailableError } from '@/modules/assistant-policy/domain/assistant-execution-errors';
import type { IAssistantScopePolicyRepository } from '@/modules/assistant-policy/repositories/assistant-scope-policy-repository';
import type { IAssistantRuntimeCapability } from '@/modules/assistant-policy/repositories/assistant-runtime-capability';

export interface AssertAssistantExecutionInput {
  readonly ownerId: string;
  readonly projectId?: string;
  readonly providerProfile: string;
  readonly model: string;
  readonly policyRevision?: string;
  readonly homePolicyRevision?: string;
  readonly workspacePolicyRevision?: string;
}

export interface AssistantExecutionAuthorization {
  readonly policies: readonly AssistantScopePolicy[];
  readonly effectiveCapabilities: readonly AssistantToolCapability[];
  readonly revisions: { readonly home?: string; readonly workspace?: string };
}

/** Rechecks the stored scope policy and trusted send capability at each server dispatch boundary. */
export class AssertAssistantExecutionPolicyUseCase {
  public constructor(
    private readonly policies: IAssistantScopePolicyRepository,
    private readonly projects: Pick<IProjectRepository, 'findByIdForOwner'>,
    private readonly principalAuthorization: Pick<IPrincipalAuthorization, 'assertActive'>,
    private readonly runtimeCapability: IAssistantRuntimeCapability
  ) {}

  public async assertWorkspace(input: AssertAssistantExecutionInput): Promise<AssistantExecutionAuthorization> {
    if (!input.projectId) throw new ProjectNotFoundError();
    await this.principalAuthorization.assertActive(input.ownerId);
    const project = await this.projects.findByIdForOwner(input.ownerId, input.projectId);
    if (!project || project.status !== 'active') throw new ProjectNotFoundError();
    const scope = { ownerId: input.ownerId, scopeKind: 'project' as const, projectId: project.id };
    const policy = await this.requirePolicy(scope, input, input.policyRevision);
    const capability = await this.runtimeCapability.assess({
      scopeKind: scope.scopeKind,
      providerProfile: input.providerProfile,
      model: input.model
    });
    if (!capability.available) throw new AssistantExecutionUnavailableError();
    return {
      policies: [policy],
      effectiveCapabilities: ASSISTANT_POLICY_PROFILES[policy.policyProfile].toolCapabilities,
      revisions: { workspace: policy.revision }
    };
  }

  public async assertHome(input: AssertAssistantExecutionInput): Promise<AssistantExecutionAuthorization> {
    await this.principalAuthorization.assertActive(input.ownerId);
    const homeScope = { ownerId: input.ownerId, scopeKind: 'home' as const, projectId: null };
    const home = await this.requirePolicy(homeScope, input, input.homePolicyRevision);
    const policies = [home];
    let workspace: AssistantScopePolicy | undefined;
    if (input.projectId) {
      const project = await this.projects.findByIdForOwner(input.ownerId, input.projectId);
      if (!project || project.status !== 'active') throw new ProjectNotFoundError();
      const workspaceScope = { ownerId: input.ownerId, scopeKind: 'project' as const, projectId: project.id };
      workspace = await this.requirePolicy(workspaceScope, input, input.workspacePolicyRevision);
      policies.push(workspace);
    }
    const capability = await this.runtimeCapability.assess({
      scopeKind: 'home',
      providerProfile: input.providerProfile,
      model: input.model
    });
    if (!capability.available) throw new AssistantExecutionUnavailableError();
    const homeCapabilities = ASSISTANT_POLICY_PROFILES[home.policyProfile].toolCapabilities;
    const effectiveCapabilities = workspace
      ? intersectAssistantCapabilities(homeCapabilities, ASSISTANT_POLICY_PROFILES[workspace.policyProfile].toolCapabilities)
      : homeCapabilities;
    return {
      policies,
      effectiveCapabilities,
      revisions: { home: home.revision, ...(workspace ? { workspace: workspace.revision } : {}) }
    };
  }

  private async requirePolicy(scope: AssistantScopePolicyScope, input: AssertAssistantExecutionInput, expectedRevision?: string): Promise<AssistantScopePolicy> {
    const policy = await this.policies.find(scope);
    const expectedProfile = scope.scopeKind === 'home' ? 'home_in_scope_v1' : 'workspace_in_scope_v1';
    if (!policy) throw new AssistantExecutionUnavailableError();
    if (policy.ownerId !== scope.ownerId || policy.projectId !== scope.projectId
      || !policy.enabled || policy.revokedAt !== null || policy.policyProfile !== expectedProfile
      || policy.providerProfile !== input.providerProfile || policy.model !== input.model
      || (expectedRevision !== undefined && policy.revision !== expectedRevision)
      || ASSISTANT_POLICY_PROFILES[policy.policyProfile] === undefined) {
      throw new AssistantExecutionPolicyChangedError();
    }
    return policy;
  }
}
