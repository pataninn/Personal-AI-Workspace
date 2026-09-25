import { promises as fs } from 'node:fs';

/** Read a mounted secret without copying it into application configuration. */
export async function readSecretFile(filePath: string | undefined): Promise<string> {
  if (!filePath) {
    return '';
  }
  try {
    return (await fs.readFile(filePath, 'utf8')).trim();
  } catch {
    return '';
  }
}
