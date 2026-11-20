import { EditingError } from "../../contracts";
import type { EditingBuffer } from "./types";
/** Normalize adapter errors while retaining their diagnostic message. */
export function editingError(error: unknown): EditingError {
  return error instanceof EditingError
    ? error
    : new EditingError("unavailable", error instanceof Error ? error.message : String(error));
}

/** A terminal or missing Office session needs replacement rather than another status poll. */
export function isExpiredOfficeBuffer(buffer: EditingBuffer | undefined): boolean {
  if (buffer?.kind !== "office") return false;
  const state = buffer.session?.state;
  return (
    buffer.error?.code === "expired" ||
    state === "expired" ||
    state === "closed" ||
    (Boolean(buffer.session) && buffer.error?.code === "not-found")
  );
}
