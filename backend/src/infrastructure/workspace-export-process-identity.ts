import { readFile } from 'node:fs/promises';

import type { WorkspaceExportBuilderIdentity } from '@/modules/workspace-exports/domain/workspace-export';
import type { WorkspaceExportBuilderLiveness } from '@/modules/workspace-exports/repositories/workspace-export-builder-probe';

export type ProcessStatReader = (pid: number) => Promise<string>;

export async function currentWorkspaceExportBuilderIdentity(): Promise<WorkspaceExportBuilderIdentity> {
  const startTicks = parseStartTicks(await readFile('/proc/self/stat', 'utf8'));
  return { processId: process.pid, startTicks };
}

export async function probeWorkspaceExportBuilder(
  identity: WorkspaceExportBuilderIdentity,
  readStat: ProcessStatReader = (pid) => readFile(`/proc/${pid}/stat`, 'utf8')
): Promise<WorkspaceExportBuilderLiveness> {
  try {
    const currentTicks = parseStartTicks(await readStat(identity.processId));
    return currentTicks === identity.startTicks ? 'active' : 'reused';
  } catch (error: unknown) {
    return isMissingProcess(error) ? 'absent' : 'unknown';
  }
}

export function parseStartTicks(stat: string): string {
  const closingParen = stat.lastIndexOf(')');
  if (closingParen < 0) throw new Error('Process stat is malformed.');
  const fields = stat.slice(closingParen + 1).trim().split(/\s+/u);
  const startTicks = fields[19];
  if (!startTicks || !/^\d+$/u.test(startTicks)) throw new Error('Process stat is malformed.');
  return startTicks;
}

function isMissingProcess(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
