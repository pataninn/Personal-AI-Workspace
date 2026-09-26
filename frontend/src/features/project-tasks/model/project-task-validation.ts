import type { ProjectTaskDraft } from '@/entities/project-task/model/types';

export type ProjectTaskFieldErrors = {
  readonly title?: string;
  readonly details?: string;
}

export function validateProjectTaskDraft(titleValue: string, detailsValue: string): {
  readonly draft: ProjectTaskDraft;
  readonly errors: ProjectTaskFieldErrors;
} {
  const title = titleValue.trim();
  const details = detailsValue.trim();
  const errors: { title?: string; details?: string } = {};
  if (title.length === 0) {
    errors.title = 'Enter a task title.';
  } else if (Array.from(title).length > 120) {
    errors.title = 'Use 120 characters or fewer.';
  } else if (containsControlCharacters(title, false)) {
    errors.title = 'Remove control characters from the title.';
  }
  if (details.length > 0 && new TextEncoder().encode(details).length > 4096) {
    errors.details = 'Use 4,096 bytes or fewer.';
  } else if (containsControlCharacters(details, true)) {
    errors.details = 'Remove unsupported control characters from the details.';
  }
  return { draft: { title, details: details || null }, errors };
}

function containsControlCharacters(value: string, allowFormatting: boolean): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      return false;
    }
    const isControl = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    return isControl && !(allowFormatting && (character === '\n' || character === '\t'));
  });
}
