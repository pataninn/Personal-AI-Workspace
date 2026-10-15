import { canTransitionHomeTurn } from '@/modules/home-assistant/domain/home-conversation-types';

describe('canTransitionHomeTurn', () => {
  it('allows the expected forward and unknown-state reconciliation paths', () => {
    expect(canTransitionHomeTurn('pending', 'running')).toBe(true);
    expect(canTransitionHomeTurn('running', 'completed')).toBe(true);
    expect(canTransitionHomeTurn('running', 'partial')).toBe(true);
    expect(canTransitionHomeTurn('unknown', 'failed')).toBe(true);
  });

  it('allows an idempotent state update but rejects terminal-state changes', () => {
    expect(canTransitionHomeTurn('completed', 'completed')).toBe(true);
    expect(canTransitionHomeTurn('completed', 'running')).toBe(false);
    expect(canTransitionHomeTurn('pending', 'completed')).toBe(false);
    expect(canTransitionHomeTurn('unknown', 'running')).toBe(false);
  });
});
