import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readSecretFile } from '@/infrastructure/auth/read-secret-file';

describe('readSecretFile', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'pai-secret-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('reads and trims a mounted read-only secret without changing the file', async () => {
    const filePath = path.join(directory, 'local-user-password');
    await writeFile(filePath, '  local-password\n', { encoding: 'utf8', mode: 0o440 });

    await expect(readSecretFile(filePath)).resolves.toBe('local-password');
  });

  it('returns an empty value when no secret file is configured or readable', async () => {
    await expect(readSecretFile(undefined)).resolves.toBe('');
    await expect(readSecretFile(path.join(directory, 'missing'))).resolves.toBe('');
  });
});
