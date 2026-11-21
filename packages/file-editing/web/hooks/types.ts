import type {
  EditingClient,
  EditingError,
  EditingFileChange,
  EditingPathChange,
  OfficeSession,
  SavedFile,
} from "../../contracts";

/** Editor family selected by the host's existing file classifier. */
export type EditableKind = "text" | "office";
/** Serializable view state; provider configuration stays inside this package. */
export interface EditingBuffer {
  readonly path: string;
  readonly kind: EditableKind;
  readonly content: string;
  readonly version: string;
  readonly dirty: boolean;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly conflict: boolean;
  readonly deleted: boolean;
  readonly error: EditingError | null;
  readonly session?: OfficeSession;
  readonly generation: number;
  readonly savedAt?: number;
}
/** A pending host operation waits for an explicit user decision. */
export interface EditingGuard {
  readonly paths: readonly string[];
  readonly error: EditingError | null;
  readonly busy: boolean;
}
/** Receipt fields actually available at the browser boundary; Office does not expose file size. */
export type EditingSaveReceipt = Pick<SavedFile, "path" | "version"> & Partial<Pick<SavedFile, "size">>;
/** Inputs supplied at the host composition boundary. */
export interface FileEditingOptions {
  environmentId: string;
  client: EditingClient;
  onSaved?: (file: EditingSaveReceipt) => void;
}
/** Provider cache barrier registered by the active iframe; no provider types escape the package. */
export type OfficeSavePreparation = (signal: AbortSignal) => Promise<boolean>;
/** Browser controller shared by the pane, tab bar and workspace operation guards. */
export interface FileEditingController {
  readonly buffers: Readonly<Record<string, EditingBuffer>>;
  readonly dirtyPaths: readonly string[];
  readonly error: EditingError | null;
  readonly guard: EditingGuard | null;
  ensureLoaded(path: string, kind?: EditableKind): Promise<void>;
  updateContent(path: string, content: string): void;
  registerOfficeSave(path: string, prepare: OfficeSavePreparation): () => void;
  markOfficeDirty(path: string, dirty: boolean): void;
  save(path: string): Promise<boolean>;
  reload(path: string): Promise<void>;
  overwrite(path: string): Promise<boolean>;
  cancelConflict(path: string): void;
  refreshOffice(path: string): Promise<void>;
  requestClose(path: string): Promise<boolean>;
  /** Request the current file's save/discard decision and revoke its old Office cache. */
  requestReload(path: string): Promise<boolean>;
  beforeLeave(): Promise<boolean>;
  guardPaths(paths: readonly string[]): Promise<boolean>;
  resolveGuard(choice: "save" | "discard" | "cancel"): Promise<void>;
  notifyFileChange(change: EditingFileChange): void;
  notifyPathChange(change: EditingPathChange): void;
}
