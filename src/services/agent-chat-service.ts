import { log } from "@fenix/logger";
import type { EngineRelayHandle, EngineRelayMessage } from "@fenix/plugin-sdk";
import { AppError } from "../errors";
import type { EnvironmentRecord } from "../repositories/environment";
import { environmentRepo } from "../repositories/environment";
import { getReadableAgentConfigById } from "./config";
import { getCoreRuntime } from "./core-bootstrap";
import { createWebEnvironment } from "./environment-web";
import {
  getRunningInstancesByEnvironment,
  groupActiveInstancesByEnvironment,
  spawnInstanceFromEnvironment,
} from "./instance";
import { resolveWorkspacePath } from "./workspace-resolver";

// ── 类型 ──

export interface AgentSession {
  /** EngineRelayHandle（含 send/onMessage/ready/close） */
  relayHandle: EngineRelayHandle;
  /** 实例 ID */
  instanceId: string;
  /** Environment ID */
  environmentId: string;
  /** Workspace 路径（用于注入 cwd） */
  workspacePath?: string;
  /** 释放资源（关闭 relay handle + stop instance） */
  dispose(): Promise<void>;
}

export interface AgentChatConnectOptions {
  agentConfigId: string;
  organizationId: string;
  userId: string;
  /** 可选：恢复已有会话 */
  sessionId?: string;
}

/** PromptTurn —— 单次 session/prompt 生命周期 */
export interface PromptTurn {
  /** 发送 session/prompt JSON-RPC，Agent 开始处理 */
  prompt(promptContent: Array<{ type: string; text: string; resource?: unknown }>): void;
  /** session/update 事件流 + session/prompt response */
  events(): AsyncIterable<EngineRelayMessage>;
  /** 释放资源（close relay handle + stop instance） */
  dispose(): Promise<void>;
}

// ── DEP —— 测试依赖注入 ──

type ChatServiceDeps = {
  getReadableAgentConfigById: typeof getReadableAgentConfigById;
  createWebEnvironment: typeof createWebEnvironment;
  groupActiveInstancesByEnvironment: typeof groupActiveInstancesByEnvironment;
  getRunningInstancesByEnvironment: typeof getRunningInstancesByEnvironment;
  listEnvironmentsByOrganizationId: typeof environmentRepo.listByOrganizationId;
  spawnInstanceFromEnvironment: typeof spawnInstanceFromEnvironment;
  getCoreRuntime: typeof getCoreRuntime;
};

const defaultDeps: ChatServiceDeps = {
  getReadableAgentConfigById,
  createWebEnvironment,
  groupActiveInstancesByEnvironment,
  getRunningInstancesByEnvironment,
  listEnvironmentsByOrganizationId: (orgId) => environmentRepo.listByOrganizationId(orgId),
  spawnInstanceFromEnvironment,
  getCoreRuntime,
};

let deps: ChatServiceDeps = defaultDeps;

/** 测试用：替换 AgentChatService 依赖 */
export function setAgentChatServiceDeps(overrides: Partial<ChatServiceDeps> | null): void {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}

// ── 工具函数 ──

interface AgentConfigRecord {
  id: string;
  organizationId?: string | null;
  name: string;
  description?: string | null;
}

function toKebabSegment(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function pickEnvironment(
  environments: EnvironmentRecord[],
  activeMap: Map<string, Array<{ status: string }>>,
): EnvironmentRecord | null {
  if (environments.length === 0) return null;
  const running = environments.find((env) => {
    const instances = activeMap.get(env.id) ?? [];
    return instances.some((i) => i.status === "running" || i.status === "starting");
  });
  return running ?? environments[0] ?? null;
}

// ── AgentChatService ──

/** 连接到 Agent，返回 AgentSession（共享 relay handle） */
export async function connectAgentChat(options: AgentChatConnectOptions): Promise<AgentSession> {
  const { agentConfigId, organizationId, userId, sessionId } = options;

  // 1. 查 AgentConfig
  const agent = (await deps.getReadableAgentConfigById(
    { organizationId, userId, role: "member" },
    agentConfigId,
  )) as AgentConfigRecord | null;
  if (!agent) {
    throw new AppError("Agent not found", "NOT_FOUND", 404);
  }
  log(`[openai] Agent found: ${agent.name} (${agent.id})`);

  // 2. 找/建 Environment
  const activeMap = deps.groupActiveInstancesByEnvironment();
  const existingEnvs = (await deps.listEnvironmentsByOrganizationId(organizationId)).filter(
    (e) => e.agentConfigId === agent.id && e.userId === userId,
  );
  let environment = pickEnvironment(existingEnvs, activeMap);

  if (!environment) {
    const base = toKebabSegment(agent.name) || "agent";
    environment = await deps.createWebEnvironment({
      name: `runtime-${base}-${agent.id.slice(0, 8)}`,
      description: agent.description ?? undefined,
      agentConfigId: agent.id,
      autoStart: true,
      userId,
      organizationId,
    });
    log(`[openai] Environment created: ${environment.name} (${environment.id})`);
  } else {
    log(`[openai] Environment reused: ${environment.name} (${environment.id})`);
  }

  // 3. 总是新建实例（请求级生命周期）
  const instance = await deps.spawnInstanceFromEnvironment(userId, environment.id, environment);
  log(`[openai] Instance spawned: ${instance.id} status=${instance.status}`);

  // 4. 通过 CoreRuntimeFacade 连接 relay
  const facade = deps.getCoreRuntime();
  const handle = await facade.connectInstanceRelay({ instanceId: instance.id, sessionId });
  log(`[openai] Relay connected: instanceId=${instance.id} sessionId=${sessionId ?? "none"}`);

  // 等待 relay ready
  const full = handle as EngineRelayHandle & { ready?: Promise<void> };
  if (full.ready) await full.ready;

  return {
    relayHandle: handle,
    instanceId: instance.id,
    environmentId: environment.id,
    workspacePath: resolveWorkspacePath(organizationId, userId, environment.id),
    dispose: async () => {
      try {
        handle.close(1000, "request complete");
      } catch {
        /* ignore */
      }
      try {
        await facade.stopInstance(instance.id);
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
        // 字段名必须用 content（与 acp-link server handlePrompt 对齐，而非 ACP 规范的 prompt）
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
 * 一站式：connect + 创建 session + 创建 PromptTurn。
 * 先发送 session/new（或 session/load），等待 agent 返回 sessionId，再用它创建 PromptTurn。
 */
export async function startPromptTurn(
  options: AgentChatConnectOptions,
): Promise<{ turn: PromptTurn; session: AgentSession }> {
  const session = await connectAgentChat(options);

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
      resolve(`ses_${session.environmentId.slice(0, 12)}`);
    }

    const timeout = setTimeout(() => {
      unsub?.();
      log(`[openai] session/new timeout, fallback sessionId`);
      resolve(`ses_${session.environmentId.slice(0, 12)}`);
    }, 30000);

    const unsub = full.onMessage?.((msg) => {
      // 兼容两种响应格式（server.ts 发 raw，session-manager 发包 type/payload）：
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
