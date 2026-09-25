import type { ProjectFactDraft } from '@/entities/project-fact';

export interface ProjectFactDraftErrors {
  readonly title?: string;
  readonly content?: string;
}

export function validateProjectFactDraft(draft: ProjectFactDraft): ProjectFactDraftErrors {
  const title = draft.title.trim();
  const content = draft.content.trim();
  const errors: { title?: string; content?: string } = {};
  if (!title) {
    errors.title = 'Enter a fact name.';
  } else if (title.length > 120) {
    errors.title = 'Use 120 characters or fewer for the fact name.';
  }
  if (!content) {
    errors.content = 'Enter what the assistant should know.';
  } else if (new TextEncoder().encode(content).byteLength > 4096) {
    errors.content = 'Use 4,096 bytes or fewer for the fact value.';
  }
  return errors;
}
