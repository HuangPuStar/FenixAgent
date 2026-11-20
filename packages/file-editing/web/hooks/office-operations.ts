import {
  EDITING_DEFAULTS,
  type EditingClient,
  EditingError,
  type FileReference,
  type OfficeSession,
  type OfficeSessionStatus,
} from "../../contracts";
import { editingError } from "./editing-errors";
import type { EditingStore } from "./editing-store";

const attempts = new WeakMap<EditingStore, Map<string, { opId: string; generation: number; saveId?: string }>>();
function pending(store: EditingStore) {
  let result = attempts.get(store);
  if (!result) {
    result = new Map();
    attempts.set(store, result);
  }
  return result;
}
function delay(signal: AbortSignal, interval: number = EDITING_DEFAULTS.pollIntervalMs): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, interval);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
/** Wait briefly for OnlyOffice's final close callback to release an existing file claim. */
export async function openOfficeSession(
  client: Pick<EditingClient, "openOffice">,
  file: FileReference,
  signal: AbortSignal,
): Promise<OfficeSession> {
  const deadline = Date.now() + 10000;
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await client.openOffice(file, signal);
    } catch (error) {
      if (!(error instanceof EditingError) || error.code !== "busy" || attempt >= 10 || Date.now() >= deadline)
        throw error;
      await delay(signal, Math.min(1000, deadline - Date.now()));
    }
  }
}
function statusFailure(status: OfficeSessionStatus): EditingError | null {
  if (status.conflict || status.state === "conflict")
    return new EditingError("conflict", status.error?.message ?? "conflict");
  if (status.state === "save-failed")
    return new EditingError(status.error?.code ?? "unavailable", status.error?.message ?? "saveFailed");
  if (status.state === "expired" || status.state === "closed") return new EditingError("expired", "sessionExpired");
  return null;
}
/** End a clean session before unmounting its iframe; failed cleanup keeps the editor available. */
export async function closeOfficeBuffer(store: EditingStore, path: string, revoke = false): Promise<boolean> {
  const session = store.buffer(path)?.session;
  if (!session) return true;
  const request = store.request(path);
  try {
    await (revoke
      ? store.client.discardOffice(session.id, request.signal)
      : store.client.closeOffice(session.id, request.signal));
    return request.valid();
  } catch (error) {
    if (!request.valid()) return false;
    const failure = editingError(error);
    if (failure.code === "expired" || failure.code === "not-found") return true;
    store.patch(path, { error: failure });
    return false;
  }
}
/** Waits for a matching committed save receipt; command acceptance alone never clears dirty. */
export async function saveOfficeBuffer(store: EditingStore, path: string): Promise<boolean> {
  const buffer = store.buffer(path);
  if (!buffer?.session) return false;
  const session = buffer.session;
  const request = store.request(path);
  const previous = pending(store).get(session.id);
  const attempt =
    previous && (previous.saveId || previous.generation === buffer.generation)
      ? previous
      : { opId: crypto.randomUUID(), generation: buffer.generation, saveId: undefined as string | undefined };
  pending(store).set(session.id, attempt);
  store.patch(path, { saving: true, error: null });
  try {
    await store.prepareOfficeSave(path, request.signal);
    if (!request.valid()) return false;
    attempt.saveId = (await store.client.saveOffice(session.id, attempt.opId, request.signal)).saveId;
    const deadline = Date.now() + EDITING_DEFAULTS.timeoutMs;
    while (request.valid()) {
      const status = await store.client.getSession(session.id, request.signal);
      if (!request.valid()) return false;
      store.patch(path, { session: { ...session, ...status }, conflict: status.conflict });
      const failure = statusFailure(status);
      if (failure) throw failure;
      if (
        status.saveId === attempt.saveId &&
        (status.state === "editing" || status.state === "closing") &&
        status.lastSavedAt !== null
      ) {
        pending(store).delete(session.id);
        store.patch(path, {
          version: status.version,
          dirty: store.buffer(path)?.generation !== attempt.generation,
          saving: false,
          savedAt: status.lastSavedAt,
        });
        store.onSaved?.({ path, version: status.version });
        return true;
      }
      if (Date.now() >= deadline) throw new EditingError("unavailable", "saveTimedOut");
      await delay(request.signal);
    }
  } catch (error) {
    if (request.valid()) {
      const failure = editingError(error);
      store.patch(path, { saving: false, error: failure, conflict: failure.code === "conflict" });
    }
  }
  return false;
}
/** Updates lifecycle feedback without destroying an expired editor or acknowledging cached content. */
export async function refreshOfficeBuffer(store: EditingStore, path: string): Promise<void> {
  const buffer = store.buffer(path);
  if (!buffer?.session || buffer.saving || buffer.loading) return;
  const request = store.request(path);
  try {
    const status = await store.client.getSession(buffer.session.id, request.signal);
    if (!request.valid()) return;
    store.patch(path, {
      session: { ...buffer.session, ...status },
      conflict: status.conflict,
      error: statusFailure(status),
    });
  } catch (error) {
    if (request.valid()) store.patch(path, { error: editingError(error) });
  }
}

/** An overwrite commits the conflicted attempt, so later provider edits must remain dirty. */
export function acknowledgeOfficeOverwrite(store: EditingStore, path: string): boolean {
  const buffer = store.buffer(path);
  if (!buffer?.session) return true;
  const generation = pending(store).get(buffer.session.id)?.generation;
  pending(store).delete(buffer.session.id);
  return buffer.dirty && buffer.generation !== generation;
}
