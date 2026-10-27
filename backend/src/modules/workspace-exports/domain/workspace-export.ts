import type { ExportWorkspaceFile } from '@/modules/files/repositories/project-file-access';

export const WORKSPACE_EXPORT_LIMITS = {
  maxFiles: 1_000,
  maxFileBytes: 8 * 1024 * 1024,
  maxFileTotalBytes: 16 * 1024 * 1024,
  maxStructuredBytes: 8 * 1024 * 1024,
  maxDocumentBytes: 32 * 1024 * 1024,
  deadlineMs: 60_000,
  ttlMs: 15 * 60_000,
  tombstoneMs: 24 * 60 * 60_000,
  maxActivePerOwner: 2
} as const;

export interface WorkspaceExportDocument {
  readonly manifest: {
    readonly format: 'personal-ai-workspace-export';
    readonly version: 1;
    readonly createdAt: string;
    readonly databaseSnapshotAt: string;
    readonly filesReadStartedAt: string;
    readonly filesReadCompletedAt: string;
  };
  readonly workspace: { readonly id: string; readonly name: string; readonly objective: string | null };
  readonly files: readonly ExportWorkspaceFile[];
  readonly tasks: readonly WorkspaceExportTask[];
  readonly memory: {
    readonly facts: readonly WorkspaceExportFact[];
    readonly context: {
      readonly relativePaths: readonly string[];
      readonly factIds: readonly string[];
      readonly includeProjectConversations: boolean;
      readonly excludedPaths: readonly string[];
    };
  };
  readonly conversations: {
    readonly project: readonly WorkspaceExportConversation[];
    readonly home: readonly WorkspaceExportConversation[];
  };
  readonly skills: readonly WorkspaceExportSkill[];
  readonly schedules: readonly WorkspaceExportSchedule[];
}

export interface WorkspaceExportTask {
  readonly id: string;
  readonly title: string;
  readonly details: string | null;
  readonly status: string;
  readonly importance: string;
  readonly deadline: string | null;
  readonly subtasks: readonly { readonly id: string; readonly title: string; readonly completed: boolean }[];
  readonly position: number;
  readonly version: number;
  readonly source: { readonly kind: 'user' | 'assistant_suggestion'; readonly label: string; readonly acceptedAt: string | null };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface WorkspaceExportFact {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly content: string;
  readonly version: number;
  readonly verificationStatus: 'needs_review' | 'verified';
  readonly verifiedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkspaceExportConversation {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: readonly {
    readonly id: string;
    readonly turnId: string | null;
    readonly sequence: number;
    readonly role: 'user' | 'assistant';
    readonly content: string;
    readonly createdAt: string;
  }[];
}

export interface WorkspaceExportSkill {
  readonly id: string;
  readonly title: string;
  readonly instructions: string;
  readonly declaredTools: readonly string[];
  readonly enabled: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkspaceExportSchedule {
  readonly id: string;
  readonly conversationId: string;
  readonly skillId: string;
  readonly skillVersion: number;
  readonly localTime: string;
  readonly timeZone: string;
  readonly enabled: boolean;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkspaceExportSnapshot {
  readonly workspace: WorkspaceExportDocument['workspace'];
  readonly fileBacked: boolean;
  readonly databaseSnapshotAt: string;
  readonly tasks: WorkspaceExportDocument['tasks'];
  readonly facts: WorkspaceExportDocument['memory']['facts'];
  readonly context: WorkspaceExportDocument['memory']['context'];
  readonly projectConversations: WorkspaceExportDocument['conversations']['project'];
  readonly homeConversations: WorkspaceExportDocument['conversations']['home'];
  readonly skills: WorkspaceExportDocument['skills'];
  readonly schedules: WorkspaceExportDocument['schedules'];
}

export interface WorkspaceExportDescriptor {
  readonly id: string;
  readonly workspaceId: string;
  readonly sizeBytes: number;
  readonly expiresAt: string;
}

export interface WorkspaceExportBuilderIdentity {
  readonly processId: number;
  readonly startTicks: string;
}
