import path from 'node:path';

import {
  ProjectNameInvalidError,
  ProjectRootInvalidError,
  ProjectRootOverlapError,
  ProjectRootProtectedError
} from '@/modules/projects/domain/project-errors';

const PROTECTED_SEGMENTS = new Set([
  '.git',
  '.personal-ai-workspace-identity',
  '.personal-ai',
  '.personal-ai-audit',
  '.personal-ai-backup',
  '.personal-ai-backups',
  '.personal-ai-internal',
  '.personal-ai-recovery',
  '.personal-ai-staging',
  '.audit',
  '.audits',
  '.backup',
  '.backups',
  '.internal',
  'audit',
  'audits',
  'backup',
  'backups',
  'database',
  'internal',
  'recovery',
  'secrets'
]);

const DOS_DEVICE_BASENAMES = new Set([
  'AUX',
  'CON',
  'NUL',
  'PRN'
]);

const DOS_DEVICE_WITH_NUMBER = /^(?:COM|LPT)[1-9]$/u;
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

function containsControlCharacters(value: string): boolean {
  return CONTROL_OR_BIDI.test(value);
}

function isDriveQualified(value: string): boolean {
  return /^[a-zA-Z]:($|[\\/])/u.test(value);
}

function hasAbsolutePrefix(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.startsWith('\\\\');
}

function isDosDeviceName(segment: string): boolean {
  const basename = (segment.split('.')[0] ?? '').normalize('NFKC').toLocaleUpperCase('en-US');
  return DOS_DEVICE_BASENAMES.has(basename) || DOS_DEVICE_WITH_NUMBER.test(basename);
}

function isWindowsInvalidComponent(segment: string): boolean {
  return segment.endsWith('.') || segment.endsWith(' ') || isDosDeviceName(segment);
}

export function normalizeProjectRoot(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ProjectRootInvalidError();
  }
  const trimmed = value.trim();
  const normalizedInput = value.replaceAll('\\', '/');
  if (
    trimmed.length === 0 ||
    containsControlCharacters(value) ||
    hasAbsolutePrefix(normalizedInput) ||
    isDriveQualified(normalizedInput) ||
    normalizedInput.includes(':')
  ) {
    throw new ProjectRootInvalidError('Use a relative folder such as apps/website. Do not use a drive letter or leading slash.');
  }
  const segments = normalizedInput.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new ProjectRootInvalidError('Use a relative folder such as apps/website. Do not use a leading slash or .. segment.');
  }
  if (segments.some(isWindowsInvalidComponent)) {
    throw new ProjectRootInvalidError('Use folder names that do not end with a period or space and do not use a reserved Windows device name.');
  }
  if (segments.some((segment) => PROTECTED_SEGMENTS.has(segment.normalize('NFKC').toLowerCase()))) {
    throw new ProjectRootProtectedError();
  }
  return segments.join('/');
}

export function normalizeProjectName(value: unknown): { name: string; slug: string } {
  if (typeof value !== 'string') {
    throw new ProjectNameInvalidError();
  }
  const name = value.trim();
  if (name.length < 1 || name.length > 120 || containsControlCharacters(name)) {
    throw new ProjectNameInvalidError();
  }
  const slug = name
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  if (slug.length === 0) {
    throw new ProjectNameInvalidError();
  }
  return { name, slug };
}

export function projectRootsOverlap(left: string, right: string): boolean {
  const leftSegments = projectRootOverlapKey(left).split('/');
  const rightSegments = projectRootOverlapKey(right).split('/');
  const shorter = leftSegments.length <= rightSegments.length ? leftSegments : rightSegments;
  const longer = shorter === leftSegments ? rightSegments : leftSegments;
  return shorter.every((segment, index) => segment === longer[index]);
}

/**
 * Returns the host-semantic key used for overlap checks and persistence.
 * Windows directory lookup is case-insensitive, while the user-facing value
 * remains the canonical relative path returned by the workspace adapter.
 */
export function projectRootOverlapKey(value: string): string {
  return value
    .replaceAll('\\', '/')
    .split('/')
    .map((segment) => segment.normalize('NFKC').toLocaleLowerCase('en-US'))
    .join('/');
}

export function assertProjectRootDoesNotOverlap(
  candidate: string,
  existingRoots: readonly string[]
): void {
  if (existingRoots.some((root) => projectRootsOverlap(candidate, root))) {
    throw new ProjectRootOverlapError();
  }
}
