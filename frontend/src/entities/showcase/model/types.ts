export type ShowcaseTaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done' | 'archived';
export type ShowcaseTaskImportance = 'low' | 'medium' | 'high' | 'urgent';

export interface ShowcaseChecklistItem {
  readonly id: string;
  readonly title: string;
  readonly completed: boolean;
}

export interface ShowcaseTask {
  readonly id: string;
  readonly title: string;
  readonly details: string | null;
  readonly status: ShowcaseTaskStatus;
  readonly importance: ShowcaseTaskImportance;
  readonly deadline: string | null;
  readonly checklist: readonly ShowcaseChecklistItem[];
}

export interface ShowcaseFact {
  readonly id: string;
  readonly title: string;
  readonly content: string;
}

export interface ShowcaseFile {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly byteLength: number;
}

export interface CurrentShowcase {
  readonly version: string;
  readonly publishedAt: string;
  readonly project: { readonly name: string; readonly objective: string | null };
  readonly tasks: readonly ShowcaseTask[];
  readonly facts: readonly ShowcaseFact[];
  readonly files: readonly ShowcaseFile[];
}

export interface ShowcaseSelection {
  readonly taskIds: readonly string[];
  readonly factIds: readonly string[];
  readonly filePaths: readonly string[];
}

export interface ShowcasePreviewRequest {
  readonly projectId: string;
  readonly selection: ShowcaseSelection;
}

export interface ShowcasePreviewTask {
  readonly title: string;
  readonly details: string | null;
  readonly status: ShowcaseTaskStatus;
  readonly importance: ShowcaseTaskImportance;
  readonly deadline: string | null;
  readonly checklist: readonly { readonly title: string; readonly completed: boolean }[];
}

export interface ShowcasePreviewFact {
  readonly title: string;
  readonly content: string;
}

export interface ShowcasePreviewFile {
  readonly name: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly contentBase64: string;
}

export interface ShowcasePreview {
  readonly project: { readonly name: string; readonly objective: string | null };
  readonly tasks: readonly ShowcasePreviewTask[];
  readonly facts: readonly ShowcasePreviewFact[];
  readonly files: readonly ShowcasePreviewFile[];
  readonly previewDigest: string;
  readonly sourceRevision: string;
  readonly totals: { readonly itemCount: number; readonly fileCount: number; readonly snapshotBytes: number };
  readonly exclusions: readonly string[];
}

export interface PublishShowcaseRequest extends ShowcasePreviewRequest {
  readonly previewDigest: string;
  readonly sourceRevision: string;
}

export interface ShowcasePublishResult {
  readonly version: string;
  readonly publishedAt: string;
}
