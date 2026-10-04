import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ProjectRecoveryCleanupError } from '@/modules/projects/domain/project-errors';
import type { IProjectRecoveryCleaner, IProjectRecoveryQuarantine } from '@/modules/projects/repositories/project-removal-repository';

interface RecoveryPaths {
  readonly original: string;
  readonly quarantine: string;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function exists(directory: string): Promise<boolean> {
  try { await fs.lstat(directory); return true; } catch (error: unknown) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** Moves and removes only recovery directories belonging to database-provided run IDs. */
export class ProjectRecoveryCleaner implements IProjectRecoveryCleaner {
  private readonly root: string;

  public constructor(recoveryRoot: string) { this.root = path.resolve(recoveryRoot); }

  public async quarantine(runIds: readonly string[]): Promise<IProjectRecoveryQuarantine> {
    const directories = await this.validatedPaths(runIds);
    for (const entry of directories) {
      if (await exists(entry.quarantine)) throw new ProjectRecoveryCleanupError();
    }
    const moved: string[] = [];
    try {
      for (const [index, entry] of directories.entries()) {
        if (await exists(entry.original)) {
          await fs.rename(entry.original, entry.quarantine);
          const runId = runIds[index];
          if (runId) moved.push(runId);
        }
      }
    } catch (error: unknown) {
      await this.restore(moved);
      throw new ProjectRecoveryCleanupError();
    }
    return { restore: () => this.restore(runIds), purge: () => this.purge(runIds) };
  }

  public async restore(runIds: readonly string[]): Promise<void> {
    try {
      for (const entry of await this.validatedPaths(runIds)) {
        if (!(await exists(entry.quarantine))) continue;
        if (await exists(entry.original)) throw new ProjectRecoveryCleanupError();
        await fs.rename(entry.quarantine, entry.original);
      }
    } catch (error: unknown) { throw new ProjectRecoveryCleanupError(); }
  }

  public async purge(runIds: readonly string[]): Promise<void> {
    try {
      const entries = await this.validatedPaths(runIds);
      for (const entry of entries) {
        // Validation resolves the absolute target and rejects links before recursive removal.
        await fs.rm(entry.quarantine, { recursive: true, force: true });
      }
    } catch (error: unknown) { throw new ProjectRecoveryCleanupError(); }
  }

  private async validatedPaths(runIds: readonly string[]): Promise<readonly RecoveryPaths[]> {
    if (new Set(runIds).size !== runIds.length) throw new ProjectRecoveryCleanupError();
    const entries = runIds.map((runId) => this.paths(runId));
    if (!(await exists(this.root))) return entries;
    await this.validateRoot();
    for (const entry of entries) {
      if (await exists(entry.original)) await this.validateTree(entry.original);
      if (await exists(entry.quarantine)) await this.validateTree(entry.quarantine);
    }
    return entries;
  }

  private paths(runId: string): RecoveryPaths {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(runId)) {
      throw new ProjectRecoveryCleanupError();
    }
    return { original: path.join(this.root, `run-${runId}`), quarantine: path.join(this.root, `.removed-run-${runId}`) };
  }

  private async validateRoot(): Promise<void> {
    let current = path.parse(this.root).root;
    for (const component of path.relative(current, this.root).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ProjectRecoveryCleanupError();
    }
    if (path.resolve(await fs.realpath(this.root)).toLowerCase() !== this.root.toLowerCase()) throw new ProjectRecoveryCleanupError();
  }

  private async validateTree(directory: string): Promise<void> {
    const pending = [directory];
    let count = 0;
    while (pending.length > 0) {
      const target = pending.pop();
      if (!target || ++count > 100_000) throw new ProjectRecoveryCleanupError();
      const relative = path.relative(this.root, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new ProjectRecoveryCleanupError();
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) throw new ProjectRecoveryCleanupError();
      const canonical = path.relative(this.root, await fs.realpath(target));
      if (!canonical || canonical.startsWith('..') || path.isAbsolute(canonical)) throw new ProjectRecoveryCleanupError();
      if (stat.isDirectory()) pending.push(...(await fs.readdir(target)).map((name) => path.join(target, name)));
      else if (!stat.isFile()) throw new ProjectRecoveryCleanupError();
    }
  }
}
