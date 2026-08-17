// packages/chat-channel/src/state/factory.ts
// Y.Doc 工厂：按文档 5.2/5.3 新 schema 初始化 Chat Doc 与 Session Doc。
// 职责错位纠正后：Chat Doc = 消息时间线（高频），Session Doc = 会话元信息（低频）。

import type { Cluster, Redis } from "ioredis";
import * as Y from "yjs";
import { createRedisProvider } from "../persist/redis";
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

/** 安全创建 provider：Redis 不可用时返回 no-op */
function safeProvider(redis: RedisConn | null, docName: string, ydoc: Y.Doc): RedisProvider {
  if (!redis) return NOOP_PROVIDER;
  return createRedisProvider(redis, docName, ydoc);
}

// ── Chat Doc（消息时间线）──

export function createChatDoc(rcsSessionId: string, redis: RedisConn | null): ChatDoc {
  const docName = `chat:${rcsSessionId}`;
  const ydoc = new Y.Doc({ guid: docName });
  initChatDocStructure(ydoc);

  const provider = safeProvider(redis, docName, ydoc);
  return {
    ydoc,
    provider,
    destroy: () => provider.destroy().then(() => ydoc.destroy()),
  };
}

export function loadChatDoc(rcsSessionId: string, redis: RedisConn | null): ChatDoc {
  const docName = `chat:${rcsSessionId}`;
  const ydoc = new Y.Doc({ guid: docName });

  // 兼容缺失结构：旧 schema 或空 Doc 加载时补齐新结构骨架；
  // 已存在的新结构 Doc 不做破坏性重建（无兼容窗口，但加载路径需幂等）。
  if (getChatRoot(ydoc).get("schemaVersion") !== CHAT_DOC_SCHEMA_VERSION) {
    initChatDocStructure(ydoc);
  }

  const provider = safeProvider(redis, docName, ydoc);
  return {
    ydoc,
    provider,
    destroy: () => provider.destroy().then(() => ydoc.destroy()),
  };
}

// ── Session Doc（会话元信息 / Agent 状态）──

export function createSessionDoc(rcsSessionId: string, redis: RedisConn | null): SessionDoc {
  const docName = `session:${rcsSessionId}`;
  const ydoc = new Y.Doc({ guid: docName });
  initSessionDocStructure(ydoc);

  const provider = safeProvider(redis, docName, ydoc);
  return {
    ydoc,
    provider,
    destroy: () => provider.destroy().then(() => ydoc.destroy()),
  };
}

export function loadSessionDoc(rcsSessionId: string, redis: RedisConn | null): SessionDoc {
  const docName = `session:${rcsSessionId}`;
  const ydoc = new Y.Doc({ guid: docName });

  if (getSessionRoot(ydoc).get("schemaVersion") !== SESSION_DOC_SCHEMA_VERSION) {
    initSessionDocStructure(ydoc);
  }

  const provider = safeProvider(redis, docName, ydoc);
  return {
    ydoc,
    provider,
    destroy: () => provider.destroy().then(() => ydoc.destroy()),
  };
}
