// packages/chat-channel/src/state/factory.ts
// Y.Doc 工厂：Chat Doc = 高频消息时间线，Session Doc = 低频会话元信息。

import type { Cluster, Redis } from "ioredis";
import * as Y from "yjs";
import { createRedisProvider } from "../persist/redis";
import { CHAT_DOC_SCHEMA_VERSION, SESSION_DOC_SCHEMA_VERSION } from "../schema";
import type { ChatDoc, RedisProvider, SessionDoc } from "../types";
import { getChatRoot, getSessionRoot, initChatDocStructure, initSessionDocStructure } from "./chat-writer";

type RedisConn = Redis | Cluster;

const NOOP_PROVIDER: RedisProvider = {
  async destroy() {
    /* no-op */
  },
};

export interface CreateDocOptions {
  /** 隐藏候选投影使用：prepare 阶段不订阅、不加载、不持久化 Redis。 */
  deferProvider?: boolean;
}

function safeProvider(redis: RedisConn | null, docName: string, generation: string, ydoc: Y.Doc): RedisProvider {
  if (!redis) return NOOP_PROVIDER;
  return createRedisProvider(redis, docName, ydoc, { generation });
}

function createGeneration(): string {
  return `gen_${crypto.randomUUID()}`;
}

function providerLifecycle(
  redis: RedisConn | null,
  docName: string,
  generation: string,
  ydoc: Y.Doc,
  deferred: boolean,
): {
  readonly provider: RedisProvider;
  activate(): void;
  destroy(): Promise<void>;
} {
  let provider = NOOP_PROVIDER;
  let active = false;
  let destroyed = false;

  const activate = () => {
    if (active || destroyed) return;
    active = true;
    provider = safeProvider(redis, docName, generation, ydoc);
  };
  if (!deferred) activate();

  return {
    get provider() {
      return provider;
    },
    activate,
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      await provider.destroy();
    },
  };
}

function wrapChatDoc(
  rcsSessionId: string,
  redis: RedisConn | null,
  generation: string,
  ydoc: Y.Doc,
  options?: CreateDocOptions,
): ChatDoc {
  const lifecycle = providerLifecycle(redis, `chat:${rcsSessionId}`, generation, ydoc, options?.deferProvider === true);
  return {
    ydoc,
    generation,
    get provider() {
      return lifecycle.provider;
    },
    activateProvider: lifecycle.activate,
    async destroy() {
      await lifecycle.destroy();
      ydoc.destroy();
    },
  };
}

function wrapSessionDoc(
  rcsSessionId: string,
  redis: RedisConn | null,
  generation: string,
  ydoc: Y.Doc,
  options?: CreateDocOptions,
): SessionDoc {
  const lifecycle = providerLifecycle(
    redis,
    `session:${rcsSessionId}`,
    generation,
    ydoc,
    options?.deferProvider === true,
  );
  return {
    ydoc,
    generation,
    get provider() {
      return lifecycle.provider;
    },
    activateProvider: lifecycle.activate,
    async destroy() {
      await lifecycle.destroy();
      ydoc.destroy();
    },
  };
}

// ── Chat Doc（消息时间线）──

export function createChatDoc(
  rcsSessionId: string,
  redis: RedisConn | null,
  generation = createGeneration(),
  options?: CreateDocOptions,
): ChatDoc {
  const docName = `chat:${rcsSessionId}`;
  const ydoc = new Y.Doc({ guid: `${docName}:${generation}` });
  initChatDocStructure(ydoc);
  ydoc.getMap("root").set("projectionGeneration", generation);
  return wrapChatDoc(rcsSessionId, redis, generation, ydoc, options);
}

export function loadChatDoc(rcsSessionId: string, redis: RedisConn | null, generation = createGeneration()): ChatDoc {
  const docName = `chat:${rcsSessionId}`;
  const ydoc = new Y.Doc({ guid: `${docName}:${generation}` });
  if (getChatRoot(ydoc).get("schemaVersion") !== CHAT_DOC_SCHEMA_VERSION) initChatDocStructure(ydoc);
  ydoc.getMap("root").set("projectionGeneration", generation);
  return wrapChatDoc(rcsSessionId, redis, generation, ydoc);
}

// ── Session Doc（会话元信息 / Agent 状态）──

export function createSessionDoc(
  rcsSessionId: string,
  redis: RedisConn | null,
  generation = createGeneration(),
  options?: CreateDocOptions,
): SessionDoc {
  const docName = `session:${rcsSessionId}`;
  const ydoc = new Y.Doc({ guid: `${docName}:${generation}` });
  initSessionDocStructure(ydoc);
  ydoc.getMap("root").set("projectionGeneration", generation);
  return wrapSessionDoc(rcsSessionId, redis, generation, ydoc, options);
}

export function loadSessionDoc(
  rcsSessionId: string,
  redis: RedisConn | null,
  generation = createGeneration(),
): SessionDoc {
  const docName = `session:${rcsSessionId}`;
  const ydoc = new Y.Doc({ guid: `${docName}:${generation}` });
  if (getSessionRoot(ydoc).get("schemaVersion") !== SESSION_DOC_SCHEMA_VERSION) initSessionDocStructure(ydoc);
  ydoc.getMap("root").set("projectionGeneration", generation);
  return wrapSessionDoc(rcsSessionId, redis, generation, ydoc);
}
