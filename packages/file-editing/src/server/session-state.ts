import { createHash } from "node:crypto";
import {
  EDITING_DEFAULTS,
  type EditingErrorCode,
  type EditingScope,
  type OfficeSessionStatus,
  type OfficeState,
} from "../../contracts";

/** Per-instance policy overrides support deterministic tests without deployment variables. */
export type EditingPolicy = { [K in keyof typeof EDITING_DEFAULTS]: number };
/** Authenticated owner projection; the file port rechecks the environment relationship. */
export type EditingOwner = Pick<EditingScope, "organizationId" | "userId">;
/** A registered workspace save generation and its stable transport operation. */
export interface SaveGeneration {
  id: string;
  opId: string;
  createdAt: number;
}
/** A validated provider result retained for explicit conflict resolution. */
export interface SavedResult extends SaveGeneration {
  url: string;
  digest: string;
  final: boolean;
}
/** Persisted Office control state; no document bytes or provider credentials are stored. */
export interface EditingSessionRecord {
  id: string;
  scope: EditingScope;
  path: string;
  documentKey: string;
  fileType: string;
  baselineVersion: string;
  version: string;
  state: OfficeState;
  conflict: boolean;
  lastSavedAt: number | null;
  createdAt: number;
  expiresAt: number;
  hardExpiresAt: number;
  closingUntil?: number;
  /** Provider reconnection deadline; status polling must not extend it. */
  disconnectedUntil?: number;
  revoked: boolean;
  terminal: boolean;
  commitOwner?: string;
  commitExpiresAt?: number;
  commitUnknown?: boolean;
  commitAttempt?: Pick<SavedResult, "id" | "opId" | "digest">;
  pending?: SaveGeneration;
  saveId?: string;
  requests: SaveGeneration[];
  completed: { id: string; digest: string; final: boolean; createdAt: number }[];
  result?: SavedResult;
  error?: { code: EditingErrorCode; message: string };
}

/** Merge only positive finite budgets, preserving the shared policy as the authority. */
export function editingPolicy(overrides: Partial<EditingPolicy> = {}): EditingPolicy {
  const policy = { ...EDITING_DEFAULTS, ...overrides };
  for (const value of Object.values(policy)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error("Editing policy budgets must be positive");
  }
  return policy;
}

/** Content identity used to verify conflict downloads before user-approved overwrite. */
export function contentDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A collision-free scoped reservation key that does not expose workspace paths. */
export function sessionFileKey(record: Pick<EditingSessionRecord, "scope" | "path">): string {
  return contentDigest(
    new TextEncoder().encode(
      JSON.stringify([record.scope.organizationId, record.scope.userId, record.scope.environmentId, record.path]),
    ),
  );
}

/** A terminal record stays inspectable but never retains a writable file claim. */
export function isWritable(record: EditingSessionRecord, now: number): boolean {
  return (
    !record.revoked &&
    record.state !== "closed" &&
    record.state !== "expired" &&
    record.expiresAt > now &&
    (record.closingUntil === undefined || record.closingUntil > now)
  );
}

/** A lost holder reserves enough time for the native file I/O budget before bounded failover. */
export function commitReservationMs(policy: EditingPolicy): number {
  return Math.max(EDITING_DEFAULTS.timeoutMs, policy.timeoutMs * 3, 1000);
}

/** Recover only a foreign, expired phase; elapsed time never proves that its file write succeeded. */
export function recoverAbandonedCommit(record: EditingSessionRecord, owner: string, now: number): boolean {
  if (!record.commitOwner || record.commitOwner === owner || !record.commitExpiresAt || record.commitExpiresAt > now)
    return false;
  delete record.commitOwner;
  delete record.commitExpiresAt;
  record.commitUnknown = true;
  record.revoked = true;
  record.state = "save-failed";
  record.conflict = false;
  record.error = {
    code: "unavailable",
    message: "An earlier workspace write has an unknown outcome; preserve or export the editor content",
  };
  delete record.pending;
  return true;
}

/** Project storage state without leaking provider result URLs or authorization scope. */
export function sessionStatus(record: EditingSessionRecord): OfficeSessionStatus {
  return {
    id: record.id,
    state: record.state,
    conflict: record.conflict,
    lastSavedAt: record.lastSavedAt,
    version: record.version,
    expiresAt: record.expiresAt,
    ...(record.saveId ? { saveId: record.saveId } : {}),
    ...(record.error ? { error: { ...record.error } } : {}),
  };
}
