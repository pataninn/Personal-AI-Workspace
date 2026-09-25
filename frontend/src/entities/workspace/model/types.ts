export interface WorkspaceTreeNode {
  readonly path: string;
  readonly name: string;
  readonly type: 'file' | 'directory';
  readonly sizeBytes?: number;
  readonly children?: readonly WorkspaceTreeNode[];
}

export interface WorkspaceTreeResponse {
  readonly directory: string;
  readonly depth: number;
  readonly entries: readonly WorkspaceTreeNode[];
  readonly truncated: boolean;
}

export interface WorkspaceFileCandidate {
  readonly path: string;
  readonly sizeBytes: number;
}
