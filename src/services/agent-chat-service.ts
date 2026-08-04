import { log, error as logError } from "@fenix/logger";
import type { EngineRelayHandle, EngineRelayMessage } from "@fenix/plugin-sdk";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { environment } from "../db/schema";
import { NotFoundError } from "../errors";
import { connectAgentRelay } from "../transport/agent-relay";
import type { InstanceSpawnSource } from "../types/store";
import { createWebEnvironment } from "./environment-web";
import { spawnInstanceViaController, stopInstanceViaController } from "./orchestration-instance";

// 编排域依赖注入点（对齐 openai-chat.ts 的 setOpenAIChatRouteDeps 模式）：
// openAgentSession 的「spawn → relay → turn」编排依赖集中在此，测试可注入 fake
// 覆盖失败回滚路径，避免 mock.module。
const deps = {
  spawnInstanceViaController,
  stopInstanceViaController,
  connectAgentRelay,
};

/** 测试用：覆盖 agent-chat-service 的编排域依赖，避免 mock.module。 */
export function setAgentChatServiceDeps(overrides: Partial<typeof deps> | null): void {
  if (overrides) {
    Object.assign(deps, overrides);
    return;
  }
  deps.spawnInstanceViaController = spawnInstanceViaController;
  deps.stopInstanceViaController = stopInstanceViaController;
  deps.connectAgentRelay = connectAgentRelay;
}

// ── JSON-RPC 请求 id 生成器 ──

// 随机初始偏移 + 递增，进程内单调。
// 偏移随机的目的：同实例上 yjs 前端路径使用独立的 1,2,3... 计数器，
// 若本模块也从 1 开始，两个计数流可能撞号，导致响应误匹配。
let rpcIdSeq = Math.floor(Math.random() * 1_000_000) * 1_000;
function nextRpcId(): number {
  rpcIdSeq += 1;
  return rpcIdSeq;
}

// ── 类型 ──

