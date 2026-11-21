import { randomUUID } from "node:crypto";
import { EditingError } from "../../../contracts";
import {
  commitReservationMs,
  type EditingPolicy,
  type EditingSessionRecord,
  editingPolicy,
  isWritable,
  recoverAbandonedCommit,
  sessionFileKey,
} from "../session-state";
import type { EditingLease, EditingSessionStorage } from "../session-storage";

/** Constructor options for the bounded single-process session store. */
export interface MemoryEditingStorageOptions {
  policy?: Partial<EditingPolicy>;
  now?: () => number;
}

class MemoryEditingSessionStorage implements EditingSessionStorage {
  private readonly records = new Map<string, EditingSessionRecord>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly policy: EditingPolicy;
  private readonly now: () => number;
  constructor(options: MemoryEditingStorageOptions) {
    this.policy = editingPolicy(options.policy);
    this.now = options.now ?? Date.now;
  }
  async create(record: EditingSessionRecord): Promise<void> {
    const now = this.now();
    for (const [id, value] of this.records) {
      if (!this.queues.has(id)) recoverAbandonedCommit(value, "admission", now);
      if (!value.commitOwner && value.hardExpiresAt + this.policy.receiptTtlMs < now) this.records.delete(id);
    }
    const active = [...this.records.values()].filter((value) => value.commitOwner || isWritable(value, now));
    if (active.some((value) => sessionFileKey(value) === sessionFileKey(record)))
      throw new EditingError("busy", "File already has an editing session");
    const user = active.filter(
      (value) =>
        value.scope.organizationId === record.scope.organizationId && value.scope.userId === record.scope.userId,
    );
    if (active.length >= this.policy.maxSessions || user.length >= this.policy.maxUserSessions)
      throw new EditingError("busy", "Editing session limit reached");
    // Keep terminal receipts bounded without allowing discarded sessions to exhaust admission.
    for (const [id, value] of this.records) {
      if (this.records.size < this.policy.maxSessions * 2) break;
      if (!value.commitOwner && !isWritable(value, now)) this.records.delete(id);
    }
    this.records.set(record.id, structuredClone(record));
  }
  async get(id: string): Promise<EditingSessionRecord | undefined> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }
  async put(record: EditingSessionRecord, lease: EditingLease): Promise<void> {
    await lease.assertHeld();
    if (record.commitOwner === lease.owner) record.commitExpiresAt = this.now() + commitReservationMs(this.policy);
    if (this.records.get(record.id)?.revoked && !record.revoked)
      throw new EditingError("expired", "Office write permission was revoked");
    if (
      (record.commitOwner || isWritable(record, this.now())) &&
      [...this.records.values()].some(
        (other) =>
          other.id !== record.id &&
          (other.commitOwner || isWritable(other, this.now())) &&
          sessionFileKey(other) === sessionFileKey(record),
      )
    )
      throw new EditingError("busy", "Office file claim was lost");
    this.records.set(record.id, structuredClone(record));
  }
  async revoke(id: string): Promise<boolean> {
    const record = this.records.get(id);
    if (record) {
      record.revoked = true;
      record.state = record.commitUnknown ? "save-failed" : "closed";
      delete record.pending;
    }
    return Boolean(record?.commitOwner || record?.commitUnknown);
  }
  async withLease<T>(id: string, action: (lease: EditingLease) => Promise<T>): Promise<T> {
    const before = this.queues.get(id) ?? Promise.resolve();
    let release = () => {};
    const after = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(id, after);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        before,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new EditingError("busy", "Office session is busy")), this.policy.timeoutMs);
        }),
      ]);
    } catch (error) {
      void before.then(() => {
        release();
        if (this.queues.get(id) === after) this.queues.delete(id);
      });
      throw error;
    } finally {
      clearTimeout(timer);
    }
    let held = true;
    try {
      const lease: EditingLease = {
        key: id,
        owner: randomUUID(),
        async assertHeld() {
          if (!held) throw new EditingError("busy", "Session lease was lost");
        },
      };
      const record = this.records.get(id);
      if (record) recoverAbandonedCommit(record, lease.owner, this.now());
      return await action(lease);
    } finally {
      held = false;
      release();
      if (this.queues.get(id) === after) this.queues.delete(id);
    }
  }
  async dispose(): Promise<void> {
    this.records.clear();
  }
}

/** Create bounded storage for deployments with one main service process. */
export function createMemoryEditingSessionStorage(options: MemoryEditingStorageOptions = {}): EditingSessionStorage {
  return new MemoryEditingSessionStorage(options);
}
