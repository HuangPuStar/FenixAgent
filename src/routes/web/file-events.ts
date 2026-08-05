import { error as logError, warn as logWarn } from "@fenix/logger";
import Elysia from "elysia";
import { validateEnv } from "../../env";
import { AppError, NotFoundError } from "../../errors";
import { authenticateRequest, type RequestAuthResult } from "../../plugins/auth";
import { FileEventsSubscribeSchema } from "../../schemas/file-events.schema";
import { getOwnedEnvironment } from "../../services/environment";
import { subscribe } from "../../services/file-event-queue";
import type { WsConnection } from "../../transport/ws-types";

/**
 * WS /web/file-events — 文件变更事件订阅端点（docs/arch/12-files.md §4.3）。
 *
 * 结构为「薄壳 + handler」分离（参照 file-ws-handler）：薄壳只做 Elysia WS
 * 适配与 session 认证（authenticateRequest，sessionAuth 插件不覆盖 WS 升级），
 * 订阅/限连/生命周期逻辑全部在可单测的 handler 层，不依赖框架类型。
 *
 * 契约要点：
 * - 订阅帧 `{ type: "subscribe", environments: [...] }` 逐环境 getOwnedEnvironment 校验；
 *   无权限显式回 `{ type: "subscribe_error", environment_id, code: "forbidden" }`。
 * - 连接上限为服务级独立池（RCS_FILE_EVENTS_MAX_CLIENTS，与 YJS_MAX_CLIENTS 分池），
 *   超限 close 1013。
 * - 断开必须取消全部订阅（队列 unsubscribe；无订阅且无机器声明时队列自动销毁）。
 * - 事件经 file-event-queue 按环境 fan-out 下发，本端点只透传帧。
 */

/** 服务级连接上限默认值（env 未配置时） */
export const DEFAULT_FILE_EVENTS_MAX_CLIENTS = 200;

/** 关闭码：服务过载（连接数达上限） */
const WS_CLOSE_TOO_MANY_CLIENTS = 1013;
/** 关闭码：未认证 */
const WS_CLOSE_UNAUTHORIZED = 4003;
/** 关闭码：限流 */
const WS_CLOSE_RATE_LIMITED = 4008;

/** 已认证订阅者的组织上下文（由薄壳从 authResult 提取） */
export interface FileEventsAuth {
  userId: string;
  organizationId: string;
}

/** 客户端句柄：薄壳持有，转发消息并在 close 时释放资源 */
export interface FileEventsClient {
  /** 处理一条入站消息（subscribe 帧）；返回 Promise 供测试等待异步订阅完成 */
  handleMessage(raw: string | Record<string, unknown>): Promise<void>;
  close(): void;
}

interface FileEventsClientState {
  ws: WsConnection;
  auth: FileEventsAuth;
  /** 已订阅环境（按 environmentId 去重，防止重复订阅导致事件双发） */
  subscribedEnvironments: Set<string>;
  /** 已订阅环境的取消函数集合（断开时全部执行） */
  unsubscribers: Set<() => void>;
}

/** 当前活跃的 file-events 客户端（服务级计数，超限 close 1013） */
const activeClients = new Set<FileEventsClientState>();

/** 取消该客户端全部环境订阅；队列无订阅者且无机器声明时会被自动销毁 */
function unsubscribeAll(state: FileEventsClientState): void {
  for (const unsub of state.unsubscribers) {
    try {
      unsub();
    } catch (err) {
      // 单个取消失败不阻断其余订阅清理，保留诊断上下文
      logError("[file-events] unsubscribe failed:", err);
    }
  }
  state.unsubscribers.clear();
  state.subscribedEnvironments.clear();
}

/**
 * 关闭客户端：取消全部订阅并释放连接槽位。幂等（重复调用无害）。
 */
function closeFileEventsClient(state: FileEventsClientState): void {
  if (!activeClients.delete(state)) {
    return;
  }
  unsubscribeAll(state);
}

/**
 * 打开 file-events 客户端。
 *
 * - auth 为 null（未认证 / 无组织上下文）→ close 4003，返回 null；
 * - 活跃连接数已达 maxClients → close 1013，返回 null；
 * - 成功 → 登记连接槽位并返回句柄。
 */
export function handleFileEventsOpen(
  ws: WsConnection,
  auth: FileEventsAuth | null,
  maxClients: number = DEFAULT_FILE_EVENTS_MAX_CLIENTS,
): FileEventsClient | null {
  if (!auth) {
    ws.close(WS_CLOSE_UNAUTHORIZED, "unauthorized");
    return null;
  }
  if (activeClients.size >= maxClients) {
    ws.close(WS_CLOSE_TOO_MANY_CLIENTS, "too many clients");
    return null;
  }
  const state: FileEventsClientState = {
    ws,
    auth,
    subscribedEnvironments: new Set(),
    unsubscribers: new Set(),
  };
  activeClients.add(state);
  return {
    handleMessage: (raw) => handleFileEventsMessage(state, raw),
    close: () => closeFileEventsClient(state),
  };
}

