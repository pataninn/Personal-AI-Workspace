import type { WorkspaceExportBuilderIdentity } from '@/modules/workspace-exports/domain/workspace-export';

export type WorkspaceExportBuilderLiveness = 'active' | 'absent' | 'reused' | 'unknown';
export type WorkspaceExportBuilderProbe = (identity: WorkspaceExportBuilderIdentity) => Promise<WorkspaceExportBuilderLiveness>;
