export interface ProjectDraft {
  readonly name: string;
}

export interface ProjectDraftErrors {
  readonly name?: string;
}

export function validateProjectDraft(draft: ProjectDraft): ProjectDraftErrors {
  const errors: { name?: string } = {};
  if (draft.name.trim().length === 0) {
    errors.name = 'Enter a project name.';
  }
  return errors;
}

export function hasProjectDraftErrors(errors: ProjectDraftErrors): boolean {
  return Boolean(errors.name);
}

