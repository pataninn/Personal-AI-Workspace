export interface ProjectFactSource {
  readonly kind: 'user';
  readonly label: 'Added by you';
  readonly reference: null;
}

export type ProjectFactVerificationStatus = 'verified' | 'needs_review';

export interface ProjectFact {
  readonly id: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly key: string;
  readonly title: string;
  readonly content: string;
  readonly source: ProjectFactSource;
  readonly version: number;
  readonly verifiedAt: Date | null;
  readonly verificationStatus: ProjectFactVerificationStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function projectFactVerificationStatus(verifiedAt: Date | null): ProjectFactVerificationStatus {
  return verifiedAt ? 'verified' : 'needs_review';
}
