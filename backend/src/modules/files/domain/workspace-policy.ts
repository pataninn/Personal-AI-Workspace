const DEFAULT_TEXT_EXTENSIONS = [
  '.c', '.cc', '.cpp', '.cs', '.css', '.csv', '.go', '.h', '.hpp', '.html', '.java', '.js',
  '.jsx', '.json', '.md', '.mjs', '.mts', '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.svg',
  '.toml', '.ts', '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml', '.zsh'
] as const;

const DEFAULT_TEXT_FILE_NAMES = ['dockerfile', 'license', 'makefile', 'readme', 'procfile'] as const;

export interface WorkspaceInspectionPolicy {
  readonly maxPathLength: number;
  readonly maxQueryLength: number;
  readonly maxListEntries: number;
  readonly maxTreeDepth: number;
  readonly maxTreeEntries: number;
  readonly maxReadBytes: number;
  readonly maxReadLines: number;
  readonly maxReadOutputBytes: number;
  readonly maxSearchFiles: number;
  readonly maxSearchLines: number;
  readonly maxSearchMatches: number;
  readonly maxSearchFileBytes: number;
  readonly maxSearchOutputBytes: number;
  readonly maxSearchLineBytes: number;
  readonly maxDirectoryEntriesInspected?: number;
  readonly operationTimeoutMs: number;
  readonly allowedExtensions: readonly string[];
  readonly allowedFileNames: readonly string[];
}

export const DEFAULT_WORKSPACE_INSPECTION_POLICY: WorkspaceInspectionPolicy = {
  maxPathLength: 2048,
  maxQueryLength: 256,
  maxListEntries: 200,
  maxTreeDepth: 6,
  maxTreeEntries: 1000,
  maxReadBytes: 256 * 1024,
  maxReadLines: 4000,
  maxReadOutputBytes: 128 * 1024,
  maxSearchFiles: 200,
  maxSearchLines: 20_000,
  maxSearchMatches: 200,
  maxSearchFileBytes: 64 * 1024,
  maxSearchOutputBytes: 128 * 1024,
  maxSearchLineBytes: 16 * 1024,
  maxDirectoryEntriesInspected: 2048,
  operationTimeoutMs: 5000,
  allowedExtensions: DEFAULT_TEXT_EXTENSIONS,
  allowedFileNames: DEFAULT_TEXT_FILE_NAMES
};

export function isAllowedTextFile(filePath: string, policy: WorkspaceInspectionPolicy): boolean {
  // The application's broad file-access policy still validates UTF-8 bytes when reading.
  if (policy.allowedExtensions.includes('*')) return true;
  const fileName = filePath.split('/').at(-1)?.toLocaleLowerCase('en-US') ?? '';
  if (policy.allowedFileNames.includes(fileName)) {
    return true;
  }
  return policy.allowedExtensions.some((extension) => fileName.endsWith(extension));
}

export function isProtectedFileName(filePath: string): boolean {
  const fileName = filePath.split('/').at(-1)?.normalize('NFKC').toLocaleLowerCase('en-US') ?? '';
  return fileName === '.env'
    || fileName.startsWith('.env.')
    || fileName === '.npmrc'
    || fileName === '.pypirc'
    || fileName === '.netrc'
    || fileName === '.dockerconfigjson'
    || fileName === 'credentials'
    || fileName.startsWith('credentials.')
    || fileName === 'credential'
    || fileName.startsWith('credential.')
    || fileName === 'secret'
    || fileName.startsWith('secret.')
    || fileName === 'secrets'
    || fileName.startsWith('secrets.')
    || fileName === 'id_rsa'
    || fileName.startsWith('id_rsa.')
    || fileName === 'id_ed25519'
    || fileName.startsWith('id_ed25519.')
    || fileName.endsWith('.pem')
    || fileName.endsWith('.key')
    || fileName.endsWith('.p12')
    || fileName.endsWith('.pfx')
    || fileName.endsWith('.jks')
    || fileName.includes('password')
    || fileName.includes('passwd')
    || fileName.includes('api-key')
    || fileName.includes('apikey')
    || fileName.includes('access-token')
    || fileName.includes('refresh-token');
}
