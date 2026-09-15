export interface MessageContentErrors {
  readonly content?: string;
}

export function validateMessageContent(content: string): MessageContentErrors {
  if (!content.trim()) {
    return { content: 'Enter a message before saving.' };
  }
  if (content.length > 20_000) {
    return { content: 'Use 20,000 characters or fewer.' };
  }
  return {};
}
