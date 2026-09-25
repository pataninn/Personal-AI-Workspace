export type ProjectFactSourceKind = 'user' | 'conversation' | 'project_file';

export type ProjectFactVerificationStatus = 'verified' | 'needs_review';

export interface ProjectFactSource {
  readonly kind: ProjectFactSourceKind;
  readonly label: string;
  readonly reference: string | null;
}

export interface ProjectFact {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly content: string;
  readonly source: ProjectFactSource;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
  readonly verifiedAt: string | null;
  readonly verificationStatus: ProjectFactVerificationStatus;
}

export interface ProjectFactDraft {
  readonly title: string;
  readonly content: string;
}
