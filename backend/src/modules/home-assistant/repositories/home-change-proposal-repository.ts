import type { HomeConversationScope } from '@/modules/home-assistant/domain/home-conversation-types';
import type { HomeChangeProposal, HomeProposalCommand, HomeProposalDeadlineResolution, HomeProposalItemState, HomeProposalState } from '@/modules/home-assistant/domain/home-change-proposal-types';

export interface NewHomeProposalItem {
  readonly id: string;
  readonly position: number;
  readonly action: HomeProposalCommand['action'];
  readonly targetKind: 'task' | 'workspace';
  readonly targetId: string;
  readonly expectedVersion: number | null;
  readonly command: HomeProposalCommand;
  readonly deadlineResolution: HomeProposalDeadlineResolution | null;
}

export interface CreateHomeProposalInput {
  readonly id: string;
  readonly ownerId: string;
  readonly conversationId: string;
  readonly sourceTurnId: string;
  readonly scope: HomeConversationScope;
  readonly requestId: string;
  readonly requestFingerprint: string;
  readonly commandBytes: number;
  readonly items: readonly NewHomeProposalItem[];
}

export interface ListHomeProposalsInput {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly state?: HomeProposalState;
  readonly limit: number;
  readonly before?: { readonly createdAt: string; readonly id: string };
}

export interface HomeProposalListPage {
  readonly proposals: readonly Omit<HomeChangeProposal, 'items'>[];
  readonly hasMore: boolean;
  readonly lastPosition: { readonly createdAt: string; readonly id: string } | null;
}

export interface SealHomeProposalInput {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly proposalId: string;
  readonly expectedRevision: number;
  readonly acceptanceId: string;
  readonly items: readonly {
    readonly itemId: string;
    readonly operationKey: string;
    readonly requestFingerprint: string;
    readonly command: HomeProposalCommand;
    readonly deadlineResolution: HomeProposalDeadlineResolution | null;
  }[];
}

export interface UpdateHomeProposalItemInput {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly proposalId: string;
  readonly itemId: string;
  readonly expectedRevision: number;
  readonly command: HomeProposalCommand;
  readonly targetKind: 'task' | 'workspace';
  readonly targetId: string;
  readonly expectedVersion: number | null;
  readonly commandBytes: number;
  readonly deadlineResolution: HomeProposalDeadlineResolution | null;
}

export interface IHomeChangeProposalRepository {
  createDraft(input: CreateHomeProposalInput): Promise<{ readonly proposal: HomeChangeProposal; readonly replayed: boolean }>;
  getForOwner(ownerId: string, conversationId: string, proposalId: string): Promise<HomeChangeProposal | null>;
  listForOwner(input: ListHomeProposalsInput): Promise<HomeProposalListPage | null>;
  editItem(input: UpdateHomeProposalItemInput): Promise<HomeChangeProposal | null>;
  removeItem(input: { readonly ownerId: string; readonly conversationId: string; readonly proposalId: string; readonly itemId: string; readonly expectedRevision: number; readonly commandBytes: number }): Promise<HomeChangeProposal | null>;
  seal(input: SealHomeProposalInput): Promise<HomeChangeProposal | null>;
  updateExecutionState(input: { readonly ownerId: string; readonly conversationId: string; readonly proposalId: string; readonly state: Extract<HomeProposalState, 'executing' | 'partial' | 'completed' | 'unknown'> }): Promise<HomeChangeProposal | null>;
  updateItemState(input: { readonly ownerId: string; readonly conversationId: string; readonly proposalId: string; readonly itemId: string; readonly state: HomeProposalItemState; readonly resultCode?: string | null; readonly receiptId?: string | null }): Promise<HomeChangeProposal | null>;
  cancel(input: { readonly ownerId: string; readonly conversationId: string; readonly proposalId: string; readonly expectedRevision: number }): Promise<HomeChangeProposal | null>;
}