export interface AgentSession {
  /** EngineRelayHandle（含 send/onMessage/ready/close） */
  relayHandle: EngineRelayHandle;
  /** 实例 ID */
  instanceId: string;
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
 * 调用方负责实例创建（ensureRunning / spawnInstanceViaController）。
 */
export function createAgentSession(config: {
  relayHandle: EngineRelayHandle;
  instanceId: string;
  /** stop instance 函数，dispose 时调用（可选；不传则仅关闭 relay handle） */
  stopInstance?: () => Promise<void>;
}): AgentSession {
  return {
    relayHandle: config.relayHandle,
    instanceId: config.instanceId,
    dispose: async () => {
      try {
        config.relayHandle.close(1000, "request complete");
      } catch (err) {
        logError("[agent-chat] Failed to close relay handle:", err);
      }
      if (config.stopInstance) {
        try {
          await config.stopInstance();
        } catch (err) {
          logError("[agent-chat] Failed to stop instance:", err);
        }
      }
    },
  };
}

// ── PromptTurn（构建在 AgentSession 之上）──

/**
 * 判断 relay 消息是否属于当前 PromptTurn。
 *
 * 规则：传输层 error 全局保留；session/update 通知按 sessionId 过滤；
 * JSON-RPC 响应（带 id）按 id === turnId 过滤；其余（status、别的方法通知等）丢弃。
 * 兼容原始 {jsonrpc,...} 与包裹 {type, payload:{jsonrpc,...}} 两种格式。
 *
 * 设计原因：relay handle 对同一实例的所有监听器全量 fan-out（无按会话路由），
 * 共享同一 relay handle 的并发 run（workflow 复用实例）必须由消费者侧过滤，
 * 否则别 run 的 update 会进入本 run 事件队列、别 run 的 prompt 响应会结束本 run。
 */
function isTurnMessage(msg: EngineRelayMessage, sessionId: string, turnId: number): boolean {
  // 传输层信号（{type:"error",...} / {type:"relay_closed",...}）与 JSON-RPC 无关，任何 run
  // 都应感知：error 由调用方转为失败；relay_closed 表示实例被回收/停止/机器断连，relay 此后
  // 不会再推送消息，事件流必须收到它才能结束，否则会挂起至兜底超时（workflow 节点超时）。
  if (msg.type === "error" || msg.type === "relay_closed") return true;

  // 提取 JSON-RPC 对象：raw {jsonrpc,...} 或 wrapped {type, payload:{jsonrpc,...}}
  const asAny = msg as unknown as Record<string, unknown>;
  let rpc: Record<string, unknown> | null = null;
  if (asAny.jsonrpc === "2.0") {
    rpc = asAny;
  } else {
    const payload = asAny.payload as Record<string, unknown> | undefined;
    if (payload?.jsonrpc === "2.0") rpc = payload;
  }
  if (!rpc) return false;

  // session/update 通知按 sessionId 过滤
  if (rpc.method === "session/update") {
    const params = rpc.params as Record<string, unknown> | undefined;
    return params?.sessionId === sessionId;
  }

  // JSON-RPC 响应（带 id）按 turnId 过滤（session/prompt 请求 id = turnId）
  if (typeof rpc.id === "number") {
    return rpc.id === turnId;
  }

  return false;
}

/** 基于 AgentSession 创建 PromptTurn */
export function createPromptTurn(session: AgentSession, sessionId: string): PromptTurn {
  // turnId 用作 session/prompt 请求的 JSON-RPC id；用单调递增计数器而非 Date.now()，
  // 避免同毫秒并发的多个 turn 请求 id 碰撞导致响应误匹配
  const turnId = nextRpcId();
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
        // relay 是全量 fan-out 广播：同实例其他 turn 的消息也会到达本监听器，
        // 必须按 sessionId（update 通知）与 turnId（JSON-RPC 响应）过滤，
        // 否则并发 run 的事件流互相串扰
        if (!isTurnMessage(msg, sessionId, turnId)) return;
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
      for (const fn of cleanupFns) {
        try {
          fn();
        } catch {
          // 单个 cleanup 失败不应阻止后续清理
        }
      }
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
    // 唯一请求 id：共享 relay handle 时并发 run 的握手响应按 id 匹配，
    // 固定 -1 会让所有 run 都被同一响应满足，拿到同一个 sessionId
    const rpcId = nextRpcId();
    const rpcMsg: Record<string, unknown> = {
      jsonrpc: "2.0",
      id: rpcId,
      method: options.sessionId ? "session/load" : "session/new",
      params: {},
    };
    if (options.sessionId) {
      (rpcMsg.params as Record<string, unknown>).sessionId = options.sessionId;
    }

    const full = session.relayHandle as EngineRelayHandle & {
      onMessage?: (listener: (msg: EngineRelayMessage) => void) => () => void;
    };

    if (!full.onMessage) {
      log("[openai] relay handle has no onMessage, using fallback sessionId");
      resolve(`ses_${session.instanceId.slice(0, 12)}_${nextRpcId()}`);
    }

    const timeout = setTimeout(() => {
      unsub?.();
      log(`[openai] session/new timeout, fallback sessionId`);
      resolve(`ses_${session.instanceId.slice(0, 12)}_${nextRpcId()}`);
    }, 30000);

    const unsub = full.onMessage?.((msg) => {
      const isRawJsonRpc = (msg as unknown as Record<string, unknown>).jsonrpc === "2.0";
      const msgPayload = (msg as unknown as Record<string, unknown>).payload as Record<string, unknown> | undefined;
      const isWrappedJsonRpc = msgPayload?.jsonrpc === "2.0";
      const rpcSource = isRawJsonRpc ? msg : isWrappedJsonRpc ? msgPayload : null;
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
        // 追加唯一后缀：并发 run 的 fallback 分支也必须拿到互不相同的 sessionId
        const fallback = `ses_${Date.now().toString(36)}_${nextRpcId()}`;
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

// ── 编排层：一站式从 agentId 启动到 PromptTurn ──

export interface OpenAgentSessionInput {
  userId: string;
  /** agent_config.id（非 environment.id），函数内部自动解析为对应的 environment */
  agentConfigId: string;
  organizationId: string;
  /** 可选：恢复已有会话时传入 ACP session ID */
  sessionId?: string;
  startSource: InstanceSpawnSource;
}

export interface OpenAgentSessionResult {
  turn: PromptTurn;
  instanceId: string;
}

/**
 * 一站式打开 Agent 会话：启动独立实例 → 连接 relay → 创建 AgentSession → startPromptTurn。
 *
 * 每次调用创建全新实例（不复用），dispose 时自动销毁。
 * WS relay 路径走 ensureRunning 复用实例，两者策略独立。
 *
 * @param input.agentConfigId — agent_config.id（非 environment.id），需解析为对应的 environment 后再 spawn
 */
export async function openAgentSession(input: OpenAgentSessionInput): Promise<OpenAgentSessionResult> {
  // 1. 解析 agentConfigId (agent_config.id) → environmentId
  // 仅对有效 UUID 做索引查询；非 UUID 提前拒绝，避免经 createWebEnvironment 降级时
  // 触发 Postgres "invalid input syntax for type uuid" 裸错误。
  // 抛 NotFoundError（而非裸 Error）：错误带稳定 code（NOT_FOUND），经 errorPlugin
  // 映射为 404，与 openai-chat 移除本地 message 嗅探前的行为保持一致。
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(input.agentConfigId)) {
    throw new NotFoundError("Agent config not found: invalid agentConfigId format");
  }

  let environmentId: string;
  const existingRows = await db
    .select({ id: environment.id })
    .from(environment)
    .where(
      and(
        eq(environment.organizationId, input.organizationId),
        eq(environment.agentConfigId, input.agentConfigId),
        eq(environment.userId, input.userId),
      ),
    )
    .limit(1);

  if (existingRows.length > 0) {
    environmentId = existingRows[0].id;
    log(`[agent-chat] Reusing existing environment: environmentId=${environmentId} agentId=${input.agentConfigId}`);
  } else {
    // 自动创建 environment（名称组合避免与手动创建的环境冲突）
    // agentId 预期为标准 UUID（a-f0-9 小写），为防止非标准 ID 导致 kebab-case 校验失败，做 sanitize
    const safeSuffix = input.agentConfigId.replace(/[^a-z0-9-]/g, "").slice(0, 8) || "default";
    const autoName = `auto-${safeSuffix}`;
    const env = await createWebEnvironment({
      name: autoName,
      agentConfigId: input.agentConfigId,
      userId: input.userId,
      organizationId: input.organizationId,
      autoStart: true,
    });
    environmentId = env.id;
    log(`[agent-chat] Auto-created environment: environmentId=${environmentId} agentId=${input.agentConfigId}`);
  }

  // 2. 基于解析出的 environmentId 启动实例
  // I4 调用方迁移：经编排域 AgentController（orchestration-instance 桥接层）
  // 替代旧 spawnInstanceFromEnvironment —— controller.spawnInstance 负责环境校验/
  // 并发检查/节点获取/Instance 创建，桥接层再调 core launchInstance 真实启动进程。
  // startSource 透传以保留 RCS supplement 的 spawn_source 审计字段。
  // 经 deps 引用：与步骤 3-5 的编排依赖同源（测试注入 fake 时整链可覆盖），
  // spawn 内部（registerSupplement 等）的回滚治理属 orchestration-instance 自身职责。
  const instance = await deps.spawnInstanceViaController(environmentId, input.userId, input.startSource);
  log(`[agent-chat] Instance spawned: instanceId=${instance.instanceId}`);

  // 3-5. 连接 relay → 创建 AgentSession → startPromptTurn。
  // 步骤 3-5 任一失败都必须回滚本次 spawn 的实例，否则实例残留：spawn 成功时
  // registerSupplement 已在返回前完成（实例计入用户并发额度），且 relay 未建立
  // 连接（relayCount=0）满足 idle 回收条件，需 300s 后才被回收，期间持续占用
  // RCS_USER_AGENT_MAX_CONCURRENCY 额度。
  // session 提升到 try 外供 catch 判断：createAgentSession 是同步纯构造（不抛错），
  // session 为 null 仅当 connectAgentRelay 抛错（此时无 relay handle 可关，直接停止
  // 实例）；session 非 null 时其 dispose() 关闭 relay handle 并停止实例，覆盖
  // startPromptTurn 失败（session/new、session/load 的 rpc error / send 抛错）。
  let session: AgentSession | null = null;
  try {
    const handle = await deps.connectAgentRelay(instance.instanceId, input.sessionId ?? "");
    log(`[agent-chat] Relay connected: instanceId=${instance.instanceId}`);

    // 创建 AgentSession（dispose 时销毁实例；stopInstanceViaController 组合
    // controller.stopInstance + core 进程停止 + registry 清理，确保无进程残留）
    session = createAgentSession({
      relayHandle: handle,
      instanceId: instance.instanceId,
      stopInstance: async () => {
        await deps.stopInstanceViaController(instance.instanceId);
      },
    });

    // 创建 ACP session + PromptTurn
    const { turn } = await startPromptTurn({ session, sessionId: input.sessionId });

    return { turn, instanceId: instance.instanceId };
  } catch (err) {
    // 回滚：步骤 3-5 失败时实例已在 core 运行、controller 活跃表与节点 refCount 均
    // 未归还，不清理将泄漏至 idle 回收并持续占用用户并发额度。stopInstanceViaController
    // 与 session.dispose 均幂等（重复 dispose / 已停止实例安全）；回滚自身失败只记录
    // 日志并继续抛原始错误，不掩盖失败原因、不改变调用方错误语义。
    if (session) {
      await session.dispose().catch((rollbackErr) => {
        logError(`[agent-chat] Failed to rollback session for instance ${instance.instanceId}:`, rollbackErr);
      });
    } else {
      await deps.stopInstanceViaController(instance.instanceId).catch((rollbackErr) => {
        logError(`[agent-chat] Failed to rollback instance ${instance.instanceId}:`, rollbackErr);
      });
    }
    throw err;
  }
}
