import { log } from "@fenix/logger";
import type { EngineRelayHandle, EngineRelayMessage } from "@fenix/plugin-sdk";

// ── 类型 ──

export interface AgentSession {
  /** EngineRelayHandle（含 send/onMessage/ready/close） */
  relayHandle: EngineRelayHandle;
  /** 实例 ID */
  instanceId: string;
  /** Workspace 路径（用于注入 cwd） */
  workspacePath?: string;
  /** 释放资源（关闭 relay handle + stop instance） */
  dispose(): Promise<void>;
}

export interface PromptTurnStartOptions {
  /** AgentSession（已建立 relay 连接） */
  session: AgentSession;
  /** 可选：恢复已有会话（调用 session/load） */
  sessionId?: string;
}

/** PromptTurn —— 单次 session/prompt 生命周期 */
export interface PromptTurn {
  /** 发送 session/prompt JSON-RPC，Agent 开始处理 */
  prompt(promptContent: Array<{ type: string; text: string; resource?: unknown }>): void;
  /** session/update 事件流 + session/prompt response */
  events(): AsyncIterable<EngineRelayMessage>;
  /** 释放资源（关闭 relay handle + stop instance） */
  dispose(): Promise<void>;
}

// ── 工厂函数 ──

/**
 * 基于已有的 EngineRelayHandle 创建 AgentSession。
 * 调用方负责实例创建（ensureRunning / spawnInstanceFromEnvironment）。
 */
export function createAgentSession(config: {
  relayHandle: EngineRelayHandle;
  instanceId: string;
  workspacePath?: string;
  /** stop instance 函数，dispose 时调用 */
  stopInstance: () => Promise<void>;
}): AgentSession {
  return {
    relayHandle: config.relayHandle,
    instanceId: config.instanceId,
    workspacePath: config.workspacePath,
    dispose: async () => {
      try {
        config.relayHandle.close(1000, "request complete");
      } catch {
        /* ignore */
      }
      try {
        await config.stopInstance();
      } catch {
        /* ignore */
      }
    },
  };
}

// ── PromptTurn（构建在 AgentSession 之上）──

/** 基于 AgentSession 创建 PromptTurn */
export function createPromptTurn(session: AgentSession, sessionId: string): PromptTurn {
  const turnId = Date.now();
  const eventQueue: EngineRelayMessage[] = [];
  const MAX_EVENT_QUEUE = 5000;
  let resolveNext: ((value: IteratorResult<EngineRelayMessage>) => void) | null = null;
  let done = false;
  const cleanupFns: Array<() => void> = [];

  // 注册 relay handle 的消息监听
  const full = session.relayHandle as EngineRelayHandle & {
    onMessage?: (listener: (msg: EngineRelayMessage) => void) => () => void;
  };
  if (full.onMessage) {
    cleanupFns.push(
      full.onMessage((msg) => {
        if (eventQueue.length >= MAX_EVENT_QUEUE) {
          eventQueue.shift(); // 丢弃最旧事件，防止内存泄漏
        }
        eventQueue.push(msg);
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r({ value: eventQueue.shift()!, done: false });
        }
      }),
    );
  }

  const eventsIterable: AsyncIterable<EngineRelayMessage> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<EngineRelayMessage>> {
          if (done && eventQueue.length === 0) {
            return { value: undefined, done: true };
          }
          if (eventQueue.length > 0) {
            return { value: eventQueue.shift()!, done: false };
          }
          return new Promise((resolve) => {
            resolveNext = resolve;
          });
        },
        async return() {
          done = true;
          resolveNext?.({ value: undefined, done: true });
          return { value: undefined, done: true };
        },
      };
    },
  };

  return {
    prompt(promptContent) {
      log(`[openai] Sending session/prompt: sessionId=${sessionId} turnId=${turnId}`);
      const rpcMsg = {
        jsonrpc: "2.0" as const,
        id: turnId,
        method: "session/prompt",
        // 字段名必须用 content（与 acp-link server handlePrompt 对齐）
        params: { sessionId, content: promptContent },
      };
      session.relayHandle.send(rpcMsg as unknown as EngineRelayMessage);
    },

    events() {
      return eventsIterable;
    },

    async dispose() {
      done = true;
      resolveNext?.({ value: undefined, done: true });
      for (const fn of cleanupFns) fn();
      await session.dispose();
    },
  };
}

/**
 * 一站式：在已有 AgentSession 上创建 session（session/new 或 session/load）并创建 PromptTurn。
 */
export async function startPromptTurn(
  options: PromptTurnStartOptions,
): Promise<{ turn: PromptTurn; session: AgentSession }> {
  const { session } = options;

  // 发送 session/new 或 session/load，等待 agent 返回 sessionId
  const sessionId = await new Promise<string>((resolve, reject) => {
    const rpcId = -1;
    const rpcMsg: Record<string, unknown> = {
      jsonrpc: "2.0",
      id: rpcId,
      method: options.sessionId ? "session/load" : "session/new",
      params: {},
    };
    if (options.sessionId) {
      (rpcMsg.params as Record<string, unknown>).sessionId = options.sessionId;
    }
    // 注入 cwd
    if (session.workspacePath) {
      (rpcMsg.params as Record<string, unknown>).cwd = session.workspacePath;
    }

    const full = session.relayHandle as EngineRelayHandle & {
      onMessage?: (listener: (msg: EngineRelayMessage) => void) => () => void;
    };

    if (!full.onMessage) {
      log("[openai] relay handle has no onMessage, using fallback sessionId");
      resolve(`ses_${session.instanceId.slice(0, 12)}`);
    }

    const timeout = setTimeout(() => {
      unsub?.();
      log(`[openai] session/new timeout, fallback sessionId`);
      resolve(`ses_${session.instanceId.slice(0, 12)}`);
    }, 30000);

    const unsub = full.onMessage?.((msg) => {
      const isRawJsonRpc = (msg as unknown as Record<string, unknown>).jsonrpc === "2.0";
      const isWrappedJsonRpc = ((msg as any).payload as Record<string, unknown> | undefined)?.jsonrpc === "2.0";
      const rpcSource = isRawJsonRpc ? msg : isWrappedJsonRpc ? (msg as any).payload : null;
      if (!rpcSource) return;
      const rpc = rpcSource as unknown as {
        id?: number;
        result?: { id?: string; sessionId?: string };
        error?: { message?: string };
      };
      if (rpc.id !== rpcId) return;

      clearTimeout(timeout);
      unsub?.();

      if (rpc.error) {
        reject(new Error(rpc.error.message || "Session create/load failed"));
        return;
      }

      const sid = rpc.result?.id || rpc.result?.sessionId;
      if (sid) {
        log(`[openai] Session created/loaded: sessionId=${sid}`);
        resolve(sid);
      } else if (options.sessionId) {
        log(`[openai] Session loaded: sessionId=${options.sessionId}`);
        resolve(options.sessionId);
      } else {
        const fallback = `ses_${Date.now().toString(36)}`;
        log(`[openai] Session created (fallback id): sessionId=${fallback}`);
        resolve(fallback);
      }
    });

    const method = rpcMsg.method as string;
    log(`[openai] Sending ${method}: sessionId=${options.sessionId ?? "new"}`);
    session.relayHandle.send(rpcMsg as unknown as EngineRelayMessage);
  });

  const turn = createPromptTurn(session, sessionId);

  return { turn, session };
}
