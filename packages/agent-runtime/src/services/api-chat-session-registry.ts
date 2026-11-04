import { randomBytes } from "node:crypto";
import { AppError } from "@fenix/platform-sdk";

/** Every runtime identity dimension required to resume a confirmed ACP session. */
export interface ApiChatSessionOwner {
  organizationId: string;
  userId: string;
  agentConfigId: string;
  environmentId: string;
  instanceId: string;
  runtimeGeneration: number;
}
/** Subject and optional explicit instance from the authenticated request. */
export type ApiChatSessionSubject = Pick<ApiChatSessionOwner, "organizationId" | "userId" | "agentConfigId"> &
  Partial<Pick<ApiChatSessionOwner, "instanceId" | "environmentId" | "runtimeGeneration">>;
/** Internal active lease; raw ACP IDs never cross the HTTP adapter. */
export interface ApiChatSessionLease {
  readonly handle: string;
  readonly owner: ApiChatSessionOwner;
  sessionId?: string;
  expiresAt: number;
  readonly signal: AbortSignal;
}
interface Entry extends ApiChatSessionLease {
  active: boolean;
  controller: AbortController;
  lastUsed: number;
}
const unavailable = () => new AppError("Session unavailable", "SESSION_UNAVAILABLE", 409);

/** Bounded process-local registry for the optional v1 continuation extension. */
export class ApiChatSessionRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly perOwner: number;
  private readonly max: number;
  constructor(options: { now?: () => number; ttlMs?: number; perOwner?: number; maxEntries?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.ttl = options.ttlMs ?? 30 * 60 * 1000;
    this.perOwner = options.perOwner ?? 256;
    this.max = options.maxEntries ?? 10000;
  }
  private remove(entry: Entry) {
    this.entries.delete(entry.handle);
    entry.controller.abort(unavailable());
  }
  private matches(entry: Entry, subject: ApiChatSessionSubject) {
    return Object.entries(subject).every(
      ([key, value]) => value === undefined || entry.owner[key as keyof ApiChatSessionOwner] === value,
    );
  }
  /** Reserve capacity before opening a new ACP session or sending a prompt. */
  reserve(owner: ApiChatSessionOwner): ApiChatSessionLease {
    const now = this.now();
    for (const entry of this.entries.values()) if (!entry.active && entry.expiresAt <= now) this.remove(entry);
    const sameOwner = (entry: Entry) =>
      entry.owner.organizationId === owner.organizationId && entry.owner.userId === owner.userId;
    const count = () => [...this.entries.values()].filter(sameOwner).length;
    while (count() >= this.perOwner || this.entries.size >= this.max) {
      const candidates = [...this.entries.values()]
        .filter((entry) => !entry.active && (count() < this.perOwner || sameOwner(entry)))
        .sort((a, b) => a.lastUsed - b.lastUsed);
      if (!candidates[0]) throw new AppError("Session capacity reached", "SESSION_CAPACITY_EXCEEDED", 429);
      this.remove(candidates[0]);
    }
    const controller = new AbortController();
    const entry: Entry = {
      handle: `fcs_${randomBytes(24).toString("base64url")}`,
      owner: { ...owner },
      expiresAt: now + this.ttl,
      lastUsed: now,
      active: true,
      controller,
      signal: controller.signal,
    };
    this.entries.set(entry.handle, entry);
    return entry;
  }
  /** Confirm only after the existing ACP handshake has succeeded. */
  confirm(lease: ApiChatSessionLease, sessionId: string): void {
    const entry = this.entries.get(lease.handle);
    if (entry !== lease || !entry.active || !sessionId) throw unavailable();
    entry.sessionId = sessionId;
  }
  /** Authenticate, validate optional identity dimensions, then admit a single continuation turn. */
  acquire(handle: string, subject: ApiChatSessionSubject): ApiChatSessionLease {
    const entry = this.entries.get(handle);
    if (!entry?.sessionId || !this.matches(entry, subject)) throw unavailable();
    if (entry.active) throw new AppError("Session busy", "AGENT_SESSION_BUSY", 409);
    if (entry.expiresAt <= this.now()) {
      this.remove(entry);
      throw unavailable();
    }
    entry.active = true;
    entry.lastUsed = this.now();
    entry.expiresAt = entry.lastUsed + this.ttl;
    return entry;
  }
  /** Revalidate the authoritative environment and generation after runtime readiness. */
  validate(lease: ApiChatSessionLease, owner: ApiChatSessionOwner): void {
    const entry = this.entries.get(lease.handle);
    if (entry !== lease || !this.matches(entry, owner)) {
      if (entry) this.remove(entry);
      throw unavailable();
    }
  }
  /** Failed/cancelled turns lose their handles; only confirmed successful turns become idle. */
  release(lease: ApiChatSessionLease, success: boolean): void {
    const entry = this.entries.get(lease.handle);
    if (entry !== lease) return;
    if (!success || !entry.sessionId) {
      this.remove(entry);
      return;
    }
    entry.active = false;
    entry.lastUsed = this.now();
    entry.expiresAt = entry.lastUsed + this.ttl;
  }
  /** Lifecycle events invalidate every session of the target instance only. */
  invalidateInstance(instanceId: string): void {
    for (const entry of this.entries.values()) if (entry.owner.instanceId === instanceId) this.remove(entry);
  }
}
/** Owned by the single process runtime control plane; process restarts intentionally clear handles. */
export const apiChatSessions = new ApiChatSessionRegistry();
