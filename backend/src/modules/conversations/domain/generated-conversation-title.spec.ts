import { GeneratedConversationTitle, validGeneratedTitle } from '@/modules/conversations/domain/generated-conversation-title';

describe('generated conversation titles', () => {
  it('separates a streamed title from the answer without showing partial metadata', () => {
    const stream = new GeneratedConversationTitle(true);
    expect(stream.push('<chat_')).toEqual({ text: '' });
    expect(stream.push('title>Data structures revision</chat_title>\nUse a stack.')).toEqual({ title: 'Data structures revision', text: 'Use a stack.' });
    expect(stream.push(' Then review queues.')).toEqual({ text: ' Then review queues.' });
  });
  it('preserves normal replies when a model omits the title', () => {
    expect(new GeneratedConversationTitle(true).push('Hello there.')).toEqual({ text: 'Hello there.' });
    expect(new GeneratedConversationTitle(false).push('<chat_title>Quoted text</chat_title>')).toEqual({ text: '<chat_title>Quoted text</chat_title>' });
  });
  it('rejects invalid metadata and still returns the answer', () => {
    expect(new GeneratedConversationTitle(true).push('<chat_title><script>bad</script></chat_title>\nAnswer')).toEqual({ text: 'Answer' });
    for (const value of ['', 'a'.repeat(81), 'bad\u0000title', 'two\nlines']) expect(validGeneratedTitle(value)).toBeUndefined();
    expect(validGeneratedTitle('  Study   plan  ')).toBe('Study plan');
  });
  it('does not turn a partial title into visible reply text', () => {
    const stream = new GeneratedConversationTitle(true);
    expect(stream.push('<chat_title>Incomplete')).toEqual({ text: '' });
    expect(stream.push('a'.repeat(600))).toEqual({ text: '' });
  });
});
