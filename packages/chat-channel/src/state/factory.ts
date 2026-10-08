// packages/chat-channel/src/state/factory.ts
// Y.Doc 工厂：按文档 5.2/5.3 新 schema 初始化 Chat Doc 与 Session Doc。
// 职责错位纠正后：Chat Doc = 消息时间线（高频），Session Doc = 会话元信息（低频）。
//
// 持久化参数（`snapshot`）由调用方（DocManager，值源于宿主装配）逐次传入，本模块不持有配置状态。

import type { Cluster, Redis } from "ioredis";
import * as Y from "yjs";
import { createRedisProvider } from "../persist/redis";
import type { SnapshotPersistConfig } from "../persist/snapshot-config";
import { CHAT_DOC_SCHEMA_VERSION, SESSION_DOC_SCHEMA_VERSION } from "../schema";
import type { ChatDoc, RedisProvider, SessionDoc } from "../types";
import { getChatRoot, getSessionRoot, initChatDocStructure, initSessionDocStructure } from "./chat-writer";

/** Redis 连接类型（单实例或集群） */
type RedisConn = Redis | Cluster;

/** 内存模式的 no-op provider（Redis 不可用时使用） */
const NOOP_PROVIDER: RedisProvider = {
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
    destroy: () => provider.destroy().then(() => ydoc.destroy()),
  };
}

export function loadChatDoc(
  rcsSessionId: string,
  redis: RedisConn | null,
  generation = createGeneration(),
  snapshot?: SnapshotPersistConfig,
): ChatDoc {
  const docName = `chat:${rcsSessionId}`;
  const ydoc = new Y.Doc({ guid: `${docName}:${generation}` });

  // 兼容缺失结构：旧 schema 或空 Doc 加载时补齐新结构骨架；
  // 已存在的新结构 Doc 不做破坏性重建（无兼容窗口，但加载路径需幂等）。
  if (getChatRoot(ydoc).get("schemaVersion") !== CHAT_DOC_SCHEMA_VERSION) {
    initChatDocStructure(ydoc);
  }
  ydoc.getMap("root").set("projectionGeneration", generation);

  const provider = safeProvider(redis, docName, generation, ydoc, snapshot);
  return {
    ydoc,
    generation,
    provider,
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
    destroy: () => provider.destroy().then(() => ydoc.destroy()),
  };
}

export function loadSessionDoc(
  rcsSessionId: string,
  redis: RedisConn | null,
  generation = createGeneration(),
  snapshot?: SnapshotPersistConfig,
): SessionDoc {
  const docName = `session:${rcsSessionId}`;
  const ydoc = new Y.Doc({ guid: `${docName}:${generation}` });

  if (getSessionRoot(ydoc).get("schemaVersion") !== SESSION_DOC_SCHEMA_VERSION) {
    initSessionDocStructure(ydoc);
  }
  ydoc.getMap("root").set("projectionGeneration", generation);

  const provider = safeProvider(redis, docName, generation, ydoc, snapshot);
  return {
    ydoc,
    generation,
    provider,
    destroy: () => provider.destroy().then(() => ydoc.destroy()),
  };
}
