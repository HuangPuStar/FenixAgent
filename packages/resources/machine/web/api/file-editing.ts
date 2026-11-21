import {
  type EditingClient,
  EditingError,
  type EditingErrorCode,
  type SavedFile,
  type TextSnapshot,
} from "@fenix/file-editing/contracts";
import { ApiError, request, unwrap, WRITE_TIMEOUT_MS } from "@fenix/web-runtime/api/request";
import { encodeWorkspaceUrlPath } from "./fs";

type RequestOptions = NonNullable<Parameters<typeof request>[1]>;
const errorCodes: Record<string, EditingErrorCode> = {
  version_conflict: "conflict",
  path_conflict: "conflict",
  forbidden: "forbidden",
  not_found: "not-found",
  NOT_FOUND: "not-found",
  UNAUTHORIZED: "forbidden",
  payload_too_large: "too-large",
  busy: "busy",
  expired: "expired",
  not_editable: "not-editable",
  validation_error: "invalid-input",
  VALIDATION_ERROR: "invalid-input",
  conflict: "conflict",
  "not-found": "not-found",
  "too-large": "too-large",
  "not-editable": "not-editable",
  "invalid-input": "invalid-input",
  unavailable: "unavailable",
};

async function call<T>(url: string, options?: RequestOptions): Promise<T> {
  try {
    return await unwrap(request<T>(url, options));
  } catch (error) {
    if (error instanceof ApiError)
      throw new EditingError(errorCodes[error.code] ?? "unavailable", error.message, error.data);
    throw error;
  }
}

function versioned<T extends SavedFile>(result: T): T {
  if (!result || typeof result.version !== "string" || !result.version || typeof result.size !== "number") {
    throw new EditingError("unavailable", "File service did not return a committed version");
  }
  return result;
}

const sessionUrl = (id: string) => `/web/office-edit-sessions/${encodeURIComponent(id)}`;

/** Machine's transport adapter; file-editing consumes this contract without knowing routes or auth. */
export const machineEditingClient: EditingClient = {
  capabilities: (environmentId, signal) =>
    call(`/web/environments/${encodeURIComponent(environmentId)}/file-editing-capabilities`, { signal }),
  async readText(file, signal) {
    const value = versioned(
      await call<TextSnapshot>(
        `/web/environments/${encodeURIComponent(file.environmentId)}/fs/${encodeWorkspaceUrlPath(file.path)}`,
        { query: { mode: "text", includeVersion: true }, signal },
      ),
    );
    if (typeof value.content !== "string") throw new EditingError("not-editable", "File is not editable text");
    return value;
  },
  async saveText(file, content, options) {
    return versioned(
      await call<SavedFile>(
        `/web/environments/${encodeURIComponent(file.environmentId)}/fs/${encodeWorkspaceUrlPath(file.path)}`,
        {
          method: "PUT",
          body: { content, expectedVersion: options.expectedVersion },
          opId: options.opId,
          signal: options.signal,
          timeout: WRITE_TIMEOUT_MS,
        },
      ),
    );
  },
  openOffice: (file, signal) =>
    call(`/web/environments/${encodeURIComponent(file.environmentId)}/office-edit-sessions`, {
      method: "POST",
      body: { path: file.path },
      signal,
      timeout: WRITE_TIMEOUT_MS,
    }),
  saveOffice: (id, opId, signal) =>
    call(`${sessionUrl(id)}/save`, { method: "POST", body: {}, opId, signal, timeout: WRITE_TIMEOUT_MS }),
  getSession: (id, signal) => call(sessionUrl(id), { signal }),
  overwriteOffice: (id, signal) =>
    call(`${sessionUrl(id)}/overwrite`, { method: "POST", body: {}, signal, timeout: WRITE_TIMEOUT_MS }),
  async closeOffice(id, signal) {
    await call(`${sessionUrl(id)}/close`, { method: "POST", body: {}, signal, timeout: WRITE_TIMEOUT_MS });
  },
  async discardOffice(id, signal) {
    await call(sessionUrl(id), { method: "DELETE", signal, timeout: WRITE_TIMEOUT_MS });
  },
};
