import { editingError } from "./editing-errors";
import type { EditingStore } from "./editing-store";

/** Recheck a changed text version without replacing a newer dirty draft. */
export async function checkExternalTextChange(store: EditingStore, path: string): Promise<void> {
  const buffer = store.buffer(path);
  if (!buffer) return;
  const request = store.request(path);
  try {
    const latest = await store.client.readText(store.file(path), request.signal);
    if (request.valid() && store.buffer(path)?.version === buffer.version && latest.version !== buffer.version)
      store.patch(path, { conflict: true });
  } catch (error) {
    if (!request.valid()) return;
    const failure = editingError(error);
    store.patch(path, { error: failure, deleted: failure.code === "not-found" });
  }
}
