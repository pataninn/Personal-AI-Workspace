import type { AssistantToolCapability } from '@/modules/assistant-policy/domain/assistant-scope-policy';

export type SkillToolCapability = Extract<AssistantToolCapability, `home_${string}`>;

export const SKILL_INPUT_LIMITS = { titleCharacters: 120, instructionBytes: 16_000, requestCharacters: 20_000 } as const;

export interface Skill {
  readonly id: string;
  readonly revisionId: string;
  readonly ownerId: string;
  readonly workspaceId: string | null;
  readonly title: string;
  readonly instructions: string;
  readonly declaredTools: readonly SkillToolCapability[];
  readonly enabled: boolean;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SkillDraft {
  readonly workspaceId: string | null;
  readonly title: string;
  readonly instructions: string;
  readonly declaredTools: readonly SkillToolCapability[];
  readonly enabled: boolean;
}

export interface SkillTemplate {
  readonly id: 'plan-my-day' | 'daily-briefing';
  readonly title: string;
  readonly instructions: string;
  readonly declaredTools: readonly SkillToolCapability[];
}

export const SKILL_TOOL_CAPABILITIES: readonly SkillToolCapability[] = [
  'home_task_read',
  'home_task_write',
  'home_workspace_read',
  'home_workspace_write',
  'home_action_undo'
];

export const SKILL_TEMPLATES: readonly SkillTemplate[] = [
  {
    id: 'plan-my-day',
    title: 'Plan my day',
    instructions: 'Review the permitted workspace tasks, deadlines, and selected memory. Return a realistic prioritized plan for today with time blocks. Do not claim to change tasks unless the user asks.',
    declaredTools: ['home_task_read', 'home_workspace_read']
  },
  {
    id: 'daily-briefing',
    title: 'Daily briefing',
    instructions: 'Summarize the permitted workspace tasks and deadlines for today. Highlight the most important work, blockers, and the next useful action. Do not change workspace data.',
    declaredTools: ['home_task_read']
  }
];