/**
 * 处理入站消息：仅接受 subscribe 帧；解析失败或校验失败记录日志并忽略
 * （协议外帧不回错误帧，避免放大攻击面）。返回 Promise 供测试等待。
 */
async function handleFileEventsMessage(
  state: FileEventsClientState,
  raw: string | Record<string, unknown>,
): Promise<void> {
  let frame: unknown = raw;
  if (typeof raw === "string") {
    try {
      frame = JSON.parse(raw);
    } catch (err) {
      // 非 JSON 消息按协议外输入忽略，但保留解析错误对象便于诊断
      logWarn("[file-events] received non-JSON message, ignored", err);
      return;
    }
  }
  const parsed = FileEventsSubscribeSchema.safeParse(frame);
  if (!parsed.success) {
    logWarn("[file-events] received invalid subscribe frame, ignored");
    return;
  }
  for (const envId of parsed.data.environments) {
    await subscribeEnvironment(state, envId);
  }
}

/** 订阅单个环境：先校验访问权，无权限显式回 subscribe_error 帧 */
async function subscribeEnvironment(state: FileEventsClientState, envId: string): Promise<void> {
  if (state.subscribedEnvironments.has(envId)) {
    return;
  }
  try {
    await getOwnedEnvironment(envId, state.auth.organizationId, state.auth.userId);
  } catch (err) {
    if (err instanceof NotFoundError) {
      // 环境不存在或不属于当前组织：按契约显式回 forbidden，区分"无权限"与"网络故障"
      state.ws.send(JSON.stringify({ type: "subscribe_error", environment_id: envId, code: "forbidden" }));
      return;
    }
    // 非权限类错误（如存储故障）不回 forbidden（避免误导订阅方），仅保留诊断上下文
    logError(`[file-events] access check failed for environment ${envId}:`, err);
    return;
  }
  state.subscribedEnvironments.add(envId);
  const unsub = subscribe(envId, (frame) => {
    try {
      state.ws.send(JSON.stringify(frame));
    } catch (err) {
      // 发送失败通常意味着连接已关闭；close 流程会取消订阅，这里只留诊断上下文
      logError(`[file-events] send failed for environment ${envId}:`, err);
    }
  });
  state.unsubscribers.add(unsub);
}

/** 关闭全部活跃客户端（服务 shutdown 与测试清理用） */
export function closeAllFileEventsClients(): void {
  for (const state of [...activeClients]) {
    closeFileEventsClient(state);
  }
}

/** 将 Elysia WS 适配为 WsConnection（与 acp/index.ts 同模式） */
// biome-ignore lint/suspicious/noExplicitAny: Elysia WS 类型与 WsConnection 不完全兼容
function adaptWs(ws: any): WsConnection {
  return {
    send: (data: string) => ws.send(data),
    close: (code?: number, reason?: string) => ws.close(code, reason),
    get readyState() {
      return ws.readyState;
    },
  };
}

/** 从认证结果提取订阅上下文；无 user 或无组织上下文视为未认证（参照 yjs 端点） */
function toFileEventsAuth(authResult: RequestAuthResult | null): FileEventsAuth | null {
  if (!authResult?.user || !authResult.authContext) {
    return null;
  }
  return {
    userId: authResult.user.id,
    organizationId: authResult.authContext.organizationId,
  };
}

const app = new Elysia({ name: "web-file-events", prefix: "/file-events" }).ws("/", {
  detail: {
    tags: ["Files"],
    summary: "文件变更事件订阅 WebSocket",
    description:
      "订阅环境的文件变更事件（file_changed / file_changed_batch / invalidate_all / degraded）。" +
      "连接须携带有效 session（WS 升级不经过 sessionAuth 插件，端点内显式认证）；" +
      "订阅帧逐环境校验访问权，无权限显式返回 subscribe_error。",
  },
  async open(ws) {
    let authResult: RequestAuthResult | null = null;
    try {
      authResult = await authenticateRequest(ws.data.request);
    } catch (err) {
      if (err instanceof AppError && err.code === "RATE_LIMITED") {
        adaptWs(ws).close(WS_CLOSE_RATE_LIMITED, "rate_limited");
        return;
      }
      throw err;
    }
    const client = handleFileEventsOpen(
      adaptWs(ws),
      toFileEventsAuth(authResult),
      validateEnv().RCS_FILE_EVENTS_MAX_CLIENTS,
    );
    if (client) {
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
      (ws.data as any).__fileEventsClient = client;
    }
  },
  message(ws, data) {
    // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
    const client = (ws.data as any).__fileEventsClient as FileEventsClient | undefined;
    if (client) {
      // 订阅处理为异步（逐环境访问权校验），失败路径已在 handler 内收敛，此处不等待
      void client.handleMessage(data as string | Record<string, unknown>);
    }
  },
  close(ws) {
    // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
    const client = (ws.data as any).__fileEventsClient as FileEventsClient | undefined;
    if (client) {
      client.close();
    }
  },
});

export default app;
