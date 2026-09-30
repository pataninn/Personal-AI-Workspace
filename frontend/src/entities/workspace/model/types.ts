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

export interface WorkspaceFileSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

export interface WorkspaceFileSearchResponse {
  readonly directory: string;
  readonly query: string;
  readonly matches: readonly WorkspaceFileSearchMatch[];
  readonly filesScanned: number;
  readonly truncated: boolean;
}
