import type { SkillToolCapability } from '@/modules/skills/domain/skill-types';

export interface ShowcaseSelection {
  readonly taskIds: readonly string[];
  readonly factIds: readonly string[];
  readonly filePaths: readonly string[];
  /** Omitted by older clients; an empty selection publishes no skills. */
  readonly skillIds?: readonly string[];
}

export interface ShowcaseSourceRequest {
  readonly projectId: string;
  readonly selection: ShowcaseSelection;
}

export interface ShowcaseChecklistItem {
  readonly title: string;
  readonly completed: boolean;
}

export interface ShowcaseTaskContent {
  readonly title: string;
  readonly details: string | null;
  readonly status: 'todo' | 'in_progress' | 'blocked' | 'done';
  readonly importance: 'low' | 'medium' | 'high' | 'urgent';
  readonly deadline: string | null;
  readonly checklist: readonly ShowcaseChecklistItem[];
}

export interface ShowcaseFactContent {
  readonly title: string;
  readonly content: string;
}

export interface ShowcaseSkillContent {
  readonly title: string;
  readonly instructions: string;
  readonly declaredTools: readonly SkillToolCapability[];
}

export interface CurrentShowcaseSkillDto extends ShowcaseSkillContent {
  readonly id: string;
}

export interface ShowcaseFileContent {
  readonly name: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly bytes: Buffer;
}

export interface ShowcasePreviewDto {
  readonly project: { readonly name: string; readonly objective: string | null };
  readonly tasks: readonly ShowcaseTaskContent[];
  readonly facts: readonly ShowcaseFactContent[];
  readonly skills: readonly ShowcaseSkillContent[];
  readonly files: readonly (Omit<ShowcaseFileContent, 'bytes'> & { readonly contentBase64: string })[];
  readonly previewDigest: string;
  readonly sourceRevision: string;
  readonly totals: { readonly itemCount: number; readonly fileCount: number; readonly snapshotBytes: number };
  readonly exclusions: readonly string[];
}

export interface CurrentShowcaseFileDto {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly byteLength: number;
}

export interface CurrentShowcaseDto {
  readonly version: string;
  readonly publishedAt: string;
  readonly project: { readonly name: string; readonly objective: string | null };
  readonly tasks: readonly (Omit<ShowcaseTaskContent, 'checklist'> & {
    readonly id: string;
    readonly checklist: readonly (ShowcaseChecklistItem & { readonly id: string })[];
  })[];
  readonly facts: readonly (ShowcaseFactContent & { readonly id: string })[];
  readonly skills: readonly CurrentShowcaseSkillDto[];
  readonly files: readonly CurrentShowcaseFileDto[];
}

export interface ShowcasePublishedResult {
  readonly version: string;
  readonly publishedAt: string;
}

export interface ShowcasePublishOutcome {
  readonly published: ShowcasePublishedResult;
  readonly statusCode: 200 | 201;
}

export interface ShowcaseCurrentFile {
  readonly file: CurrentShowcaseFileDto;
  readonly bytes: Buffer;
}

export interface ShowcaseStoredVersion {
  readonly snapshot: CurrentShowcaseDto;
  readonly files: readonly (CurrentShowcaseFileDto & { readonly sha256: string; readonly bytes: Buffer })[];
}

export interface ShowcaseCurrentSummary {
  readonly version: string;
  readonly fileCount: number;
}

export interface ShowcaseLimits {
  readonly maxSnapshotBytes: number;
  readonly maxFileBytes: number;
  readonly maxItems: number;
  readonly maxFiles: number;
  readonly maxRetainedVersions: number;
  readonly maxCopyAttempts: number;
}

export interface ShowcasePublicationSnapshot {
  readonly project: CurrentShowcaseDto['project'];
  readonly tasks: CurrentShowcaseDto['tasks'];
  readonly facts: CurrentShowcaseDto['facts'];
  readonly skills: CurrentShowcaseDto['skills'];
  readonly files: readonly (CurrentShowcaseFileDto & { readonly sha256: string; readonly bytes: Buffer })[];
}

export interface IShowcaseRepository {
  getCurrent(): Promise<CurrentShowcaseDto | null>;
  getCurrentFile(fileId: string): Promise<ShowcaseCurrentFile | null>;
  getCurrentSummary(): Promise<ShowcaseCurrentSummary | null>;
  getVersion(versionId: string): Promise<ShowcaseStoredVersion | null>;
  findPublishedReplay(adminId: string, idempotencyDigest: string, requestFingerprint: string): Promise<ShowcasePublishedResult | null>;
  publish(input: {
    readonly adminId: string;
    readonly idempotencyDigest: string;
    readonly requestFingerprint: string;
    readonly snapshot: ShowcasePublicationSnapshot;
    /** Trusted publication tooling can select up to two more immutable workspaces. */
    readonly additionalSnapshots?: readonly ShowcasePublicationSnapshot[];
    readonly contentDigest: string;
    readonly snapshotBytes: number;
    readonly itemCount: number;
    readonly maxRetainedVersions: number;
  }): Promise<ShowcasePublishedResult & { readonly replayed: boolean }>;
}
