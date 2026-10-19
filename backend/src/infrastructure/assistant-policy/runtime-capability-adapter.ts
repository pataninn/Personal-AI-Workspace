import type { IAgentRuntime } from '@/modules/ai-runs/repositories/agent-runtime';
import type { IHomePlanningRuntime } from '@/modules/home-assistant/repositories/home-planning-runtime';
import type { IAssistantRuntimeCapability, AssistantRuntimeCapabilityInput } from '@/modules/assistant-policy/repositories/assistant-runtime-capability';

/** Adapts server-owned runtime hooks; absent hooks always mean unavailable. */
export class RuntimeCapabilityAdapter implements IAssistantRuntimeCapability {
  public constructor(
    private readonly workspaceRuntime: Pick<IAgentRuntime, 'supportsPolicyExecution'>,
    private readonly homeRuntime?: Pick<IHomePlanningRuntime, 'supportsPolicyExecution'>
  ) {}

  public async assess(input: AssistantRuntimeCapabilityInput) {
    const runtime = input.scopeKind === 'home' ? this.homeRuntime : this.workspaceRuntime;
    const ready = await runtime?.supportsPolicyExecution?.({ providerProfile: input.providerProfile, model: input.model }) ?? false;
    return ready ? { available: true as const } : { available: false as const, reasonCode: 'runtime_unverified' as const };
  }
}
