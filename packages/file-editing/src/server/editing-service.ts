import { randomUUID } from "node:crypto";
import { createLogger } from "@fenix/logger";
import {
  type BinarySnapshot,
  EditingError,
  type EditingFileAccess,
  type EditingScope,
  type OfficeSession,
  type OfficeSessionStatus,
} from "../../contracts";
import { commitOfficeFile } from "./office/file-commit";
import {
  type EditingFetch,
  type EditingServiceConfig,
  OFFICE_EDITABLE_EXTENSIONS,
  OfficeProvider,
} from "./office/provider";
import {
  contentDigest,
  type EditingOwner,
  type EditingPolicy,
  type EditingSessionRecord,
  editingPolicy,
  isWritable,
  type SavedResult,
  sessionStatus,
} from "./session-state";
import type { EditingLease, EditingSessionStorage } from "./session-storage";
import { createMemoryEditingSessionStorage } from "./storage/memory-session-storage";

const logger = createLogger("file-editing");
/** Dependencies injected by the host; file routing, authorization and persistence stay outside. */
export interface EditingServiceOptions {
  config: EditingServiceConfig;
  files: EditingFileAccess;
  storage?: EditingSessionStorage;
  fetch?: EditingFetch;
  policy?: Partial<EditingPolicy>;
  now?: () => number;
}
/** Office editing control surface; callback routes are separate from authenticated owner actions. */
export interface EditingService {
  open(scope: EditingScope, path: string, lang?: string): Promise<OfficeSession>;
  status(owner: EditingOwner, id: string): Promise<OfficeSessionStatus>;
  save(owner: EditingOwner, id: string, opId: string): Promise<{ saveId: string }>;
  overwrite(owner: EditingOwner, id: string): Promise<OfficeSessionStatus>;
  close(owner: EditingOwner, id: string): Promise<void>;
  discard(owner: EditingOwner, id: string): Promise<void>;
  document(token: string): Promise<BinarySnapshot>;
  callback(token: string, body: unknown): Promise<{ error: number }>;
  dispose(): Promise<void>;
}

