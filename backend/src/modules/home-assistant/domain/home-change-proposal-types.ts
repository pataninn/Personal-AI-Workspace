import type { HomeConversationScope } from '@/modules/home-assistant/domain/home-conversation-types';

export type HomeProposalState = 'review_required' | 'accepted' | 'executing' | 'partial' | 'completed' | 'cancelled' | 'unknown';
export type HomeProposalItemState = 'ready' | 'executing' | 'saved' | 'failed' | 'conflicted' | 'blocked' | 'cancelled' | 'unknown';
export type HomeProposalAction = 'task.create' | 'task.update' | 'task.move' | 'task.archive' | 'workspace.create' | 'workspace.update_objective';

export interface HomeProposalDeadlineResolution {
  readonly timeZone: string;
  readonly source: 'configured' | 'utc-fallback';
}

export type HomeProposalCommand =
  | { readonly action: 'task.create'; readonly taskId: string; readonly title: string; readonly details: string | null; readonly workspaceId: string | null; readonly importance: string; readonly deadline: string | null; readonly subtasks: readonly { readonly id?: string; readonly title: string; readonly completed?: boolean }[]; readonly expectedOrderVersion?: number }
  | { readonly action: 'task.update'; readonly taskId: string; readonly expectedVersion: number; readonly title?: string; readonly details?: string | null; readonly status?: string; readonly importance?: string; readonly deadline?: string | null; readonly subtasks?: readonly { readonly id: string; readonly title: string; readonly completed: boolean }[] }
  | { readonly action: 'task.move'; readonly taskId: string; readonly expectedVersion: number; readonly workspaceId: string | null }
  | { readonly action: 'task.archive'; readonly taskId: string; readonly expectedVersion: number }
  | { readonly action: 'workspace.create'; readonly workspaceId: string; readonly name: string; readonly objective: string | null }
  | { readonly action: 'workspace.update_objective'; readonly workspaceId: string; readonly expectedVersion: number; readonly objective: string | null };

export interface HomeChangeProposalItem {
  readonly id: string;
  readonly position: number;
  readonly action: HomeProposalAction;
  readonly targetKind: 'task' | 'workspace';
  readonly targetId: string;
  readonly expectedVersion: number | null;
  readonly state: HomeProposalItemState;
  readonly operationKey: string | null;
  readonly requestFingerprint: string | null;
  readonly receiptId: string | null;
  readonly resultCode: string | null;
  readonly command: HomeProposalCommand;
  readonly deadlineResolution: HomeProposalDeadlineResolution | null;
}

export interface HomeChangeProposal {
  readonly id: string;
  readonly ownerId: string;
  readonly conversationId: string;
  readonly sourceTurnId: string;
  readonly scope: HomeConversationScope;
  readonly state: HomeProposalState;
  readonly revision: number;
  readonly acceptedRevision: number | null;
  readonly acceptanceId: string | null;
  readonly itemCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly items: readonly HomeChangeProposalItem[];
}

/** Opaque generic ledger context interpreted only by Home's injected event recorder. */
export interface HomeProposalLedgerEventContext {
  readonly kind: 'home_proposal_item';
  readonly proposalId: string;
  readonly itemId: string;
}
