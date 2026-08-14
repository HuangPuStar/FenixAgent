/**
 * 外部 ACP 客户端 Relay 薄转发端点（/acp/relay/:agentId）实现。
 *
 * 背景（D-P1.1）：编排域重构删除旧 /acp/relay 端点时只审计了前端消费者，
 * 未检查对外 connect API 契约——`POST /api/agents/:id/instances/connect` 返回的
 * `relay.wsUrl` 仍指向该端点，外部客户端 WS 升级直接 404。
 *
 * 本模块恢复该端点，但严格保持「薄转发」边界：
 * - 客户端消息（ACP JSON-RPC 或 acp-link 事件）原样透传到 core relay handle，
 *   不实现/复制任何 session/new、session/load、session/prompt 协议流程；
 * - 不 spawn 实例——实例启动语义由 connect API（spawnInstanceViaController）负责，
 *   端点只连接「已 running」的实例，避免与编排域启动路径产生第二套入口；
 * - 不做 YJS 聚合与 cwd 注入（外部客户端自行管理 cwd，demo 的 SESSION_CWD 即此用途）。
 *
 * 依赖注入模式仿 setApiInstanceDeps / WsLifecycleDependencies：路由层只做认证，
 * 业务逻辑全部可单测。
 */

import { log, error as logError } from "@fenix/logger";
import type { EngineRelayHandle } from "@fenix/plugin-sdk";
import type { AuthContext } from "../../plugins/auth";
import { type EnvironmentRecord, environmentRepo } from "../../repositories";
import {
  markInstanceRelayAttached,
  markInstanceRelayDetached,
  touchInstanceActivity,
} from "../../services/acp-idle-monitor";
import { getRunningInstancesByEnvironment, type SpawnedInstance } from "../../services/instance";
import { connectAgentRelay, type FullRelayHandle } from "../agent-relay";
import type { WsConnection } from "../ws-types";

/** handler 实际依赖的 environment 字段；收窄后测试只需构造最小对象 */
export type ExternalRelayEnvironment = Pick<EnvironmentRecord, "id" | "organizationId" | "userId">;

export interface ExternalRelayDeps {
  getEnvironmentById: (id: string) => Promise<ExternalRelayEnvironment | null | undefined>;
  getRunningInstancesByEnvironment: (envId: string) => SpawnedInstance[];
  connectAgentRelay: (instanceId: string, sessionId: string) => Promise<EngineRelayHandle>;
  markRelayAttached: (instanceId: string) => void;
  markRelayDetached: (instanceId: string) => void;
  touchActivity: (instanceId: string, message: Record<string, unknown>) => void;
}

const defaultDeps: ExternalRelayDeps = {
  getEnvironmentById: (id) => environmentRepo.getById(id),
  getRunningInstancesByEnvironment,
  connectAgentRelay,
  markRelayAttached: markInstanceRelayAttached,
  markRelayDetached: markInstanceRelayDetached,
  touchActivity: touchInstanceActivity,
};

let deps: ExternalRelayDeps = defaultDeps;

/** 测试覆盖依赖注入；null 还原默认实现。 */
export function setExternalRelayDeps(overrides: Partial<ExternalRelayDeps> | null): void {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}

/**
 * open 异步完成前缓存的客户端消息。
 * 必须在任何 await 之前注册该 buffer，否则 open 期间（env 查询 / relay 连接）
 * 到达的客户端消息会被直接丢弃——旧 relay-handler 验证过此握手竞态的必要结构。
 */
const pendingRelayMessages = new Map<string, Array<Record<string, unknown>>>();

interface ExternalRelayEntry {
  ws: WsConnection;
  relayHandle: FullRelayHandle;
  /** onMessage 注销函数；close 时调用，防止 listener 泄漏 */
  unsub: (() => void) | null;
  instanceId: string;
  /** 是否已收到 agent 的 status（含 capabilities）；决定补发 connect 是否必要 */
  receivedStatus: boolean;
}

const entries = new Map<string, ExternalRelayEntry>();

/** 仅在连接仍打开时发送 JSON 序列化消息，避免向已关闭 WS 写入 */
function sendToRelayWs(ws: WsConnection, message: Record<string, unknown>): void {
  if (ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(message));
  } catch (err) {
    logError("[External-Relay] ws send failed", err);
  }
}

