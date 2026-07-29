// packages/acp-server/src/doc-factory.ts

import type { Cluster, Redis } from "ioredis";
import * as Y from "yjs";
import { createRedisProvider } from "../persist/redis";
import type { ChatDoc, RedisProvider, SessionDoc } from "../types";

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

// ── Chat 全局 Doc ──

export function createChatDoc(rcsSessionId: string, redis: RedisConn | null): ChatDoc {
  const docName = `chat:${rcsSessionId}`;
  const ydoc = new Y.Doc({ guid: docName });

  // 初始化结构
  const agentInfo = ydoc.getMap("agentInfo");
  agentInfo.set("id", "");
  agentInfo.set("name", "");

  ydoc.getArray("sessions");

  const chatMeta = ydoc.getMap("chatMeta");
  chatMeta.set("activeSessionId", "");
  chatMeta.set("isSwitchingSession", false);

  const connection = ydoc.getMap("connection");
  connection.set("status", "disconnected");
  connection.set("since", Date.now());

  ydoc.getArray("permissions");

  // 新增：capabilities / modelState / modeState / availableCommands
  ydoc.getMap("capabilities");
  ydoc.getMap("modelState");
  ydoc.getMap("modeState");
  ydoc.getArray("availableCommands");
  ydoc.getMap("tokenUsage");

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

  // 确保基础结构存在
  if (!ydoc.getMap("agentInfo").has("id")) {
    ydoc.getMap("agentInfo").set("id", "");
    ydoc.getMap("agentInfo").set("name", "");
  }

  if (!ydoc.getMap("connection").has("status")) {
    ydoc.getMap("connection").set("status", "disconnected");
    ydoc.getMap("connection").set("since", Date.now());
  }

  // 确保新增字段结构存在（惰性创建）
  ydoc.getMap("capabilities");
  ydoc.getMap("modelState");
  ydoc.getMap("modeState");
  ydoc.getArray("availableCommands");
  ydoc.getMap("tokenUsage");

  const provider = safeProvider(redis, docName, ydoc);

  return {
    ydoc,
    provider,
    destroy: () => provider.destroy().then(() => ydoc.destroy()),
  };
}

// ── Session 单例 Doc ──

export function createSessionDoc(rcsSessionId: string, redis: RedisConn | null): SessionDoc {
  const docName = `session:${rcsSessionId}`;
  const ydoc = new Y.Doc({ guid: docName });

  const meta = ydoc.getMap("meta");
  meta.set("status", "idle");
  meta.set("acpSessionId", rcsSessionId);
  meta.set("createdAt", Date.now());
  meta.set("updatedAt", Date.now());
  meta.set("loading", null);

  ydoc.getArray("messages");
  ydoc.getMap("streaming");
  ydoc.getMap("tools");
  ydoc.getArray("artifacts");

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

  // 确保基础结构存在
  if (!ydoc.getMap("meta").has("status")) {
    ydoc.getMap("meta").set("status", "idle");
    ydoc.getMap("meta").set("acpSessionId", rcsSessionId);
  }

  const provider = safeProvider(redis, docName, ydoc);

  return {
    ydoc,
    provider,
    destroy: () => provider.destroy().then(() => ydoc.destroy()),
  };
}
