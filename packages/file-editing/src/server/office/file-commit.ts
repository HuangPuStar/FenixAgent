import { EditingError, type EditingFileAccess, type SavedFile } from "../../../contracts";
import {
  contentDigest,
  type EditingPolicy,
  type EditingSessionRecord,
  isWritable,
  type SavedResult,
} from "../session-state";
import type { EditingLease, EditingSessionStorage } from "../session-storage";

/** File commit inputs stay inside the editing domain; physical I/O belongs to the injected port. */
export interface OfficeFileCommit {
  record: EditingSessionRecord;
  result: SavedResult;
  bytes: Uint8Array;
  expectedVersion: string;
  opId: string;
  lease: EditingLease;
  files: EditingFileAccess;
  storage: EditingSessionStorage;
  policy: EditingPolicy;
  now(): number;
  controllers: Set<AbortController>;
  assertActive(): void;
  logFailure(error: unknown): void;
}

function definitiveFailure(error: unknown): boolean {
  return error instanceof EditingError && !["unavailable", "expired"].includes(error.code);
}

/** A transport can ignore cancellation; the loser remains observed without acknowledging a late result. */
async function awaitFileIO<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let aborted = () => {};
  const cancellation = new Promise<never>((_resolve, reject) => {
    aborted = () => reject(signal.reason ?? new EditingError("unavailable", "Workspace upload timed out"));
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
  try {
    return await Promise.race([operation, cancellation]);
  } finally {
    signal.removeEventListener("abort", aborted);
  }
}

async function readCommitted(input: OfficeFileCommit, signal: AbortSignal): Promise<SavedFile | undefined> {
  signal.throwIfAborted();
  const snapshot = await awaitFileIO(input.files.readSnapshot(input.record.scope, input.record.path), signal);
  return snapshot.version === input.result.digest && contentDigest(snapshot.bytes) === input.result.digest
    ? snapshot
    : undefined;
}

async function performCommit(input: OfficeFileCommit, controller: AbortController): Promise<SavedFile> {
  const { record, lease, storage } = input;
  const current = await storage.get(record.id);
  if (!current || !isWritable(current, input.now()))
    throw new EditingError("expired", "Office write permission was revoked");
  if (current.commitOwner && current.commitOwner !== lease.owner) {
    const confirmed = await readCommitted(input, controller.signal);
    if (!confirmed)
      throw new EditingError(
        "unavailable",
        "An earlier workspace write has an unknown outcome; preserve or export the editor content",
      );
    delete record.commitOwner;
    delete record.commitExpiresAt;
    delete record.commitUnknown;
    await storage.put(record, lease);
    return confirmed;
  }
  record.commitOwner = lease.owner;
  await storage.put(record, lease);
  let settled = false;
  try {
    const permission = await storage.get(record.id);
    if (!permission || permission.revoked) {
      settled = true;
      throw new EditingError("expired", "Office write permission was revoked");
    }
    if (controller.signal.aborted) {
      settled = true;
      controller.signal.throwIfAborted();
    }
    try {
      const saved = await awaitFileIO(
        input.files.upload(record.scope, record.path, input.bytes, {
          expectedVersion: input.expectedVersion,
          opId: input.opId,
          signal: controller.signal,
        }),
        controller.signal,
      );
      settled = true;
      return saved;
    } catch (error) {
      input.logFailure(error);
      try {
        const confirmed = await readCommitted(input, controller.signal);
        if (confirmed) {
          settled = true;
          return confirmed;
        }
      } catch (readError) {
        input.logFailure(readError);
      }
      if (definitiveFailure(error)) {
        settled = true;
        throw error;
      }
      // RPC rejection or elapsed time proves neither native cancellation nor a successful write.
      record.commitUnknown = true;
      throw new EditingError(
        "unavailable",
        "Workspace upload outcome is unknown; preserve or export the editor content",
      );
    }
  } finally {
    if (settled) {
      delete record.commitOwner;
      delete record.commitExpiresAt;
      delete record.commitUnknown;
      const latest = await storage.get(record.id);
      if (latest?.commitOwner === lease.owner) {
        delete latest.commitOwner;
        delete latest.commitExpiresAt;
        delete latest.commitUnknown;
        await storage.put(latest, lease);
      }
    }
  }
}

/** Bound all commit/readback I/O to one deadline; acknowledge only a receipt or exact content readback. */
export async function commitOfficeFile(input: OfficeFileCommit): Promise<SavedFile> {
  await input.lease.assertHeld();
  input.assertActive();
  const controller = new AbortController();
  input.controllers.add(controller);
  const timer = setTimeout(
    () => controller.abort(new EditingError("unavailable", "Workspace upload timed out")),
    input.policy.timeoutMs,
  );
  try {
    return await performCommit(input, controller);
  } finally {
    clearTimeout(timer);
    input.controllers.delete(controller);
  }
}
