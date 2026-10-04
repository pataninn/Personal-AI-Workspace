import type { IProjectFileAccess, IProjectFileGateway } from '@/modules/files/repositories/project-file-access';
import { AppError } from '@/shared/errors/app-error';

interface FileActionInput {
  readonly ownerId: string;
  readonly projectId: string;
  readonly path: string;
}

/** User-triggered file operations, independently scoped from AI context selection. */
export class ProjectFileActions {
  public constructor(private readonly access: IProjectFileAccess, private readonly gateway: IProjectFileGateway) {}

  public download(input: FileActionInput): Promise<{ readonly bytes: Buffer; readonly hash: string }> {
    return this.access.execute({ ...input, writable: false }, (scope) => this.gateway.download(scope, input.path));
  }

  public write(input: FileActionInput & { readonly bytes: Buffer; readonly expectedHash: string | null }): Promise<{ readonly hash: string }> {
    if (input.bytes.length > 8 * 1024 * 1024) throw new AppError('FILE_TOO_LARGE', 413, 'Files must be 8 MB or smaller.');
    validateHash(input.expectedHash);
    return this.access.execute({ ...input, writable: true }, (scope) => this.gateway.write(scope, input));
  }

  public remove(input: FileActionInput & { readonly expectedHash: string }): Promise<void> {
    validateHash(input.expectedHash);
    return this.access.execute({ ...input, writable: true }, (scope) => this.gateway.remove(scope, input));
  }
}

function validateHash(value: string | null): void {
  if (value !== null && !/^[a-f0-9]{64}$/u.test(value)) throw new AppError('VALIDATION_ERROR', 400, 'Refresh the file before changing it.');
}
