import { ProjectNotFoundError } from '@/modules/projects/domain/project-errors';
import type { Project } from '@/modules/projects/domain/project-types';
import { projectCapabilities } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { ProjectChatContextUseCases } from '@/modules/ai-runs/use-cases/project-chat-context-use-cases';
import type { IPrincipalAuthorization } from '@/modules/auth/use-cases/principal-authorization';
import {
  ASSISTANT_POLICY_PROFILES,
  type AssistantContextCategory,
  type AssistantToolCapability,
  type AssistantScopePolicy,
  type AssistantScopePolicyScope
} from '@/modules/assistant-policy/domain/assistant-scope-policy';
import type { IAssistantScopePolicyRepository } from '@/modules/assistant-policy/repositories/assistant-scope-policy-repository';
import type { IAssistantRuntimeCapability } from '@/modules/assistant-policy/repositories/assistant-runtime-capability';
import { NEBIUS_PROVIDER_PROFILE, NVIDIA_PROVIDER_PROFILE, providerLabel } from '@/modules/ai-runs/domain/model-provider-profile';

export interface AssistantExecutionPolicyStatus {
  readonly scope: { readonly kind: 'home' | 'workspace'; readonly label: string };
  readonly policy: null | {
    readonly enabled: boolean;
    readonly revision: string;
    readonly provider: null | { readonly name: string; readonly model: string };
    readonly included: {
      readonly categories: readonly AssistantContextCategory[];
      readonly items: readonly { readonly kind: 'file'; readonly name: string }[];
    };
    readonly exclusionsEnforced: true;
    readonly capabilities: readonly AssistantToolCapability[];
  };
  readonly fileAccess: boolean;
  readonly readiness:
    | { readonly state: 'ready' }
    | { readonly state: 'blocked'; readonly reasonCode: 'policy_revoked' }
    | { readonly state: 'unavailable'; readonly reasonCode: 'policy_unavailable' | 'provider_unconfigured' | 'runtime_unverified' };
}

export interface ProjectContextSummaryReader {
  get(ownerId: string, projectId: string): ReturnType<ProjectChatContextUseCases['get']>;
}

export class GetAssistantExecutionPolicyUseCase {
  public constructor(
    private readonly policies: IAssistantScopePolicyRepository,
    private readonly projects: Pick<IProjectRepository, 'findByIdForOwner'>,
    private readonly principalAuthorization: Pick<IPrincipalAuthorization, 'assertActive'>,
    private readonly projectContext?: ProjectContextSummaryReader,
    private readonly runtimeCapability?: IAssistantRuntimeCapability
  ) {}

  public async execute(scope: AssistantScopePolicyScope): Promise<AssistantExecutionPolicyStatus> {
    await this.principalAuthorization.assertActive(scope.ownerId);
    let project: Project | null = null;
    if (scope.scopeKind === 'project') {
      project = await this.projects.findByIdForOwner(scope.ownerId, scope.projectId);
      if (!project || project.status !== 'active') throw new ProjectNotFoundError();
    }

    const policy = await this.policies.find(scope);
    const fileAccess = project ? projectCapabilities(project).fileAccess : false;
    const includedItems = project && fileAccess && this.projectContext
      ? await this.readSelectedFiles(scope.ownerId, project)
      : [];
    return {
      scope: project ? { kind: 'workspace', label: project.name } : { kind: 'home', label: 'Home' },
      policy: policy ? toPolicySummary(policy, includedItems) : null,
      fileAccess,
      readiness: await readinessFor(policy, scope.scopeKind, this.runtimeCapability)
    };
  }

  private async readSelectedFiles(ownerId: string, project: Project): Promise<readonly { readonly kind: 'file'; readonly name: string }[]> {
    const context = await this.projectContext?.get(ownerId, project.id);
    return (context?.relativePaths ?? []).map((name) => ({ kind: 'file' as const, name }));
  }
}

function toPolicySummary(
  policy: AssistantScopePolicy,
  items: readonly { readonly kind: 'file'; readonly name: string }[]
): NonNullable<AssistantExecutionPolicyStatus['policy']> {
  const profile = ASSISTANT_POLICY_PROFILES[policy.policyProfile];
  const isKnownProvider = policy.providerProfile === NVIDIA_PROVIDER_PROFILE || policy.providerProfile === NEBIUS_PROVIDER_PROFILE;
  const provider = policy.providerProfile && policy.model && isKnownProvider
    ? { name: providerLabel(policy.providerProfile), model: policy.model }
    : null;
  return {
    enabled: policy.enabled,
    revision: policy.revision,
    provider,
    included: { categories: profile.contextCategories, items },
    exclusionsEnforced: true,
    capabilities: profile.toolCapabilities
  };
}

async function readinessFor(
  policy: AssistantScopePolicy | null,
  scopeKind: 'home' | 'project',
  runtimeCapability?: IAssistantRuntimeCapability
): Promise<AssistantExecutionPolicyStatus['readiness']> {
  if (!policy) return { state: 'unavailable', reasonCode: 'policy_unavailable' };
  if (!policy.enabled || policy.revokedAt !== null) return { state: 'blocked', reasonCode: 'policy_revoked' };
  if (!policy.providerProfile || !policy.model) return { state: 'unavailable', reasonCode: 'provider_unconfigured' };
  const capability = await runtimeCapability?.assess({ scopeKind, providerProfile: policy.providerProfile, model: policy.model });
  return capability?.available === true
    ? { state: 'ready' }
    : { state: 'unavailable', reasonCode: 'runtime_unverified' };
}
