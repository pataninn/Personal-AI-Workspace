/** Validated model output only; project/run identity is assigned by the server. */
export interface TaskSuggestionDraft {
  readonly title: string;
  readonly details: string | null;
  readonly subtasks?: readonly { readonly title: string }[];
}
