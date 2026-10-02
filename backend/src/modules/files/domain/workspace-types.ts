export interface WorkspaceProjectScope {
  readonly projectId: string;
  readonly relativeRoot: string;
}

export interface WorkspaceInspectionOptions {
  readonly signal?: AbortSignal;
}

export interface WorkspaceListOptions extends WorkspaceInspectionOptions {
  readonly directory: string;
}

export interface WorkspaceTreeOptions extends WorkspaceInspectionOptions {
  readonly directory: string;
  readonly depth: number;
}

export interface WorkspaceReadOptions extends WorkspaceInspectionOptions {
  readonly path: string;
}

export interface WorkspaceSearchOptions extends WorkspaceInspectionOptions {
  readonly directory: string;
  readonly query: string;
  readonly maxResults?: number;
}

export interface WorkspaceEntry {
  readonly path: string;
  readonly name: string;
  readonly type: 'file' | 'directory';
  readonly sizeBytes?: number;
}

export interface WorkspaceListResult {
  readonly directory: string;
  readonly entries: readonly WorkspaceEntry[];
  readonly truncated: boolean;
}

export interface WorkspaceTreeNode extends WorkspaceEntry {
  readonly children?: readonly WorkspaceTreeNode[];
}

export interface WorkspaceTreeResult {
  readonly directory: string;
  readonly depth: number;
  readonly entries: readonly WorkspaceTreeNode[];
  readonly truncated: boolean;
}

export interface WorkspaceReadResult {
  readonly path: string;
  readonly content: string;
  /** SHA-256 of original file bytes before text normalization or redaction. */
  readonly sourceHash?: string;
  readonly encoding: 'utf-8';
  readonly sizeBytes: number;
  readonly lineCount: number;
  readonly truncated: boolean;
}

export interface WorkspaceSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

export interface WorkspaceSearchResult {
  readonly directory: string;
  readonly query: string;
  readonly matches: readonly WorkspaceSearchMatch[];
  readonly filesScanned: number;
  readonly truncated: boolean;
}
