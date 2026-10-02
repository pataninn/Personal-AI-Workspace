import type { ChangeSetDomainError } from '@/modules/ai-runs/domain/change-errors';

const COLLECTION_FAILURE_REASONS: Readonly<Record<string, string>> = {
  'The destination already exists.': 'It asked to create a file that already exists. Ask it to edit the existing file instead.',
  'The source file is missing or is not a regular file.': 'It asked to change a file that is missing or is not a regular file. Check the file selection in Context.',
  'The project changed before the proposed change set was collected.': 'A proposed source hash did not match the current file. Retry with the current files selected in Context.',
  'The destination is a directory.': 'It asked to rename a file to a destination that is a folder.',
  'Use a normalized relative project path.': 'A proposed file path was invalid. File paths must be relative to this project.',
  'The operation is not supported.': 'A proposed file operation was not supported.',
  'The proposed operation is duplicated.': 'It proposed the same file operation more than once.',
  'The proposed operation count is outside the safe limit.': 'It proposed too many file operations or no file operations.',
  'Rename requires a destination path.': 'A proposed rename was missing its destination file path.',
  'Only rename accepts a destination path.': 'A proposed operation included a destination path even though it was not a rename.',
  'The operation requires bounded UTF-8 file content.': 'A proposed create or edit was missing the complete file content.',
  'The proposed file content is too large.': 'A proposed file was too large. Ask for a smaller change.',
  'The proposed change set is too large.': 'The combined proposed file content was too large. Ask for fewer files.',
  'The bounded change preview is too large.': 'The combined change previews were too large. Ask for fewer files.',
  'The proposed content contains a credential-like value.': 'Proposed file content triggered the credential check.',
  'The proposed summary contains a credential-like value.': 'A proposed change summary triggered the credential check.',
  'Protected project files cannot be changed.': 'It proposed changing a protected project file.',
  'Binary file content cannot be edited as UTF-8 text.': 'It proposed a text edit to a binary file.',
  'The proposed source has no exact current hash.': 'The app could not establish the current source file version.',
  'A safe bounded preview is unavailable for this proposed operation.': 'The app could not prepare a safe preview for a proposed operation.',
  'The project is archived or unavailable for proposed changes.': 'This project is archived or unavailable.',
  'The project root is outside the authoritative workspace.': 'The project folder is outside the configured workspace.',
  'The path is outside the project.': 'A proposed file path was outside this project.',
  'The path resolves outside the project.': 'A proposed file path resolved outside this project.',
  'The target parent is not a directory.': 'A proposed file parent was not a folder.',
  'The target parent is outside the project.': 'A proposed file parent was outside this project.',
  'The target is not a supported bounded text file.': 'A proposed target was not a supported text file.',
  'The target file is too large.': 'A proposed target file was too large.',
  'Reparse points are not safe to mutate.': 'A proposed target used an unsupported filesystem link.'
};

/** Reports only fixed application reasons, never proposal text or untrusted error details. */
export function safeChangeSetCollectionFailureMessage(error: ChangeSetDomainError): string {
  const candidates = [error.message, ...error.details.map((detail) => detail.message)];
  const reason = candidates.map((message) => Object.hasOwn(COLLECTION_FAILURE_REASONS, message)
    ? COLLECTION_FAILURE_REASONS[message] : undefined).find((message) => message !== undefined);
  const message = reason ? `NVIDIA proposed file changes that the app rejected: ${reason}`
    : 'NVIDIA proposed file changes that the app rejected.';
  return `${message} No changes from this response were applied.`;
}
