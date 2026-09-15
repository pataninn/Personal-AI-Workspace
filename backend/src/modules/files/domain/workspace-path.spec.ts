import { WorkspacePathForbiddenError, WorkspacePathInvalidError } from '@/modules/files/domain/workspace-errors';
import { WorkspaceRelativePath } from '@/modules/files/domain/workspace-path';

describe('WorkspaceRelativePath', () => {
  it('normalizes separators while preserving Unicode file names', () => {
    expect(WorkspaceRelativePath.parse('src\\世界.ts').value).toBe('src/世界.ts');
  });

  it.each(['../outside.ts', '/workspace/file.ts', 'C:\\workspace\\file.ts', '\\\\server\\share\\file.ts', 'src/./file.ts', 'src/../file.ts', 'src/file.ts:secret'])('rejects unsafe path %s', (value) => {
    expect(() => WorkspaceRelativePath.parse(value)).toThrow(WorkspacePathInvalidError);
  });

  it.each(['.env', 'secrets/token.json', '.personal-ai-internal/recovery.log', 'src/.git/config'])('rejects protected path %s without disclosing it', (value) => {
    expect(() => WorkspaceRelativePath.parse(value)).toThrow(WorkspacePathForbiddenError);
    expect(() => WorkspaceRelativePath.parse(value)).toThrow('not available');
  });

  it.each(['COM¹.txt', 'COM².txt', 'COM³.txt', 'LPT¹.log', 'LPT².log', 'LPT³.log'])('rejects superscript Windows device path %s', (value) => {
    expect(() => WorkspaceRelativePath.parse(value)).toThrow(WorkspacePathInvalidError);
  });

  it('rejects malformed Unicode and bidi control characters', () => {
    expect(() => WorkspaceRelativePath.parse(`src/${String.fromCharCode(0xd800)}.ts`)).toThrow(WorkspacePathInvalidError);
    expect(() => WorkspaceRelativePath.parse('src/\u202Eevil.ts')).toThrow(WorkspacePathInvalidError);
  });

  it.each(['src/\u061Cfile.ts', 'src/\u200Efile.ts', 'src/\u200Ffile.ts'])('rejects invisible directional mark %s', (value) => {
    expect(() => WorkspaceRelativePath.parse(value)).toThrow(WorkspacePathInvalidError);
  });
});
