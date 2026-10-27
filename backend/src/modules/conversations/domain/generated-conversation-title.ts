export const DEFAULT_CONVERSATION_TITLE = 'New chat';
export const CONVERSATION_TITLE_INSTRUCTION = '\n[new-conversation-title] Name this new conversation from the current user request. Start your response with <chat_title>a concise 2–6 word title in the user’s language</chat_title> on its own line, then answer the request normally. The title is navigation metadata, not part of your answer. Do not use tools just to name the conversation.\n';

export function validGeneratedTitle(value: string): string | undefined {
  const title = value.trim().replace(/\s+/gu, ' ');
  return title.length > 0 && title.length <= 80 && !/[<>\u0000-\u001f\u007f]/u.test(value) ? title : undefined;
}

/** Buffers only the leading metadata, including a header split across streamed chunks. */
export class GeneratedConversationTitle {
  private buffer = '';
  private done: boolean;

  public constructor(enabled: boolean) { this.done = !enabled; }

  public push(chunk: string): { readonly text: string; readonly title?: string } {
    if (this.done) return { text: chunk };
    this.buffer += chunk;
    const value = this.buffer.trimStart();
    const opening = '<chat_title>';
    if (opening.startsWith(value)) return { text: '' };
    if (!value.startsWith(opening)) {
      this.done = true;
      const text = this.buffer;
      this.buffer = '';
      return { text };
    }
    const end = value.indexOf('</chat_title>');
    if (end < 0) {
      if (value.length > 512) { this.done = true; this.buffer = ''; }
      return { text: '' };
    }
    this.done = true;
    this.buffer = '';
    const title = validGeneratedTitle(value.slice(opening.length, end));
    return { text: value.slice(end + '</chat_title>'.length).replace(/^\r?\n/u, ''), ...(title ? { title } : {}) };
  }
}
