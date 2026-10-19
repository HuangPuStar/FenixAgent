// packages/chat-channel/src/state/factory.ts
// Y.Doc 工厂：按文档 5.2/5.3 新 schema 初始化 Chat Doc 与 Session Doc。
// 职责错位纠正后：Chat Doc = 消息时间线（高频），Session Doc = 会话元信息（低频）。
//
// 持久化参数（`snapshot`）由调用方（DocManager，值源于宿主装配）逐次传入，本模块不持有配置状态。

import type { Cluster, Redis } from "ioredis";
import * as Y from "yjs";
import { createRedisProvider } from "../persist/redis";
import type { SnapshotPersistConfig } from "../persist/snapshot-config";
import type { ChatDoc, RedisProvider, SessionDoc, SnapshotHydration } from "../types";
import { initChatDocStructure, initSessionDocStructure } from "./chat-writer";

/** Redis 连接类型（单实例或集群） */
type RedisConn = Redis | Cluster;

/** 内存 / 新建世代的确定水合结果：没有需要等待的持久化快照。 */
const EMPTY_HYDRATION: SnapshotHydration = { status: "empty" };

/** 内存模式的 no-op provider（Redis 不可用时使用） */
const NOOP_PROVIDER: RedisProvider = {
  hydration: Promise.resolve(EMPTY_HYDRATION),
  async destroy() {
    /* no-op */
  },
};

/**
 * 安全创建 provider：Redis 不可用时返回 no-op。
 *
 * Redis 可用却拿不到快照参数时**失败**而不是回落包内默认值：参数真相只属于 agent-runtime 的
 * `envDefinitions` 声明（宿主投影 → `ChatChannelDependencies.snapshotPersist` → DocManager），
 * 静默用第二份默认值会让「装配漏接」表现为线上节流 / TTL 与部署配置不符。
 */
function safeProvider(
  redis: RedisConn | null,
  docName: string,
  generation: string,
  ydoc: Y.Doc,
  snapshot: SnapshotPersistConfig | undefined,
): RedisProvider {
  if (!redis) return NOOP_PROVIDER;
  if (!snapshot) {
    throw new Error(
      "Chat Doc 快照参数未注入：Redis 模式需要宿主装配投影的 RCS_YJS_SNAPSHOT_* 参数（ChatChannelDependencies.snapshotPersist）",
    );
  }
  return createRedisProvider(redis, docName, ydoc, { generation, snapshot });
}

function createGeneration(): string {
  return `gen_${crypto.randomUUID()}`;
}

/** 加载路径的测试注入通道；生产调用不传。 */
export interface LoadDocOptions {
  /**
   * 固定目标 Y.Doc 的 clientID。Yjs 对同一根 map 键的并发 set 按 clientID 裁决，
   * 只有固定两端才能稳定复现「本地空结构覆盖快照根类型」的回归。
   */
  readonly clientID?: number;
}

/** 快照未成功水合：调用方必须显式处理，不得把它当作“确实没有历史”。 */
export class SnapshotHydrationError extends Error {
  constructor(readonly outcome: SnapshotHydration) {
    super(`Y.Doc 快照水合失败：${outcome.status}`, { cause: outcome.error });
    this.name = "SnapshotHydrationError";
  }
}

function createLoadTarget(guid: string, options?: LoadDocOptions): Y.Doc {
  const ydoc = new Y.Doc({ guid });
  if (options?.clientID !== undefined) ydoc.clientID = options.clientID;
  return ydoc;
}

/**
 * 等待快照水合并拒绝失败结果。
 *
 * 失败时销毁 provider / ydoc 再抛出：否则半初始化的空 Doc 会留在 DocManager 里，
 * 后续每次历史源读取都得到“空历史”，引导会一直缓存错误事实。
 */
async function awaitHydration(provider: RedisProvider, ydoc: Y.Doc): Promise<SnapshotHydration> {
  try {
    const outcome = await provider.hydration;
    if (outcome.status === "failed" || outcome.status === "stale") throw new SnapshotHydrationError(outcome);
    return outcome;
  } catch (error) {
    await provider.destroy().catch(() => {});
    ydoc.destroy();
    throw error;
  }
}