/**
 * 处理外部客户端 relay 连接建立。路由层已完成认证（authCtx 非 null 才调用），
 * 此处完成归属校验、实例解析与 relay 连接。
 *
 * @param requestedInstanceId query 携带的 instanceId（connect API 返回的 wsUrl 已附带），
 *   用于多实例环境（maxSessions>1）精确连接，避免「第一个 running 实例」歧义；
 *   未提供时回退第一个 running 实例（兼容直连裸 wsUrl 的旧用法）。
 */
export async function handleExternalRelayOpen(
  ws: WsConnection,
  relayWsId: string,
  agentId: string,
  authCtx: AuthContext,
  requestedInstanceId?: string,
): Promise<void> {
  // 在任何 await 之前注册 pending buffer，避免握手竞态丢消息
  pendingRelayMessages.set(relayWsId, []);

  try {
    const env = await deps.getEnvironmentById(agentId);
    if (!env) {
      // 通用 reason，不泄露资源标识
      ws.close(4004, "environment not found");
      return;
    }
    // 归属校验：组织匹配或环境归属用户匹配任一放行（对齐 /acp/yjs 端点既有模式）。
    // 拒绝时同样只给通用 reason。
    if (env.organizationId !== authCtx.organizationId && env.userId !== authCtx.userId) {
      ws.close(4003, "unauthorized");
      return;
    }

    // 实例解析限定在该 env 的 running 实例内，杜绝跨租户连接；
    // 无实例一律关闭且不 spawn——spawn 语义由 connect API 负责（见文件头注释）。
    const runningInstances = deps.getRunningInstancesByEnvironment(env.id);
    let instanceId: string;
    if (requestedInstanceId) {
      const matched = runningInstances.find((inst) => inst.id === requestedInstanceId);
      if (!matched) {
        ws.close(4004, "no running instance");
        return;
      }
      instanceId = matched.id;
    } else {
      const first = runningInstances[0];
      if (!first) {
        ws.close(4004, "no running instance");
        return;
      }
      instanceId = first.id;
    }

    // 连接 core relay；失败时不向客户端回传错误原文（可能含 envId/machineId），
    // 完整诊断（含 instanceId）只进服务端日志
    let handle: EngineRelayHandle;
    try {
      handle = await deps.connectAgentRelay(instanceId, "");
    } catch (err) {
      logError(`[External-Relay] connectAgentRelay failed: instanceId=${instanceId}`, err);
      ws.close(1011, "relay connect failed");
      return;
    }

    // await 期间客户端已断开 → 释放 relay 连接并放弃，不 attach（避免 relayCount 悬空）
    if (ws.readyState !== 1) {
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
      return;
    }

    // relayCount=1 阻止 idle 回收在连接建立窗口误杀实例；断开时由 handleExternalRelayClose 成对递减
    deps.markRelayAttached(instanceId);

    // EngineRelayHandle.onMessage 是可选的，connectInstanceRelay 返回的 handle 实际都实现；
    // 这里按 FullRelayHandle 断言以使用 onMessage/ready 扩展（agent-relay.ts 同款做法）
    const full = handle as FullRelayHandle;
    const entry: ExternalRelayEntry = {
      ws,
      relayHandle: full,
      unsub: null,
      instanceId,
      receivedStatus: false,
    };
    entries.set(relayWsId, entry);

    // 先注册 onMessage 再 flush pending，保证 flush 期间 agent 推送不丢
    if (full.onMessage) {
      entry.unsub = full.onMessage((message) => {
        const msgType = message.type;
        // status（含 capabilities）原样转发，并记录已收到——决定补发 connect 是否必要
        if (msgType === "status") {
          entry.receivedStatus = true;
          log("[External-Relay] ← agent status", { relayWsId, instanceId });
          sendToRelayWs(entry.ws, message as unknown as Record<string, unknown>);
          return;
        }
        if (msgType === "relay_closed") {
          log("[External-Relay] ← agent relay_closed", { relayWsId, instanceId });
          // 先发通用 error 事件再关闭：外部 ACPClient 依赖 error/close 事件感知会话失效
          // （旧 relay-handler 同款语义，close 由客户端触发，服务端 close handler 统一清理）
          sendToRelayWs(entry.ws, { type: "error", payload: { message: "Agent connection lost" } });
          entry.ws.close(1011, "agent connection lost");
          return;
        }
        // 非保活业务消息计入实例活跃度，避免连接期间被 activity 硬超时误回收
        deps.touchActivity(entry.instanceId, message as unknown as Record<string, unknown>);
        sendToRelayWs(entry.ws, message as unknown as Record<string, unknown>);
      });
    }

    // 回放 open 期间缓存的消息；丢弃 connect——core connectInstanceRelay 建立时已自动发送，
    // 重复 connect 会让 agent 回传多余 status，触发 acp-link 客户端 resendPending() 重放 pending 请求
    const pending = pendingRelayMessages.get(relayWsId) ?? [];
    pendingRelayMessages.delete(relayWsId);
    for (const msg of pending) {
      if (msg.type === "connect") continue;
      try {
        entry.relayHandle.send(msg as { type: string; payload?: unknown });
      } catch (err) {
        logError("[External-Relay] pending flush failed", err);
      }
    }

    // 补发 connect 兜底：core connectInstanceRelay 建立时已自动发送 connect，
    // 但存在 connect 早于 agent dispatcher 创建的竞态导致 capabilities 永不回传；
    // 仅当尚未收到 status 时补发，避免重复 status 触发客户端重放（旧实现第 6 步同款逻辑）
    if (!entry.receivedStatus) {
      try {
        entry.relayHandle.send({ type: "connect" });
      } catch {
        /* relay handle 可能未就绪，忽略 */
      }
    }
    log(`[External-Relay] established: relayWsId=${relayWsId} agentId=${agentId} instanceId=${instanceId}`);
  } catch (err) {
    // 兜底清理（env 查询等内部错误路径）：清 pending、注销 listener、递减 relayCount，
    // 之后对客户端关闭并保留完整诊断进服务端日志
    pendingRelayMessages.delete(relayWsId);
    const entry = entries.get(relayWsId);
    if (entry) {
      entries.delete(relayWsId);
      entry.unsub?.();
      deps.markRelayDetached(entry.instanceId);
    }
    logError(`[External-Relay] Open failed: relayWsId=${relayWsId} agentId=${agentId}`, err);
    try {
      ws.close(1011, "setup failed");
    } catch {
      /* ignore */
    }
  }
}

