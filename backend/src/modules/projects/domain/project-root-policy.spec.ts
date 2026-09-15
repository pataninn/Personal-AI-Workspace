import {
  assertProjectRootDoesNotOverlap,
  normalizeProjectName,
  normalizeProjectRoot,
  projectRootOverlapKey,
  projectRootsOverlap
} from '@/modules/projects/domain/project-root-policy';

describe('project root policy', () => {
  it('normalizes Windows separators without accepting absolute paths', () => {
    expect(normalizeProjectRoot('apps\\website')).toBe('apps/website');
    expect(() => normalizeProjectRoot('C:\\PersonalAIWorkspace\\apps')).toThrow('relative folder');
    expect(() => normalizeProjectRoot('\\\\server\\share')).toThrow('relative folder');
    expect(() => normalizeProjectRoot('/workspace/apps')).toThrow('relative folder');
  });

  it('rejects traversal, control, stream, and protected segments', () => {
    expect(() => normalizeProjectRoot('../outside')).toThrow('relative folder');
    expect(() => normalizeProjectRoot('apps/../../outside')).toThrow('relative folder');
    expect(() => normalizeProjectRoot('apps/site:stream')).toThrow('relative folder');
    expect(() => normalizeProjectRoot('.git')).toThrow('protected');
    expect(() => normalizeProjectRoot('secrets/project')).toThrow('protected');
    expect(() => normalizeProjectRoot(`apps/${String.fromCharCode(0)}site`)).toThrow('relative folder');
    expect(() => normalizeProjectRoot('apps/./site')).toThrow('relative folder');
    expect(() => normalizeProjectRoot('apps/site::$DATA')).toThrow('relative folder');
  });

  it('rejects Windows trailing dot/space components and DOS devices with extensions', () => {
    for (const value of ['apps/foo.', 'apps/foo ', 'CON', 'CON.txt', 'reports/PRN.log', 'COM1.json', 'LPT9.backup']) {
      expect(() => normalizeProjectRoot(value)).toThrow('Windows');
    }
  });

  it('rejects superscript DOS device aliases and directional marks', () => {
    for (const value of ['COM¹.json', 'LPT³.backup']) {
      expect(() => normalizeProjectRoot(value)).toThrow('Windows');
    }
    for (const value of ['apps/\u061Csite', 'apps/\u200Esite', 'apps/\u200Fsite']) {
      expect(() => normalizeProjectRoot(value)).toThrow('relative folder');
    }
  });

  it('rejects architecture-reserved backup, audit, and internal segments', () => {
    for (const value of ['backup/project', 'backups/project', 'audit/project', 'audits/project', 'internal/project', '.personal-ai-backups/project', '.personal-ai-audit/project']) {
      expect(() => normalizeProjectRoot(value)).toThrow('protected');
    }
  });

  it('detects equal and parent-child overlaps case-insensitively', () => {
    expect(projectRootsOverlap('apps/site', 'apps/site')).toBe(true);
    expect(projectRootsOverlap('apps/site', 'apps/site/src')).toBe(true);
    expect(projectRootsOverlap('apps/site/src', 'apps/site')).toBe(true);
    expect(projectRootsOverlap('apps/site', 'apps/sitemap')).toBe(false);
    expect(() => assertProjectRootDoesNotOverlap('apps/site/src', ['apps/site'])).toThrow('already used');
  });

  it('uses a canonical host-semantic key for persisted overlap checks', () => {
    expect(projectRootOverlapKey('Apps\\Website')).toBe('apps/website');
    expect(projectRootsOverlap('Apps/Website/src', 'apps/website')).toBe(true);
    expect(projectRootsOverlap('apps/website', 'apps/websites')).toBe(false);
  });

  it('normalizes names and derives a stable slug', () => {
    expect(normalizeProjectName('  Website App  ')).toEqual({ name: 'Website App', slug: 'website-app' });
    expect(() => normalizeProjectName('   ')).toThrow('project name');
  });
});
