import type { IWorkspaceGateway } from '@/modules/files/repositories/workspace-gateway';
import type { WorkspaceProjectScope, WorkspaceTreeNode } from '@/modules/files/domain/workspace-types';
import { WorkspaceDomainError } from '@/modules/files/domain/workspace-errors';

const MAX_DISCOVERY_FILES = 500;
const OMITTABLE_ERRORS = new Set(['WORKSPACE_FILE_UNSUPPORTED', 'WORKSPACE_FILE_BINARY', 'WORKSPACE_LIMIT_EXCEEDED',
  'WORKSPACE_PATH_FORBIDDEN', 'WORKSPACE_PATH_NOT_FOUND', 'WORKSPACE_REPARSE_POINT']);

/** Discovers readable project files locally; provider transmission happens only during a chat run. */
export async function discoverProjectContextFiles(workspace: IWorkspaceGateway, scope: WorkspaceProjectScope,
  extraPaths: readonly string[]): Promise<{ readonly paths: readonly string[]; readonly limited: boolean }> {
  const tree = await workspace.tree(scope, { directory: '', depth: 6 });
  // Explicitly added paths stay discoverable even when the tree hits its bounds.
  const candidates = [...new Set([...extraPaths, ...[...flattenFiles(tree.entries)].sort()])];
  const paths: string[] = [];
  let limited = tree.truncated || candidates.length > MAX_DISCOVERY_FILES;
  for (const path of candidates.slice(0, MAX_DISCOVERY_FILES)) {
    const file = await readEligibleFile(workspace, scope, path);
    if (file?.truncated) limited = true;
    else if (file) paths.push(path);
  }
  return { paths, limited };
}

function flattenFiles(nodes: readonly WorkspaceTreeNode[]): readonly string[] {
  return nodes.flatMap((node) => node.type === 'file' ? [node.path] : flattenFiles(node.children ?? []));
}

async function readEligibleFile(workspace: IWorkspaceGateway, scope: WorkspaceProjectScope, path: string):
  Promise<{ readonly truncated: boolean } | null> {
  try {
    return await workspace.readText(scope, { path });
  } catch (error: unknown) {
    if (error instanceof WorkspaceDomainError && OMITTABLE_ERRORS.has(error.code)) return null;
    throw error;
  }
}
