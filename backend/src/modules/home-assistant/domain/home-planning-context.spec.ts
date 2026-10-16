import { buildHomePlanningContext } from '@/modules/home-assistant/domain/home-planning-context';
import { HomePlanningContextTooLargeError } from '@/modules/home-assistant/domain/home-conversation-errors';

describe('buildHomePlanningContext', () => {
  it('renders the newest prior transcript suffix oldest-first and binds it to the current message', () => {
    const result = buildHomePlanningContext({
      currentMessage: 'Continue the plan.',
      priorMessages: [
        { role: 'system', content: 'Never include system data.' },
        { role: 'user', content: 'First request.' },
        { role: 'tool', content: 'Never include tool data.' },
        { role: 'assistant', content: 'First answer.' }
      ]
    });

    expect(result.prompt).toBe('User: First request.\n\nAssistant: First answer.\n\nUser: Continue the plan.');
    expect(result.categories).toEqual(['current_message', 'bounded_home_history']);
    expect(result.itemCount).toBe(3);
  });

  it('keeps no more than the newest eight eligible prior messages', () => {
    const priorMessages = Array.from({ length: 10 }, (_, index) => ({ role: 'user' as const, content: `message-${index + 1}` }));

    const result = buildHomePlanningContext({ currentMessage: 'Current.', priorMessages });

    expect(result.prompt).not.toContain('message-1\n');
    expect(result.prompt).not.toContain('message-2\n');
    expect(result.prompt).toContain('User: message-3');
    expect(result.prompt).toContain('User: message-10');
    expect(result.itemCount).toBe(9);
  });

  it('includes only the maximal newest suffix that fits the redacted 64 KiB history budget', () => {
    const result = buildHomePlanningContext({
      currentMessage: 'Current.',
      priorMessages: [
        { role: 'user', content: 'older '.repeat(7000) },
        { role: 'assistant', content: 'newest '.repeat(6000) }
      ]
    });

    expect(result.prompt).toContain(`Assistant: ${'newest '.repeat(6000).trimEnd()}`);
    expect(result.prompt).not.toContain('older');
    expect(result.itemCount).toBe(2);
  });

  it('redacts history before byte accounting and omits a newest message that alone exceeds the budget', () => {
    const redacted = buildHomePlanningContext({
      currentMessage: 'Current.',
      priorMessages: [{ role: 'user', content: `session_id=${'x'.repeat(70000)}` }]
    });
    const oversized = buildHomePlanningContext({
      currentMessage: 'Current.',
      priorMessages: [{ role: 'user', content: 'x'.repeat(70000) }]
    });

    expect(redacted.prompt).toContain('User: session_id=[REDACTED]');
    expect(redacted.itemCount).toBe(2);
    expect(oversized.prompt).toBe('User: Current.');
    expect(oversized.categories).toEqual(['current_message']);
    expect(oversized.itemCount).toBe(1);
  });

  it('measures history by UTF-8 bytes without truncating messages', () => {
    const exact = buildHomePlanningContext({ currentMessage: 'Current.', priorMessages: [{ role: 'user', content: '🙂'.repeat(16384) }] });
    const over = buildHomePlanningContext({ currentMessage: 'Current.', priorMessages: [{ role: 'user', content: '🙂'.repeat(16385) }] });

    expect(exact.itemCount).toBe(2);
    expect(exact.prompt).toContain('🙂'.repeat(16384));
    expect(over.itemCount).toBe(1);
    expect(over.prompt).toBe('User: Current.');
  });

  it('rejects a final rendered prompt over the hard provider ceiling without truncating messages', () => {
    expect(() => buildHomePlanningContext({ currentMessage: 'x'.repeat(300000), priorMessages: [] }))
      .toThrow(HomePlanningContextTooLargeError);
  });
});
