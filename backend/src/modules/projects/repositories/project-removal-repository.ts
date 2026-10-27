export interface RemoveProjectRecord {
  readonly ownerId: string;
  readonly projectId: string;
  readonly expectedVersion: number;
}

export interface ProjectAutomationTurnReference {
  readonly ownerId: string;
  readonly projectId: string;
  readonly occurrenceId: string;
  readonly conversationId: string;
  readonly turnId: string;
}

export type ProjectAutomationCancellation = (input: ProjectAutomationTurnReference) => Promise<string>;

/** Removes application records, preserving the authoritative project folder. */
export interface IProjectRemovalRepository {
  remove(input: RemoveProjectRecord, cancelAutomationTurn?: ProjectAutomationCancellation): Promise<void>;
}

/** A reversible move of private backup directories before database deletion. */
export interface IProjectRecoveryQuarantine {
  restore(): Promise<void>;
  purge(): Promise<void>;
}

export interface IProjectRecoveryCleaner {
  quarantine(runIds: readonly string[]): Promise<IProjectRecoveryQuarantine>;
  restore(runIds: readonly string[]): Promise<void>;
  purge(runIds: readonly string[]): Promise<void>;
}
