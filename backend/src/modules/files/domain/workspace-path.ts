import path from 'node:path';

import { WorkspacePathInvalidError, WorkspacePathForbiddenError } from '@/modules/files/domain/workspace-errors';

const DOS_DEVICE_BASENAMES = new Set(['AUX', 'CON', 'NUL', 'PRN']);
const DOS_DEVICE_WITH_NUMBER = /^(?:COM|LPT)[1-9]$/u;
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export interface WorkspaceRelativePathOptions {
  readonly allowEmpty?: boolean;
  readonly field?: string;
  readonly maxLength?: number;
}

export class WorkspaceRelativePath {
  private constructor(public readonly value: string) {}

  public static parse(value: unknown, options: WorkspaceRelativePathOptions = {}): WorkspaceRelativePath {
    const field = options.field ?? 'path';
    const maxLength = options.maxLength ?? 2048;
    if (typeof value !== 'string' || value.length > maxLength || !isWellFormedUnicode(value)) {
      throw new WorkspacePathInvalidError(field);
    }
    const normalized = value.normalize('NFC').replaceAll('\\', '/');
    if (normalized.length === 0 && options.allowEmpty === true) {
      return new WorkspaceRelativePath('');
    }
    if (normalized.length === 0 || hasUnsafePrefix(normalized) || normalized.includes(':') || CONTROL_OR_BIDI.test(normalized)) {
      throw new WorkspacePathInvalidError(field);
    }
    const segments = normalized.split('/');
    if (segments.some((segment) => !isSafeSegment(segment))) {
      throw new WorkspacePathInvalidError(field);
    }
    if (segments.some(isProtectedSegment)) {
      throw new WorkspacePathForbiddenError();
    }
    return new WorkspaceRelativePath(segments.join('/'));
  }

  public child(name: string): WorkspaceRelativePath {
    return WorkspaceRelativePath.parse(this.value.length === 0 ? name : `${this.value}/${name}`);
  }
}

function hasUnsafePrefix(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[a-zA-Z]:/u.test(value) || value.startsWith('//');
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isSafeSegment(segment: string): boolean {
  if (segment.length === 0 || segment === '.' || segment === '..' || CONTROL_OR_BIDI.test(segment)) {
    return false;
  }
  if (segment.endsWith('.') || segment.endsWith(' ')) {
    return false;
  }
  const basename = (segment.split('.')[0] ?? '').normalize('NFKC').toLocaleUpperCase('en-US');
  return !DOS_DEVICE_BASENAMES.has(basename) && !DOS_DEVICE_WITH_NUMBER.test(basename);
}

export function isProtectedSegment(segment: string): boolean {
  const normalized = segment.normalize('NFKC').toLocaleLowerCase('en-US');
  return normalized === '.env'
    || normalized.startsWith('.env.')
    || normalized === '.git'
    || normalized === '.svn'
    || normalized === '.hg'
    || normalized === 'node_modules'
    || normalized.startsWith('.personal-ai')
    || normalized === 'recovery'
    || normalized === 'recoveries'
    || normalized === 'backup'
    || normalized === 'backups'
    || normalized === 'internal'
    || normalized === 'audit'
    || normalized === 'audits'
    || normalized === 'secrets'
    || normalized === 'secret'
    || normalized === 'credentials'
    || normalized === 'credential'
    || normalized === 'keys'
    || normalized === 'private'
    || normalized === '.ssh'
    || normalized === '.aws'
    || normalized.startsWith('credentials.')
    || normalized.startsWith('credential.')
    || normalized.startsWith('secret.')
    || normalized.startsWith('secrets.')
    || normalized.endsWith('.pem')
    || normalized.endsWith('.key');
}

export function relativePathSegments(value: string): readonly string[] {
  return value.length === 0 ? [] : value.split('/');
}
