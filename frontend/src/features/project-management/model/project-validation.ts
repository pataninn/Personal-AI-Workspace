export interface ProjectDraft {
  readonly name: string;
  readonly relativeRoot: string;
}

export interface ProjectDraftErrors {
  readonly name?: string;
  readonly relativeRoot?: string;
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

export function validateProjectDraft(draft: ProjectDraft): ProjectDraftErrors {
  const errors: { name?: string; relativeRoot?: string } = {};
  if (draft.name.trim().length === 0) {
    errors.name = 'Enter a project name.';
  }
  const root = draft.relativeRoot.trim();
  if (root.length === 0) {
    errors.relativeRoot = 'Enter a relative project root.';
  } else if (
    root.startsWith('/') ||
    root.startsWith('\\') ||
    /^[a-zA-Z]:/u.test(root) ||
    root.split(/[\\/]/u).some((segment) => segment === '..' || segment.length === 0) ||
    root.includes(':') ||
    hasControlCharacters(root)
  ) {
    errors.relativeRoot = 'Use a relative folder such as apps/website. Do not use a drive letter, leading slash, or .. segment.';
  }
  return errors;
}

export function hasProjectDraftErrors(errors: ProjectDraftErrors): boolean {
  return Boolean(errors.name || errors.relativeRoot);
}