// ── Chat Doc（消息时间线）──
// `snapshot` 仅在 Redis 模式（`redis !== null`）下参与 provider 构造；内存模式传 null 时忽略。

export function createChatDoc(
  rcsSessionId: string,
  redis: RedisConn | null,
  generation = createGeneration(),
  snapshot?: SnapshotPersistConfig,
): ChatDoc {
  const docName = `chat:${rcsSessionId}`;
  const ydoc = new Y.Doc({ guid: `${docName}:${generation}` });
  initChatDocStructure(ydoc);
  ydoc.getMap("root").set("projectionGeneration", generation);

  const provider = safeProvider(redis, docName, generation, ydoc, snapshot);
  return {
    ydoc,
    generation,
    provider,
    // 新建世代（或内存 Doc）没有需要恢复的历史快照；provider 仍会照常订阅实时更新。
    hydration: EMPTY_HYDRATION,
    destroy: () => provider.destroy().then(() => ydoc.destroy()),
  };
}

/**
 * 恢复已有 Chat Doc：**先应用 Redis 快照，再补齐结构**。
 *
 * 顺序不可交换：`initChatDocStructure` 会创建 `entries` / `entryOrder` / `toolCalls` 根类型，
 * 若在快照前执行，Yjs 按 clientID 裁决同键冲突，目标 clientID 较大时空 map/array 会覆盖
 * 快照中的非空类型，整份历史不可达。
 */
export async function loadChatDoc(
  rcsSessionId: string,
  redis: RedisConn | null,
  generation = createGeneration(),
  snapshot?: SnapshotPersistConfig,
  options?: LoadDocOptions,
): Promise<ChatDoc> {
  const docName = `chat:${rcsSessionId}`;
  const ydoc = createLoadTarget(`${docName}:${generation}`, options);
  const provider = safeProvider(redis, docName, generation, ydoc, snapshot);
  const hydration = await awaitHydration(provider, ydoc);

  // 幂等补齐缺失结构：快照已应用，已有根类型原样保留，只为旧 schema / 空 Doc 建骨架。
  initChatDocStructure(ydoc);
  ydoc.getMap("root").set("projectionGeneration", generation);

  return {
    ydoc,
    generation,
    provider,
    hydration,
    destroy: () => provider.destroy().then(() => ydoc.destroy()),
  };
}

// ── Session Doc（会话元信息 / Agent 状态）──

export function createSessionDoc(
  rcsSessionId: string,
  redis: RedisConn | null,
  generation = createGeneration(),
  snapshot?: SnapshotPersistConfig,
): SessionDoc {
  const docName = `session:${rcsSessionId}`;
  const ydoc = new Y.Doc({ guid: `${docName}:${generation}` });
  initSessionDocStructure(ydoc);
  ydoc.getMap("root").set("projectionGeneration", generation);

  const provider = safeProvider(redis, docName, generation, ydoc, snapshot);
  return {
    ydoc,
    generation,
    provider,
    // 新建世代（或内存 Doc）没有需要恢复的历史快照。
    hydration: EMPTY_HYDRATION,
    destroy: () => provider.destroy().then(() => ydoc.destroy()),
  };
}

/**
 * 恢复已有 Session Doc：**先应用 Redis 快照，再补齐结构**（原因同 `loadChatDoc`）。
 * Session Doc 的 `session` / `agent` / `sessions` / `tasks` 根类型同样可能被本地空结构覆盖。
 */
export async function loadSessionDoc(
  rcsSessionId: string,
  redis: RedisConn | null,
  generation = createGeneration(),
  snapshot?: SnapshotPersistConfig,
  options?: LoadDocOptions,
): Promise<SessionDoc> {
  const docName = `session:${rcsSessionId}`;
  const ydoc = createLoadTarget(`${docName}:${generation}`, options);
  const provider = safeProvider(redis, docName, generation, ydoc, snapshot);
  const hydration = await awaitHydration(provider, ydoc);

  initSessionDocStructure(ydoc);
  ydoc.getMap("root").set("projectionGeneration", generation);

  return {
    ydoc,
    generation,
    provider,
    hydration,
    destroy: () => provider.destroy().then(() => ydoc.destroy()),
  };
}