class OfficeEditingService implements EditingService {
  private readonly policy: EditingPolicy;
  private readonly now: () => number;
  private readonly storage: EditingSessionStorage;
  private readonly provider: OfficeProvider;
  private disposed = false;
  private readonly commitControllers = new Set<AbortController>();
  constructor(private readonly options: EditingServiceOptions) {
    this.policy = editingPolicy(options.policy);
    this.now = options.now ?? Date.now;
    this.storage = options.storage ?? createMemoryEditingSessionStorage({ policy: this.policy, now: this.now });
    this.provider = new OfficeProvider(options.config, options.fetch ?? fetch, this.policy, this.now);
  }
  async open(scope: EditingScope, path: string, lang?: string): Promise<OfficeSession> {
    this.available();
    if (
      Object.values(scope).some((value) => typeof value !== "string" || !value) ||
      !scope.organizationId ||
      !scope.userId ||
      !scope.environmentId
    )
      throw new EditingError("invalid-input", "An authenticated editing scope is required");
    if (
      !path ||
      path.startsWith("/") ||
      path.includes("\\") ||
      [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new EditingError("invalid-input", "A workspace-relative file path is required");
    const fileType = path.split(".").pop()?.toLowerCase() ?? "";
    if (!OFFICE_EDITABLE_EXTENSIONS.some((extension) => extension === fileType))
      throw new EditingError("not-editable", "File format is not supported for Office editing");
    const snapshot = await this.options.files.readSnapshot(scope, path);
    if (snapshot.bytes.byteLength > this.policy.maxFileBytes)
      throw new EditingError("too-large", "File exceeds editing byte limit");
    if (snapshot.version !== contentDigest(snapshot.bytes))
      throw new EditingError("unavailable", "File snapshot version does not match its content");
    const now = this.now();
    const record: EditingSessionRecord = {
      id: randomUUID(),
      scope: { organizationId: scope.organizationId, userId: scope.userId, environmentId: scope.environmentId },
      path,
      documentKey: `of_${randomUUID()}`,
      fileType,
      baselineVersion: snapshot.version,
      version: snapshot.version,
      state: "editing",
      conflict: false,
      lastSavedAt: null,
      createdAt: now,
      expiresAt: now + Math.min(this.policy.idleTtlMs, this.policy.maxSessionAgeMs),
      hardExpiresAt: now + this.policy.maxSessionAgeMs,
      revoked: false,
      terminal: false,
      requests: [],
      completed: [],
    };
    const initialization = await this.provider.initialization(record, lang);
    await this.storage.create(record);
    logger.info("Office session opened", { sessionId: record.id });
    return { ...sessionStatus(record), initialization, maxBytes: this.policy.maxFileBytes };
  }
  async status(owner: EditingOwner, id: string): Promise<OfficeSessionStatus> {
    return this.storage.withLease(id, async (lease) => {
      const record = await this.owned(owner, id);
      if (!record.commitUnknown && !isWritable(record, this.now()) && record.state !== "closed") this.expire(record);
      else this.touch(record);
      if (record.state === "saving" && record.pending && this.now() - record.pending.createdAt >= this.policy.timeoutMs)
        await this.failed(
          record,
          new EditingError("unavailable", "Workspace save callback timed out; retry saving"),
          lease,
        );
      await this.storage.put(record, lease);
      return sessionStatus(record);
    });
  }
  async save(owner: EditingOwner, id: string, opId: string): Promise<{ saveId: string }> {
    if (!/^[\w.:-]{1,200}$/.test(opId))
      throw new EditingError("invalid-input", "A stable save operation ID is required");
    return this.storage.withLease(id, async (lease) => {
      const record = await this.owned(owner, id);
      this.active(record);
      record.requests = record.requests.filter((request) => this.now() - request.createdAt < this.policy.receiptTtlMs);
      const duplicate = record.requests.find((request) => request.opId === opId);
      if (duplicate && (record.state !== "save-failed" || record.pending?.id !== duplicate.id))
        return { saveId: duplicate.id };
      if (record.pending && record.state !== "save-failed") return { saveId: record.pending.id };
      if (record.terminal || record.state === "closing") throw new EditingError("busy", "Office session is closing");
      if (record.conflict) throw new EditingError("conflict", "Resolve the file conflict before saving");
      const generation =
        record.pending?.opId === opId ? record.pending : { id: randomUUID(), opId, createdAt: this.now() };
      generation.createdAt = this.now();
      record.pending = generation;
      record.saveId = generation.id;
      record.state = "saving";
      delete record.error;
      if (!record.requests.some((request) => request.id === generation.id))
        record.requests = [...record.requests.slice(-63), generation];
      this.touch(record);
      await this.storage.put(record, lease);
      try {
        const result = await this.provider.forceSave(record, generation.id);
        if (result === 4) {
          const current = await this.options.files.stat(record.scope, record.path);
          if (current.version !== record.version) {
            record.state = "conflict";
            record.conflict = true;
            record.error = { code: "conflict", message: "Workspace file changed" };
          } else {
            throw new EditingError(
              "unavailable",
              "Document provider has not confirmed cached changes; wait for synchronization and retry",
            );
          }
          delete record.pending;
        } else if (result !== 0) throw new EditingError("unavailable", "Document service rejected save command");
        await this.storage.put(record, lease);
      } catch (error) {
        throw await this.failed(record, error, lease);
      }
      return { saveId: generation.id };
    });
  }
  async overwrite(owner: EditingOwner, id: string): Promise<OfficeSessionStatus> {
    return this.storage.withLease(id, async (lease) => {
      const record = await this.owned(owner, id);
      this.active(record);
      if (!record.conflict || !record.result)
        throw new EditingError("invalid-input", "No conflict result is available for overwrite");
      try {
        const result = record.result;
        const bytes = await this.provider.download(result.url);
        if (contentDigest(bytes) !== result.digest)
          throw new EditingError("conflict", "Document result changed; overwrite was refused");
        const current = await this.options.files.stat(record.scope, record.path);
        await this.commit(record, result, bytes, current.version, `${result.opId}:overwrite:${current.version}`, lease);
      } catch (error) {
        throw await this.failed(record, error, lease);
      }
      return sessionStatus(record);
    });
  }
  async close(owner: EditingOwner, id: string): Promise<void> {
    await this.storage.withLease(id, async (lease) => {
      const record = await this.owned(owner, id);
      if (record.state === "closed") return;
      this.active(record);
      record.state = "closing";
      record.closingUntil = Math.min(record.hardExpiresAt, this.now() + this.policy.closingGraceMs);
      record.expiresAt = record.closingUntil;
      await this.storage.put(record, lease);
    });
  }
  async discard(owner: EditingOwner, id: string): Promise<void> {
    await this.owned(owner, id);
    // Revocation bypasses the save lease so a result still downloading loses permission immediately.
    const committing = await this.storage.revoke(id);
    if (committing)
      await this.storage.withLease(id, async () => {
        const current = await this.storage.get(id);
        if (current?.commitUnknown)
          throw new EditingError(
            "unavailable",
            current.error?.message ?? "The previous file commit has an unknown outcome",
          );
        if (current?.commitOwner)
          throw new EditingError("busy", "The previous file commit has not been confirmed complete");
      });
    logger.info("Office session discarded", { sessionId: id });
  }
  async document(token: string): Promise<BinarySnapshot> {
    this.available();
    const reference = await this.provider.reference(token, "document");
    const record = await this.storage.get(reference.id);
    if (!record || !reference.matches(record)) throw new EditingError("not-found", "Office session does not exist");
    this.active(record);
    const snapshot = await this.options.files.readSnapshot(record.scope, record.path);
    if (snapshot.bytes.byteLength > this.policy.maxFileBytes)
      throw new EditingError("too-large", "File exceeds editing byte limit");
    if (snapshot.version !== record.baselineVersion || snapshot.version !== contentDigest(snapshot.bytes))
      throw new EditingError("conflict", "Workspace file changed before document loading");
    return snapshot;
  }
  async callback(token: string, body: unknown): Promise<{ error: number }> {
    let id: string | undefined;
    try {
      this.available();
      const reference = await this.provider.reference(token, "callback");
      id = reference.id;
      const fields = await this.provider.callback(body);
      return await this.storage.withLease(id, async (lease) => {
        const record = await this.storage.get(reference.id);
        if (!record || !reference.matches(record) || fields.key !== record.documentKey)
          throw new EditingError("forbidden", "Callback does not match a valid Office session");
        if (record.revoked || record.expiresAt <= this.now())
          throw new EditingError("expired", "Office session is no longer writable");
        await this.options.files.authorize(record.scope);
        this.touch(record);
        await this.storage.put(record, lease);
        if (fields.status === 1) {
          this.active(record);
          await this.storage.put(record, lease);
          return { error: 0 };
        }
        if (fields.status === 4) {
          this.active(record);
          record.terminal = true;
          record.state = "closed";
          delete record.pending;
          await this.storage.put(record, lease);
          return { error: 0 };
        }
        if (fields.status === 3 || fields.status === 7) {
          if (record.state === "closed" || (fields.status === 7 && fields.userdata !== record.pending?.id))
            return { error: 1 };
          if (fields.status === 3) record.terminal = true;
          await this.failed(record, new EditingError("unavailable", "Document service could not save the file"), lease);
          return { error: 1 };
        }
        if (fields.status !== 2 && fields.status !== 6) return { error: 1 };
        const final = fields.status === 2;
        const saveId = final ? `final:${record.documentKey}` : fields.userdata;
        if (!final && record.terminal) return { error: 1 };
        const completed = record.completed.find(
          (item) => item.id === saveId && this.now() - item.createdAt < this.policy.receiptTtlMs,
        );
        if (completed) {
          if (completed.final !== final || fields.filetype !== record.fileType || !fields.url) return { error: 1 };
          const bytes = await this.provider.download(fields.url);
          return { error: contentDigest(bytes) === completed.digest ? 0 : 1 };
        }
        this.active(record);
        if (!final && (!saveId || record.pending?.id !== saveId)) return { error: 1 };
        if (final) {
          record.terminal = true;
          delete record.pending;
        }
        const opId = final ? `office-final:${record.id}` : record.pending?.opId;
        if (!opId || !saveId) return { error: 1 };
        try {
          if (fields.filetype !== record.fileType || !fields.url)
            throw new EditingError("invalid-input", "Document result format or URL does not match the file");
          const bytes = await this.provider.download(fields.url);
          const result: SavedResult = {
            id: saveId,
            opId,
            final,
            url: fields.url,
            digest: contentDigest(bytes),
            createdAt: this.now(),
          };
          if (!final && record.conflict && record.result) {
            if (record.result.id !== saveId || record.result.digest !== result.digest) return { error: 1 };
            await this.storage.put(record, lease);
            return { error: 0 };
          }
          record.result = result;
          await this.commit(record, result, bytes, record.version, opId, lease);
          return { error: 0 };
        } catch (error) {
          await this.failed(record, error, lease);
          return { error: record.conflict && record.result ? 0 : 1 };
        }
      });
    } catch (error) {
      this.logFailure(id, error);
      return { error: 1 };
    }
  }
  private async commit(
    record: EditingSessionRecord,
    result: SavedResult,
    bytes: Uint8Array,
    expectedVersion: string,
    opId: string,
    lease: EditingLease,
  ): Promise<void> {
    const saved = await commitOfficeFile({
      record,
      result,
      bytes,
      expectedVersion,
      opId,
      lease,
      files: this.options.files,
      storage: this.storage,
      policy: this.policy,
      now: this.now,
      controllers: this.commitControllers,
      assertActive: () => this.active(record),
      logFailure: (error) => this.logFailure(record.id, error),
    });
    record.version = saved.version;
    record.lastSavedAt = this.now();
    record.conflict = false;
    record.completed = [
      ...record.completed.slice(-63),
      { id: result.id, digest: result.digest, final: result.final, createdAt: this.now() },
    ];
    record.state = result.final ? "closed" : record.closingUntil ? "closing" : "editing";
    delete record.pending;
    delete record.result;
    delete record.error;
    this.touch(record);
    await this.storage.put(record, lease);
    logger.info("Office file saved", { sessionId: record.id, final: result.final });
  }
  private async owned(owner: EditingOwner, id: string): Promise<EditingSessionRecord> {
    this.available();
    const record = await this.storage.get(id);
    if (!record || owner.organizationId !== record.scope.organizationId || owner.userId !== record.scope.userId)
      throw new EditingError("not-found", "Office session does not exist");
    await this.options.files.authorize(record.scope);
    return record;
  }
  private available(): void {
    if (this.disposed) throw new EditingError("unavailable", "Editing service has stopped");
  }
  private active(record: EditingSessionRecord): void {
    this.available();
    if (!isWritable(record, this.now()))
      throw new EditingError(
        record.revoked || record.state === "closed" ? "not-found" : "expired",
        "Office session is no longer writable",
      );
  }
  private touch(record: EditingSessionRecord): void {
    if (isWritable(record, this.now()))
      record.expiresAt = Math.min(record.hardExpiresAt, record.closingUntil ?? this.now() + this.policy.idleTtlMs);
  }
  private expire(record: EditingSessionRecord): void {
    record.state = "expired";
    record.revoked = true;
    delete record.pending;
  }
  private async failed(record: EditingSessionRecord, error: unknown, lease: EditingLease): Promise<EditingError> {
    const typed = error instanceof EditingError ? error : new EditingError("unavailable", "Office save failed");
    record.conflict = typed.code === "conflict" || record.conflict;
    record.state = record.conflict ? "conflict" : "save-failed";
    record.error = { code: typed.code, message: typed.message };
    this.logFailure(record.id, error);
    await this.storage.put(record, lease);
    return typed;
  }
  private logFailure(id: string | undefined, error: unknown): void {
    // Provider errors may embed signed URLs; record only safe type/code diagnostics.
    logger.warn("Office operation failed", {
      sessionId: id,
      errorType: error instanceof Error ? error.name : typeof error,
      code: error instanceof EditingError ? error.code : "unavailable",
    });
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.provider.dispose();
    for (const controller of this.commitControllers)
      controller.abort(new EditingError("unavailable", "Editing service stopped"));
    if (!this.options.storage) await this.storage.dispose();
  }
}

/** Create an isolated provider adapter over host-authorized file operations. */
export function createEditingService(options: EditingServiceOptions): EditingService {
  return new OfficeEditingService(options);
}
