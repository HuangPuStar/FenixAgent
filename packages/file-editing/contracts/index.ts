export { EDITING_DEFAULTS } from "./defaults";

/** Workspace-relative identity; physical paths and machine routing stay in the host. */
export interface FileReference {
  readonly environmentId: string;
  readonly path: string;
}

/** Authenticated ownership projection, revalidated by the host for every file operation. */
export interface EditingScope {
  readonly organizationId: string;
  readonly userId: string;
  readonly environmentId: string;
}

/** Successful file write and the version of the bytes actually committed. */
export interface SavedFile {
  readonly path: string;
  readonly size: number;
  readonly version: string;
}

/** Editable text and its matching content version. */
export interface TextSnapshot extends SavedFile {
  readonly content: string;
  readonly name: string;
  readonly encoding: string;
}

/** Errors shared by editor adapters without coupling to a host's HTTP error class. */
export type EditingErrorCode =
  | "conflict"
  | "not-found"
  | "forbidden"
  | "unavailable"
  | "too-large"
  | "not-editable"
  | "busy"
  | "expired"
  | "invalid-input";

/** Typed editing failure; details must not contain credentials or document bytes. */
export class EditingError extends Error {
  constructor(
    public readonly code: EditingErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "EditingError";
  }
}

/** Per-environment capabilities, including the actual machine's file protocol support. */
export interface EditingCapabilities {
  readonly textMaxBytes: number;
  /** Missing declarations cannot authorize text editing on older servers. */
  readonly text?: {
    readonly enabled: boolean;
    readonly reason?: string;
  };
  readonly office: {
    readonly enabled: boolean;
    readonly extensions: readonly string[];
    readonly maxBytes: number;
    readonly reason?: string;
  };
}

/** Lifecycle state reported only after the corresponding storage operation completes. */
export type OfficeState = "editing" | "saving" | "conflict" | "save-failed" | "closing" | "closed" | "expired";

/** Provider-independent session progress consumed by the editor controller. */
export interface OfficeSessionStatus {
  readonly id: string;
  readonly state: OfficeState;
  readonly conflict: boolean;
  readonly lastSavedAt: number | null;
  readonly version: string;
  readonly saveId?: string;
  readonly expiresAt: number;
  readonly error?: { readonly code: EditingErrorCode; readonly message: string };
}

/** The provider-specific initialization is opaque to Machine and interpreted inside this package. */
export interface OfficeSession extends OfficeSessionStatus {
  readonly initialization: {
    readonly scriptUrl: string;
    readonly config: Readonly<Record<string, unknown>>;
  };
  readonly maxBytes: number;
}

/** Text save conditions; a user-approved overwrite supplies a freshly read target version. */
export interface TextSaveOptions {
  readonly expectedVersion: string;
  readonly opId: string;
  readonly signal?: AbortSignal;
}

/** Browser transport supplied by the host; editors never construct backend URLs. */
export interface EditingClient {
  capabilities(environmentId: string, signal?: AbortSignal): Promise<EditingCapabilities>;
  readText(file: FileReference, signal?: AbortSignal): Promise<TextSnapshot>;
  saveText(file: FileReference, content: string, options: TextSaveOptions): Promise<SavedFile>;
  openOffice(file: FileReference, signal?: AbortSignal): Promise<OfficeSession>;
  saveOffice(id: string, opId: string, signal?: AbortSignal): Promise<{ saveId: string }>;
  getSession(id: string, signal?: AbortSignal): Promise<OfficeSessionStatus>;
  overwriteOffice(id: string, signal?: AbortSignal): Promise<OfficeSessionStatus>;
  closeOffice(id: string, signal?: AbortSignal): Promise<void>;
  discardOffice(id: string, signal?: AbortSignal): Promise<void>;
}

/** Snapshot of a regular file; the host rejects directories and binds the version to these bytes. */
export interface BinarySnapshot extends SavedFile {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

/** Current file identity used when resolving a save conflict. */
export interface EditingFileStat {
  readonly size: number;
  readonly version: string;
  readonly isDirectory: boolean;
}

/** Authorized workspace access, implemented by Machine rather than by the editing package. */
export interface EditingFileAccess {
  /** Recheck current environment ownership even when the target file no longer exists. */
  authorize(scope: EditingScope): Promise<void>;
  stat(scope: EditingScope, path: string): Promise<EditingFileStat>;
  readSnapshot(scope: EditingScope, path: string): Promise<BinarySnapshot>;
  upload(
    scope: EditingScope,
    path: string,
    bytes: Uint8Array,
    options: { expectedVersion: string; opId: string; signal?: AbortSignal },
  ): Promise<SavedFile>;
}

/** Path changes forwarded from the host's existing file event channel. */
export interface EditingFileChange {
  readonly kind: "paths" | "invalidate-all";
  readonly paths: readonly string[];
}

/** Successful workspace path mutation, independent of Machine's internal view model. */
export interface EditingPathChange {
  readonly moved: readonly { readonly oldPath: string; readonly newPath: string }[];
  readonly deleted: readonly string[];
}
