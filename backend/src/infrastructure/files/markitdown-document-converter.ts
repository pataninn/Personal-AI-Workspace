import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { IDocumentMarkdownConverter } from '@/modules/files/repositories/document-markdown-converter';
import { AppError } from '@/shared/errors/app-error';

const execFile = promisify(execFileCallback);
const MAX_MARKDOWN_BYTES = 512 * 1024;
const CONVERT_SCRIPT = 'import sys; from markitdown import MarkItDown; result = MarkItDown().convert_local(sys.argv[1]); sys.stdout.write(result.markdown)';

/** Converts a bounded local document using MarkItDown without allowing remote URL inputs. */
export class MarkItDownDocumentConverter implements IDocumentMarkdownConverter {
  public async convert(input: { readonly fileName: string; readonly bytes: Buffer }): Promise<Buffer> {
    const extension = path.extname(input.fileName).toLocaleLowerCase('en-US');
    const directory = await mkdtemp(path.join(tmpdir(), 'pai-document-'));
    const source = path.join(directory, `source${extension}`);
    try {
      await writeFile(source, input.bytes, { mode: 0o600, flag: 'wx' });
      const { stdout } = await execFile(process.env.MARKITDOWN_PYTHON ?? '/opt/markitdown/bin/python', ['-c', CONVERT_SCRIPT, source], {
        encoding: 'buffer', maxBuffer: MAX_MARKDOWN_BYTES + 1, timeout: 30_000, windowsHide: true,
        env: { PATH: process.env.PATH, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      });
      const markdown = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, 'utf8');
      if (markdown.length === 0) throw new AppError('DOCUMENT_CONVERSION_FAILED', 422, 'No readable text was found in this document.');
      if (markdown.length > MAX_MARKDOWN_BYTES) throw new AppError('FILE_TOO_LARGE', 413, 'The converted Markdown must be 512 KB or smaller.');
      return markdown;
    } catch (error: unknown) {
      if (error instanceof AppError) throw error;
      if (hasCode(error, 'ENOENT')) throw new AppError('DOCUMENT_CONVERTER_UNAVAILABLE', 503, 'Document conversion is unavailable. Install the configured MarkItDown runtime.');
      throw new AppError('DOCUMENT_CONVERSION_FAILED', 422, 'This document could not be converted. Try a text-based PDF or a supported Office document.');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function hasCode(value: unknown, code: string): boolean {
  return typeof value === 'object' && value !== null && 'code' in value && value.code === code;
}
