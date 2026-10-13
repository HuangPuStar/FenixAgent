/**
 * ACP WebSocket（`/acp/ws`）连接的登记项与只读快照。
 *
 * 为什么归本包：这两个类型描述的是本包 `server/transport/acp-ws-handler.ts` 持有的连接 Map 的形状——
 * 键是 `wsId`，值是 per-connection 状态（订阅句柄、keepalive 定时器、machine 注册标记、远端 transport 槽位）。
 * 它们此前声明在宿主 `apps/server/src/types/store.ts`（阶段 1 物理迁移前的 `src/transport/acp-ws-handler.ts`
 * 就地抽出），迁移后宿主已无消费方（实测：宿主 0 处引用），故随 1.4 的 W1 类型搬家收回本包。
 */

import type { RemoteTransport } from "@fenix/remote-runtime";
import type { WsConnection } from "./ws-types";

/** `/acp/ws` 的 per-connection 状态。 */
export interface AcpConnectionEntry {
  agentId: string | null;
  boundEnvId: string | null;
  userId: string;
  unsub: (() => void) | null;
  keepalive: ReturnType<typeof setInterval> | null;
  ws: WsConnection;
  openTime: number;
  lastClientActivity: number;
  capabilities: Record<string, unknown> | null;
  /** 标记此连接为 machine 注册连接（非 ACP agent 连接）。 */
  isMachine: boolean;
  /** machine 注册成功后分配的 ID（mach_xxx），注册完成前为 null。 */
  machineId: string | null;
  /** 连接自身的 wsId（与 connections Map 的 key 一致），方便 entry 反查自身。 */
  wsId: string;
  /** relay 层注册的 per-session 消息回调。 */
  sessionMessageListeners?: Map<string, (sessionId: string, type: string, payload: unknown) => void>;
  /** relay 层设置的回调，machine 连接收到 session 消息时调用。 */
  onSessionMessage?: (sessionId: string, type: string, payload: unknown) => void;
  /** Machine 完成当前 server epoch clean-slate 后才允许 lifecycle 流量。 */
  cleanSlateConfirmed?: boolean;
  /** 远程 transport 实例（由 registerRemoteNode 设置），用于将消息路由到 core remote-runtime。 */
  remoteTransport?: RemoteTransport;
}

/**
 * ACP 连接的只读快照：供 Observer 等只读消费者遍历活跃连接。
 * 刻意不包含 ws/unsub/keepalive 等句柄字段，避免句柄外泄与生命周期干扰。
 */
export interface AcpConnectionSnapshot {
  wsId: string;
  userId: string;
  agentId: string | null;
  boundEnvId: string | null;
  machineId: string | null;
  isMachine: boolean;
  openTime: number;
  capabilities: Record<string, unknown> | null;
}
