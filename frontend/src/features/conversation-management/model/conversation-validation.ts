export interface ConversationTitleErrors {
  readonly title?: string;
}

export function validateConversationTitle(title: string): ConversationTitleErrors {
  const value = title.trim();
  if (!value) {
    return { title: 'Enter a conversation name.' };
  }
  if (value.length > 160) {
    return { title: 'Use 160 characters or fewer.' };
  }
  return {};
}
