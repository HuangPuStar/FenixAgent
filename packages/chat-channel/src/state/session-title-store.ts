import type { Cluster, Redis } from "ioredis";
import type * as Y from "yjs";
import type { NormalizedEvent } from "../schema";
import { getSessionRoot, getSessionsMap } from "./chat-writer";

/** Fenix 会话标题的持久化端口；生产使用无 TTL 的 Redis hash。 */
export interface SessionTitleStore {
  read(rcsSessionId: string): Promise<Record<string, string>>;
  write(rcsSessionId: string, sessionId: string, title: string): Promise<void>;
  delete(rcsSessionId: string, sessionId: string): Promise<void>;
}

/** Redis 连接缺失时明确失败，避免内存会话标题被误认为已持久保存。 */
export function createRedisSessionTitleStore(getRedis: () => Redis | Cluster | null): SessionTitleStore {
  const requireRedis = () => {
    const redis = getRedis();
    if (!redis) throw new Error("persistent session metadata unavailable");
    return redis;
  };
  const key = (rcsSessionId: string) => `chat:session-titles:${rcsSessionId}`;
  return {
    read: (rcsSessionId) => requireRedis().hgetall(key(rcsSessionId)),
    write: async (rcsSessionId, sessionId, title) => {
      await requireRedis().hset(key(rcsSessionId), sessionId, title);
    },
    delete: async (rcsSessionId, sessionId) => {
      await requireRedis().hdel(key(rcsSessionId), sessionId);
    },
  };
}

/** 持久标题回读状态；revision 阻止慢读覆盖同进程刚完成的写入。 */
export class SessionTitleState {
  private readonly titles = new Map<string, Map<string, string>>();
  private readonly revisions = new Map<string, number>();
  private readonly confirmed = new Map<string, Set<string>>();
  private readonly deleted = new Map<string, Set<string>>();
  private readonly generations = new Map<string, object>();
  private readonly reads = new Map<string, number>();
  private readonly pendingWrites = new Map<string, Set<Promise<void>>>();

  constructor(private store: SessionTitleStore | null) {}

  setStore(store: SessionTitleStore | null): void {
    this.store = store;
  }

  private generation(rcsSessionId: string): object {
    let generation = this.generations.get(rcsSessionId);
    if (!generation) {
      generation = {};
      this.generations.set(rcsSessionId, generation);
    }
    return generation;
  }

  async refresh(rcsSessionId: string): Promise<boolean> {
    if (!this.store) return true;
    const generation = this.generation(rcsSessionId);
    const read = (this.reads.get(rcsSessionId) ?? 0) + 1;
    this.reads.set(rcsSessionId, read);
    const revision = this.revisions.get(rcsSessionId) ?? 0;
    const titles = await this.store.read(rcsSessionId);
    if (
      this.generations.get(rcsSessionId) !== generation ||
      (this.reads.get(rcsSessionId) ?? 0) !== read ||
      (this.revisions.get(rcsSessionId) ?? 0) !== revision
    )
      return false;
    this.titles.set(rcsSessionId, new Map(Object.entries(titles)));
    return true;
  }

  async write(rcsSessionId: string, sessionId: string, title: string): Promise<void> {
    if (!this.store) throw new Error("persistent session metadata unavailable");
    const pending = this.store.write(rcsSessionId, sessionId, title);
    let writes = this.pendingWrites.get(rcsSessionId);
    if (!writes) {
      writes = new Set();
      this.pendingWrites.set(rcsSessionId, writes);
    }
    writes.add(pending);
    try {
      await pending;
    } finally {
      writes.delete(pending);
    }
    this.revisions.set(rcsSessionId, (this.revisions.get(rcsSessionId) ?? 0) + 1);
    let titles = this.titles.get(rcsSessionId);
    if (!titles) {
      titles = new Map();
      this.titles.set(rcsSessionId, titles);
    }
    titles.set(sessionId, title);
  }

  async delete(rcsSessionId: string, sessionId: string): Promise<void> {
    if (!this.store) return;
    let deleted = this.deleted.get(rcsSessionId);
    if (!deleted) {
      deleted = new Set();
      this.deleted.set(rcsSessionId, deleted);
    }
    deleted.add(sessionId);
    this.confirmed.get(rcsSessionId)?.delete(sessionId);
    this.titles.get(rcsSessionId)?.delete(sessionId);
    this.revisions.set(rcsSessionId, (this.revisions.get(rcsSessionId) ?? 0) + 1);
    await this.store.delete(rcsSessionId, sessionId);
  }

  get(rcsSessionId: string, sessionId: string): string | undefined {
    if (this.deleted.get(rcsSessionId)?.has(sessionId)) return;
    return this.titles.get(rcsSessionId)?.get(sessionId);
  }

  /** 当前服务端绑定或本轮 Agent 列表确认的会话才允许写入标题。 */
  async rename(
    doc: Y.Doc,
    rcsSessionId: string,
    sessionId: string,
    title: string,
    boundSessionId: string | null,
  ): Promise<void> {
    if (
      this.deleted.get(rcsSessionId)?.has(sessionId) ||
      (sessionId !== boundSessionId && !this.confirmed.get(rcsSessionId)?.has(sessionId))
    ) {
      throw new Error("session not confirmed for current instance");
    }
    await this.write(rcsSessionId, sessionId, title);
    doc.transact(() => {
      const root = getSessionRoot(doc);
      getSessionsMap(doc).get(sessionId)?.set("title", title);
      const active = root.get("session") as Y.Map<unknown>;
      if (active.get("sessionId") === sessionId) active.set("title", title);
    });
  }

  /** Agent 列表与当前会话通知进入聚合层前叠加 Fenix 权威标题。 */
  project(rcsSessionId: string, event: NormalizedEvent, activeSessionId: unknown): NormalizedEvent {
    if (event.type === "session_list" && Array.isArray(event.update.sessions)) {
      const confirmed = new Set<string>();
      const sessions = event.update.sessions.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
        const record = entry as Record<string, unknown>;
        const sessionId = record.sessionId;
        if (typeof sessionId !== "string") return entry;
        confirmed.add(sessionId);
        const title = this.get(rcsSessionId, sessionId);
        return title === undefined ? entry : { ...record, title };
      });
      this.confirmed.set(rcsSessionId, confirmed);
      if (typeof activeSessionId === "string" && !confirmed.has(activeSessionId)) {
        const title = this.get(rcsSessionId, activeSessionId);
        if (title) sessions.push({ sessionId: activeSessionId, title });
      }
      return { ...event, update: { ...event.update, sessions } };
    }
    if (
      event.type === "session_updated" &&
      (event.update.sessionId === undefined ||
        activeSessionId === undefined ||
        activeSessionId === null ||
        event.update.sessionId === activeSessionId)
    ) {
      const targetId = typeof event.update.sessionId === "string" ? event.update.sessionId : activeSessionId;
      const title = typeof targetId === "string" ? this.get(rcsSessionId, targetId) : undefined;
      if (title) return { ...event, update: { ...event.update, title } };
    }
    return event;
  }

  async close(rcsSessionId: string): Promise<void> {
    this.generations.delete(rcsSessionId);
    this.titles.delete(rcsSessionId);
    this.revisions.delete(rcsSessionId);
    this.confirmed.delete(rcsSessionId);
    this.deleted.delete(rcsSessionId);
    this.reads.delete(rcsSessionId);
    await Promise.allSettled(this.pendingWrites.get(rcsSessionId) ?? []);
    this.pendingWrites.delete(rcsSessionId);
    this.titles.delete(rcsSessionId);
    this.revisions.delete(rcsSessionId);
  }
}