/**
 * 转发客户端消息到 agent relay；open 异步未完成时缓存等待 flush。
 * ACP JSON-RPC 消息（无 type 字段）与 acp-link 事件原样透传，不做任何协议加工。
 */
export function handleExternalRelayMessage(
  ws: WsConnection,
  relayWsId: string,
  data: string | Record<string, unknown>,
): void {
  let parsed: Record<string, unknown>;
  if (typeof data === "string") {
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch (err) {
      // 非法 JSON 忽略（旧实现同款）；不关闭连接，避免单个坏帧打断会话
      logError("[External-Relay] invalid JSON message", err);
      return;
    }
    // JSON.parse 可能产出原始值（数字/字符串帧），后续字段访问会静默 undefined，
    // 这里显式拒绝非对象帧，避免把原始值转发给 agent
    if (typeof parsed !== "object" || parsed === null) return;
  } else {
    parsed = data;
  }

  // acp-link 客户端心跳：直接回 pong，不进入转发路径
  if (parsed.type === "ping") {
    sendToRelayWs(ws, { type: "pong" });
    return;
  }
  // 客户端 connect 一律丢弃（理由见 handleExternalRelayOpen 补发逻辑）
  if (parsed.type === "connect") return;

  // open 异步未完成 → 缓存；完成后由 flush 统一回放
  if (pendingRelayMessages.has(relayWsId)) {
    pendingRelayMessages.get(relayWsId)!.push(parsed);
    return;
  }

  const entry = entries.get(relayWsId);
  if (!entry) return;
  try {
    entry.relayHandle.send(parsed as { type: string; payload?: unknown });
    deps.touchActivity(entry.instanceId, parsed);
  } catch (err) {
    logError("[External-Relay] relay send failed", err);
    ws.close(1011, "relay send failed");
  }
}

/**
 * 清理连接条目：清 pending、注销 onMessage（防 listener 泄漏）、递减 relayCount。
 * 不关闭实例——实例生命周期由 connect API / idle monitor 管理。
 * 重复调用幂等（条目不存在直接返回）。
 */
export function handleExternalRelayClose(_ws: WsConnection, relayWsId: string): void {
  pendingRelayMessages.delete(relayWsId);
  const entry = entries.get(relayWsId);
  if (!entry) return;
  entries.delete(relayWsId);
  entry.unsub?.();
  deps.markRelayDetached(entry.instanceId);
  log(`[External-Relay] closed: relayWsId=${relayWsId} instanceId=${entry.instanceId}`);
}
