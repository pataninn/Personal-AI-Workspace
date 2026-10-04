export interface RemoveProjectRecord {
  readonly ownerId: string;
  readonly projectId: string;
  readonly expectedVersion: number;
}

/** Removes application records, preserving the authoritative project folder. */
export interface IProjectRemovalRepository {
  remove(input: RemoveProjectRecord): Promise<void>;
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
