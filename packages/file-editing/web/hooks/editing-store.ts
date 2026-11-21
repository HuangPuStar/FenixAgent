import {
  EDITING_DEFAULTS,
  type EditingClient,
  EditingError,
  type EditingFileChange,
  type EditingPathChange,
} from "../../contracts";
import { editingError } from "./editing-errors";
import {
  acknowledgeOfficeOverwrite,
  closeOfficeBuffer,
  finishOfficeGuard,
  openOfficeSession,
  refreshOfficeBuffer,
  saveOfficeBuffer,
} from "./office-operations";
import { checkExternalTextChange } from "./text-file-changes";
import type { EditableKind, EditingBuffer, EditingGuard, EditingSaveReceipt, OfficeSavePreparation } from "./types";

/** Stable snapshot consumed by React's external-store subscription. */
export interface EditingSnapshot {
  buffers: Readonly<Record<string, EditingBuffer>>;
  dirtyPaths: readonly string[];
  error: EditingError | null;
  guard: EditingGuard | null;
}
interface WriteAttempt {
  content: string;
  version: string;
  opId: string;
}
const bytes = (value: string) => new TextEncoder().encode(value).length;
const matches = (path: string, parent: string) => path === parent || path.startsWith(`${parent}/`);

/** Owns drafts and request generations independently of visible tab lifetimes. */
export class EditingStore {
  private environmentId = "";
  private epoch = 0;
  private active = false;
  private readonly bufferSizes = new WeakMap<EditingBuffer, number>();
  private readonly listeners = new Set<() => void>();
  private readonly requests = new Map<string, AbortController>();
  private readonly officePreparations = new Map<string, OfficeSavePreparation>();
  private readonly writes = new Map<string, WriteAttempt>();
  private readonly pendingChanges = new Set<string>();
  private readonly accessed = new Map<string, number>();
  private accessCounter = 0;
  private readonly operations = new Map<string, Promise<boolean>>();
  private readonly closures = new Map<string, Promise<boolean>>();
  private guardDone: ((allowed: boolean) => void) | null = null;
  private guardTargets: readonly string[] = [];
  private guardAction: "keep" | "close" | "refresh" = "keep";
  private snapshot: EditingSnapshot = { buffers: {}, dirtyPaths: [], error: null, guard: null };
  onSaved?: (file: EditingSaveReceipt) => void;
  constructor(public client: EditingClient) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  connect(environmentId: string) {
    this.suspend();
    const cached = environmentId === this.environmentId ? this.snapshot.buffers : {};
    if (environmentId !== this.environmentId) this.accessed.clear();
    this.environmentId = environmentId;
    this.active = true;
    this.publish({
      buffers: Object.fromEntries(
        Object.entries(cached)
          .filter(([, buffer]) => !buffer.loading || buffer.dirty || Boolean(buffer.version))
          .map(([path, buffer]) => [path, { ...buffer, loading: false, saving: false }]),
      ),
      guard: null,
      error: null,
    });
  }
  suspend() {
    this.epoch++;
    this.active = false;
    for (const request of this.requests.values()) request.abort();
    this.requests.clear();
    this.operations.clear();
    this.closures.clear();
    this.writes.clear();
    this.pendingChanges.clear();
    this.guardDone?.(false);
    this.guardDone = null;
    this.guardTargets = [];
  }
  private publish(update: Partial<EditingSnapshot>) {
    this.snapshot = { ...this.snapshot, ...update };
    this.snapshot.dirtyPaths = Object.values(this.snapshot.buffers)
      .filter((item) => item.dirty)
      .map((item) => item.path);
    for (const listener of this.listeners) listener();
  }
  patch(path: string, update: Partial<EditingBuffer>) {
    const buffer = this.snapshot.buffers[path];
    if (!buffer) return;
    const next = { ...buffer, ...update };
    if (next.content === buffer.content) this.bufferSizes.set(next, this.contentBytes(buffer));
    this.publish({ buffers: { ...this.snapshot.buffers, [path]: next } });
    // A write's own event and later external changes can arrive before its receipt; coalesce them.
    if (buffer.saving && update.saving === false && this.pendingChanges.delete(path))
      void (next.dirty ? checkExternalTextChange(this, path) : this.load(path));
  }
  buffer(path: string) {
    return this.snapshot.buffers[path];
  }
  request(path: string) {
    this.requests.get(path)?.abort();
    const controller = new AbortController();
    const epoch = this.epoch;
    const buffer = this.buffer(path);
    this.requests.set(path, controller);
    return {
      signal: controller.signal,
      valid: () =>
        this.active &&
        this.epoch === epoch &&
        !controller.signal.aborted &&
        this.buffer(path) !== undefined &&
        this.buffer(path)?.kind === buffer?.kind,
    };
  }
  file(path: string) {
    return { environmentId: this.environmentId, path };
  }
  private contentBytes(buffer: EditingBuffer): number {
    let size = this.bufferSizes.get(buffer);
    if (size === undefined) {
      size = bytes(buffer.content);
      this.bufferSizes.set(buffer, size);
    }
    return size;
  }
  private remove(path: string) {
    const sessionId = this.buffer(path)?.session?.id;
    if (sessionId) this.officePreparations.delete(sessionId);
    this.accessed.delete(path);
    this.requests.get(path)?.abort();
    this.requests.delete(path);
    this.writes.delete(path);
    const buffers = { ...this.snapshot.buffers };
    delete buffers[path];
    this.publish({ buffers });
  }
  private reserve(path: string, size: number): boolean {
    const buffers = { ...this.snapshot.buffers };
    let total = Object.values(buffers).reduce((sum, buffer) => sum + this.contentBytes(buffer), 0);
    let count = Object.keys(buffers).length;
    while ((count >= EDITING_DEFAULTS.maxBuffers && !buffers[path]) || total + size > EDITING_DEFAULTS.maxBufferBytes) {
      const canEvict = (item: EditingBuffer) => !item.dirty && !item.saving && !item.loading && item.kind !== "office";
      const candidates = Object.values(buffers)
        .filter((buffer) => buffer.path !== path && canEvict(buffer))
        .sort((left, right) => (this.accessed.get(left.path) ?? 0) - (this.accessed.get(right.path) ?? 0));
      const evicted = candidates[0];
      if (!evicted) {
        this.publish({ error: new EditingError("busy", "bufferBudget") });
        return false;
      }
      delete buffers[evicted.path];
      this.accessed.delete(evicted.path);
      total -= this.contentBytes(evicted);
      count--;
    }
    this.publish({ buffers, error: null });
    return true;
  }
  ensureLoaded = async (path: string, kind: EditableKind = "text") => {
    this.accessed.set(path, ++this.accessCounter);
    const current = this.buffer(path);
    if (current && (!current.error || current.dirty || current.loading || current.session)) return;
    if (!this.reserve(path, 0)) return;
    this.publish({
      buffers: {
        ...this.snapshot.buffers,
        [path]: current ?? {
          path,
          kind,
          content: "",
          version: "",
          dirty: false,
          loading: false,
          saving: false,
          conflict: false,
          deleted: false,
          error: null,
          generation: 0,
        },
      },
    });
    await this.load(path);
  };
  private async load(path: string) {
    const buffer = this.buffer(path);
    if (!buffer) return;
    const request = this.request(path);
    this.patch(path, { loading: true, error: null });
    try {
      if (buffer.kind === "office") {
        const session = await openOfficeSession(this.client, this.file(path), request.signal);
        if (!request.valid()) {
          await this.client.discardOffice(session.id);
          return;
        }
        this.patch(path, { session, version: session.version, loading: false });
      } else {
        const snapshot = await this.client.readText(this.file(path), request.signal);
        if (!request.valid()) return;
        const size = bytes(snapshot.content);
        if (snapshot.size > EDITING_DEFAULTS.textMaxBytes || size > EDITING_DEFAULTS.textMaxBytes)
          throw new EditingError("too-large", "textTooLarge");
        if (!this.reserve(path, size - this.contentBytes(this.buffer(path)!))) {
          this.patch(path, { loading: false, error: new EditingError("busy", "bufferBudget") });
          return;
        }
        this.writes.delete(path);
        this.patch(path, {
          content: snapshot.content,
          version: snapshot.version,
          dirty: false,
          loading: false,
          error: null,
          conflict: false,
          deleted: false,
          generation: buffer.generation + 1,
        });
        this.bufferSizes.set(this.buffer(path)!, size);
      }
    } catch (error) {
      if (request.valid()) this.patch(path, { loading: false, error: editingError(error) });
    }
  }
  updateContent = (path: string, content: string) => {
    const buffer = this.buffer(path);
    if (buffer?.kind !== "text" || buffer.loading || buffer.deleted) return;
    const size = bytes(content);
    if (size > EDITING_DEFAULTS.textMaxBytes) {
      this.patch(path, { error: new EditingError("too-large", "textTooLarge") });
      return;
    }
    if (!this.reserve(path, size - this.contentBytes(buffer))) return;
    this.patch(path, { content, dirty: true, error: null, generation: buffer.generation + 1 });
    this.bufferSizes.set(this.buffer(path)!, size);
  };
  /** Registers a cache barrier for this session without tying it to tab render identity. */
  registerOfficeSave = (path: string, prepare: OfficeSavePreparation) => {
    const id = this.buffer(path)?.session?.id;
    if (!id) return () => {};
    this.officePreparations.set(id, prepare);
    return () => {
      if (this.officePreparations.get(id) === prepare) this.officePreparations.delete(id);
    };
  };
  /** A missing iframe or false provider acknowledgement must stop workspace persistence. */
  async prepareOfficeSave(path: string, signal: AbortSignal): Promise<void> {
    const id = this.buffer(path)?.session?.id;
    const prepare = id ? this.officePreparations.get(id) : undefined;
    if (!prepare || !(await prepare(signal))) throw new EditingError("unavailable", "officeNotReady");
  }
  markOfficeDirty = (path: string, dirty: boolean) => {
    const buffer = this.buffer(path);
    // Provider 'false' only means its cache is synchronized, not that our workspace write committed.
    if (buffer?.kind === "office" && dirty) this.patch(path, { dirty: true, generation: buffer.generation + 1 });
  };
  save = (path: string): Promise<boolean> => {
    const existing = this.operations.get(path);
    if (existing) return existing;
    const buffer = this.buffer(path);
    if (!buffer || buffer.conflict || buffer.deleted || buffer.loading || buffer.saving || this.closures.has(path))
      return Promise.resolve(false);
    if (!buffer.dirty) return Promise.resolve(true);
    const operation = buffer.kind === "office" ? saveOfficeBuffer(this, path) : this.saveText(path);
    this.operations.set(path, operation);
    void operation.finally(() => {
      if (this.operations.get(path) === operation) this.operations.delete(path);
    });
    return operation;
  };
  /** A canceled attempt must not keep failed discard recovery attached to an obsolete save promise. */
  releaseCancelledOfficeSave(path: string) {
    this.operations.delete(path);
    this.patch(path, { saving: false });
  }
  private async saveText(path: string): Promise<boolean> {
    const buffer = this.buffer(path);
    if (!buffer) return false;
    const request = this.request(path);
    const previous = this.writes.get(path);
    const attempt =
      previous?.content === buffer.content && previous.version === buffer.version
        ? previous
        : { content: buffer.content, version: buffer.version, opId: crypto.randomUUID() };
    this.writes.set(path, attempt);
    this.patch(path, { saving: true, error: null });
    try {
      const saved = await this.client.saveText(this.file(path), attempt.content, {
        expectedVersion: attempt.version,
        opId: attempt.opId,
        signal: request.signal,
      });
      if (!request.valid()) return false;
      this.writes.delete(path);
      this.patch(path, {
        version: saved.version,
        dirty: this.buffer(path)?.generation !== buffer.generation,
        saving: false,
        conflict: false,
        savedAt: Date.now(),
      });
      this.onSaved?.(saved);
      return true;
    } catch (error) {
      if (request.valid()) {
        const failure = editingError(error);
        this.patch(path, { saving: false, error: failure, conflict: failure.code === "conflict" });
      }
      return false;
    }
  }
  reload = async (path: string) => {
    const buffer = this.buffer(path);
    if (!buffer || buffer.saving || buffer.loading) return;
    if (buffer.kind === "office" && buffer.session) {
      const request = this.request(path);
      this.patch(path, { loading: true, error: null });
      try {
        await this.client.discardOffice(buffer.session.id, request.signal);
        if (!request.valid()) return;
      } catch (error) {
        if (request.valid()) this.patch(path, { loading: false, error: editingError(error) });
        return;
      }
      this.patch(path, { session: undefined, dirty: false });
    }
    await this.load(path);
  };
  overwrite = async (path: string): Promise<boolean> => {
    const buffer = this.buffer(path);
    if (!buffer || buffer.saving) return false;
    const request = this.request(path);
    this.patch(path, { saving: true, error: null });
    try {
      if (buffer.kind === "office" && buffer.session) {
        const status = await this.client.overwriteOffice(buffer.session.id, request.signal);
        if (!request.valid()) return false;
        if (status.state !== "editing" || status.lastSavedAt === null)
          throw new EditingError(status.error?.code ?? "unavailable", status.error?.message ?? "saveFailed");
        this.patch(path, {
          session: { ...buffer.session, ...status },
          version: status.version,
          saving: false,
          conflict: status.conflict,
          dirty: acknowledgeOfficeOverwrite(this, path),
          savedAt: status.lastSavedAt ?? undefined,
        });
        this.onSaved?.({ path, version: status.version });
        return !status.conflict;
      }
      const fresh = await this.client.readText(this.file(path), request.signal);
      if (!request.valid()) return false;
      this.writes.delete(path);
      this.patch(path, { version: fresh.version, saving: false, conflict: false });
      return await this.save(path);
    } catch (error) {
      if (request.valid()) this.patch(path, { saving: false, error: editingError(error) });
      return false;
    }
  };
  cancelConflict = (path: string) => {
    this.patch(path, { error: null, conflict: false });
  };
  refreshOffice = async (path: string) => {
    if (!this.closures.has(path)) await refreshOfficeBuffer(this, path);
  };
  private async guardPathsInternal(paths: readonly string[], action: "keep" | "close" | "refresh"): Promise<boolean> {
    if (this.guardDone) return Promise.resolve(false);
    let affected = Object.values(this.snapshot.buffers).filter((buffer) =>
      paths.some((path) => matches(buffer.path, path)),
    );
    if (!affected.some((buffer) => buffer.dirty || buffer.saving)) {
      for (const buffer of affected.filter((buffer) => buffer.kind === "office")) {
        const pending = this.closures.get(buffer.path) ?? closeOfficeBuffer(this, buffer.path, action === "refresh");
        this.closures.set(buffer.path, pending);
        try {
          if (!(await pending)) return false;
        } finally {
          if (this.closures.get(buffer.path) === pending) this.closures.delete(buffer.path);
        }
      }
      affected = affected
        .map((buffer) => this.buffer(buffer.path))
        .filter((buffer): buffer is EditingBuffer => !!buffer);
      if (!affected.some((buffer) => buffer.dirty || buffer.saving)) {
        for (const buffer of affected) if (action !== "keep" || buffer.kind === "office") this.remove(buffer.path);
        return true;
      }
    }
    if (this.guardDone) return false;
    const guarded = affected.filter((buffer) => buffer.dirty || buffer.saving || buffer.kind === "office");
    this.guardTargets = guarded.map((buffer) => buffer.path);
    this.guardAction = action;
    const dirtyPaths = guarded.filter((buffer) => buffer.dirty || buffer.saving).map((buffer) => buffer.path);
    this.publish({ guard: { paths: dirtyPaths, error: null, busy: false } });
    return new Promise((resolve) => {
      this.guardDone = resolve;
    });
  }
  requestClose = (path: string) => this.guardPathsInternal([path], "close");
  /** Refresh revokes the old Office cache after the user's save/discard decision. */
  requestReload = (path: string) => this.guardPathsInternal([path], "refresh");
  beforeLeave = () => this.guardPathsInternal(Object.keys(this.snapshot.buffers), "close");
  guardPaths = (paths: readonly string[]) => this.guardPathsInternal(paths, "keep");
  resolveGuard = async (choice: "save" | "discard" | "cancel") => {
    const guard = this.snapshot.guard;
    if (!guard || guard.busy) return;
    const finish = (allowed: boolean) => {
      const done = this.guardDone;
      this.guardDone = null;
      this.publish({ guard: null });
      done?.(allowed);
    };
    if (choice === "cancel") {
      finish(false);
      return;
    }
    const epoch = this.epoch;
    const valid = () => this.active && this.epoch === epoch;
    this.publish({ guard: { ...guard, busy: true, error: null } });
    try {
      for (const path of this.guardTargets) {
        const buffer = this.buffer(path);
        if (!buffer) continue;
        if (choice === "save") {
          const saved = await this.save(path);
          if (!valid()) return;
          if (!saved) throw this.buffer(path)?.error ?? new EditingError("conflict", "unsavedChanges");
        }
        if (choice === "save" && this.buffer(path)?.dirty) throw new EditingError("busy", "unsavedChanges");
        if (buffer.kind === "office" && buffer.session) {
          const generation = this.buffer(path)?.generation;
          const finished = await finishOfficeGuard(this, path, choice === "discard" || this.guardAction === "refresh");
          if (!valid()) return;
          if (!finished) return finish(false);
          if (choice === "save" && (this.buffer(path)?.dirty || this.buffer(path)?.generation !== generation))
            throw new EditingError("busy", "unsavedChanges");
        }
        if (this.guardAction !== "keep" || buffer.kind === "office") this.remove(path);
        else if (choice === "discard") {
          await this.reload(path);
          if (!valid()) return;
          if (this.buffer(path)?.dirty)
            throw this.buffer(path)?.error ?? new EditingError("unavailable", "unsavedChanges");
        }
      }
      finish(true);
    } catch (error) {
      if (valid()) this.publish({ guard: { ...guard, busy: false, error: editingError(error) } });
    }
  };
  notifyFileChange = (change: EditingFileChange) => {
    for (const buffer of Object.values(this.snapshot.buffers)) {
      if (
        buffer.kind === "text" &&
        (change.kind === "invalidate-all" || change.paths.some((path) => matches(buffer.path, path)))
      ) {
        if (buffer.saving) this.pendingChanges.add(buffer.path);
        else void (buffer.dirty ? checkExternalTextChange(this, buffer.path) : this.load(buffer.path));
      }
    }
  };
  notifyPathChange = (change: EditingPathChange) => {
    for (const buffer of Object.values(this.snapshot.buffers)) {
      const moved = change.moved.find((item) => matches(buffer.path, item.oldPath));
      if (moved) {
        this.requests.get(buffer.path)?.abort();
        const path = `${moved.newPath}${buffer.path.slice(moved.oldPath.length)}`;
        const buffers = { ...this.snapshot.buffers };
        delete buffers[buffer.path];
        buffers[path] = { ...buffer, path, loading: false, saving: false };
        this.writes.delete(buffer.path);
        this.publish({ buffers });
      } else if (change.deleted.some((path) => matches(buffer.path, path))) {
        this.requests.get(buffer.path)?.abort();
        if (buffer.dirty || buffer.kind === "office")
          this.patch(buffer.path, {
            deleted: true,
            saving: false,
            error: new EditingError("not-found", "fileDeleted"),
          });
        else this.remove(buffer.path);
      }
    }
  };
}
