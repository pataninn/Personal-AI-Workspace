import { HomePlanningContextTooLargeError } from '@/modules/home-assistant/domain/home-conversation-errors';
import type { HomeConsentCategory, HomeMessageRole } from '@/modules/home-assistant/domain/home-conversation-types';
import { redactEgressText } from '@/shared/egress/redaction';

export const HOME_PLANNING_CONTEXT_LIMITS = {
  priorMessages: 8,
  priorTextBytes: 64 * 1024,
  promptBytes: 256 * 1024
} as const;

export interface HomePlanningContextMessage {
  readonly role: HomeMessageRole;
  readonly content: string;
}

export interface HomePlanningContext {
  readonly prompt: string;
  readonly categories: readonly HomeConsentCategory[];
  readonly itemCount: number;
}

/** Renders a fixed-cutoff Home transcript after redaction and bounded history selection. */
export function buildHomePlanningContext(input: {
  readonly currentMessage: string;
  readonly priorMessages: readonly HomePlanningContextMessage[];
}): HomePlanningContext {
  const history = selectBoundedHistory(input.priorMessages);
  const current = redactEgressText(input.currentMessage);
  const prompt = [...history, { role: 'user' as const, content: current }].map(renderMessage).join('\n\n');
  if (Buffer.byteLength(prompt, 'utf8') > HOME_PLANNING_CONTEXT_LIMITS.promptBytes) {
    throw new HomePlanningContextTooLargeError();
  }
  return {
    prompt,
    categories: history.length > 0 ? ['current_message', 'bounded_home_history'] : ['current_message'],
    itemCount: history.length + 1
  };
}

function selectBoundedHistory(messages: readonly HomePlanningContextMessage[]): readonly HomePlanningContextMessage[] {
  const candidates = messages.filter(isTranscriptRole).slice(-HOME_PLANNING_CONTEXT_LIMITS.priorMessages);
  const newestSuffix: HomePlanningContextMessage[] = [];
  let textBytes = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const source = candidates[index];
    if (!source) break;
    const candidate = redactMessage(source);
    const nextBytes = textBytes + Buffer.byteLength(candidate.content, 'utf8');
    if (nextBytes > HOME_PLANNING_CONTEXT_LIMITS.priorTextBytes) break;
    newestSuffix.push(candidate);
    textBytes = nextBytes;
  }
  return newestSuffix.reverse();
}

function isTranscriptRole(message: HomePlanningContextMessage): boolean {
  return message.role === 'user' || message.role === 'assistant';
}

function redactMessage(message: HomePlanningContextMessage): HomePlanningContextMessage {
  return { role: message.role, content: redactEgressText(message.content) };
}

function renderMessage(message: HomePlanningContextMessage): string {
  const label = message.role === 'assistant' ? 'Assistant' : 'User';
  return `${label}: ${message.content}`;
}
