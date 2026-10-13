import type { IProjectFileAccess, IProjectFileGateway } from '@/modules/files/repositories/project-file-access';
import type { IDocumentMarkdownConverter } from '@/modules/files/repositories/document-markdown-converter';
import { AppError } from '@/shared/errors/app-error';

const CONVERTIBLE_DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.pptx', '.xlsx', '.xls', '.epub']);
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

interface FileActionInput {
  readonly ownerId: string;
  readonly projectId: string;
  readonly path: string;
}

/** User-triggered file operations, independently scoped from AI context selection. */
export class ProjectFileActions {
  public constructor(private readonly access: IProjectFileAccess, private readonly gateway: IProjectFileGateway, private readonly converter: IDocumentMarkdownConverter) {}

  public download(input: FileActionInput): Promise<{ readonly bytes: Buffer; readonly hash: string }> {
    return this.access.execute({ ...input, writable: false }, (scope) => this.gateway.download(scope, input.path));
  }

  public write(input: FileActionInput & { readonly bytes: Buffer; readonly expectedHash: string | null }): Promise<{ readonly hash: string }> {
    if (input.bytes.length > MAX_UPLOAD_BYTES) throw new AppError('FILE_TOO_LARGE', 413, 'Files must be 8 MB or smaller.');
    validateHash(input.expectedHash);
    return this.access.execute({ ...input, writable: true }, (scope) => this.gateway.write(scope, input));
  }

  public async upload(input: FileActionInput & { readonly bytes: Buffer }): Promise<{ readonly path: string; readonly converted: boolean }> {
    if (input.bytes.length > MAX_UPLOAD_BYTES) throw new AppError('FILE_TOO_LARGE', 413, 'Files must be 8 MB or smaller.');
    const extension = extensionOf(input.path);
    const converted = CONVERTIBLE_DOCUMENT_EXTENSIONS.has(extension);
    const targetPath = converted ? `${input.path.slice(0, -extension.length)}.md` : input.path;
    await this.access.execute({ ...input, writable: true }, async (scope) => {
      const bytes = converted ? await this.converter.convert({ fileName: input.path, bytes: input.bytes }) : input.bytes;
      await this.gateway.write(scope, { path: targetPath, bytes, expectedHash: null });
    });
    return { path: targetPath, converted };
  }

  public remove(input: FileActionInput & { readonly expectedHash: string }): Promise<void> {
    validateHash(input.expectedHash);
    return this.access.execute({ ...input, writable: true }, (scope) => this.gateway.remove(scope, input));
  }
}

function extensionOf(filePath: string): string {
  const name = filePath.split('/').at(-1) ?? '';
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index).toLocaleLowerCase('en-US');
}

function validateHash(value: string | null): void {
  if (value !== null && !/^[a-f0-9]{64}$/u.test(value)) throw new AppError('VALIDATION_ERROR', 400, 'Refresh the file before changing it.');
}
