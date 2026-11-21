import type { EditingSessionRecord } from "./session-state";

/** A renewable shared lease; callers must verify ownership immediately before side effects. */
export interface EditingLease {
  readonly key: string;
  readonly owner: string;
  assertHeld(): Promise<void>;
}

/** Shared control storage. Implementations atomically enforce file claims and session quotas. */
export interface EditingSessionStorage {
  create(record: EditingSessionRecord): Promise<void>;
  get(id: string): Promise<EditingSessionRecord | undefined>;
  put(record: EditingSessionRecord, lease: EditingLease): Promise<void>;
  /** Revoke new writes immediately; true means an already-started commit must still be drained. */
  revoke(id: string): Promise<boolean>;
  withLease<T>(id: string, action: (lease: EditingLease) => Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}
