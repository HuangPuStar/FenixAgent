import { log, error as logError } from "@fenix/logger";
import Elysia from "elysia";
import { v4 as uuid } from "uuid";
import { validateEnv } from "../../env";
import { AppError } from "../../errors";
import type { RequestAuthResult } from "../../plugins/auth";
import { authenticateRequest, authGuardPlugin } from "../../plugins/auth";
import { environmentRepo } from "../../repositories";
import {
  AcpAgentListResponseSchema,
  AcpRegistrySecretQuerySchema,
  AcpRelayParamsSchema,
  AcpRelayQuerySchema,
} from "../../schemas";
import { handleAcpWsClose, handleAcpWsMessage, handleAcpWsOpen } from "../../transport/acp-ws-handler";
import { handleFileWsClose, handleFileWsMessage, handleFileWsOpen } from "../../transport/file-ws-handler";
import { handleRelayClose, handleRelayMessage, handleRelayOpen } from "../../transport/relay";
import type { WsConnection } from "../../transport/ws-types";

/** Maximum WebSocket message size: 10 MB */
const MAX_WS_MESSAGE_SIZE = 10 * 1024 * 1024;

/** Adapt Elysia WS to WsConnection interface */
// biome-ignore lint/suspicious/noExplicitAny: Elysia WS type not directly compatible with WsConnection
function adaptWs(ws: any): WsConnection {
  return {
    send: (data: string) => ws.send(data),
    close: (code?: number, reason?: string) => ws.close(code, reason),
    get readyState() {
      return ws.readyState;
    },
  };
}

/** Response shape for an ACP agent */
function toAcpAgentResponse(env: NonNullable<Awaited<ReturnType<typeof environmentRepo.getById>>>) {
  return {
    id: env.id,
    agent_name: env.machineName,
    status: (env.status === "active" ? "online" : "offline") as "online" | "offline",
    max_sessions: env.maxSessions,
    last_seen_at: env.lastPollAt ? env.lastPollAt.getTime() / 1000 : null,
    created_at: env.createdAt.getTime() / 1000,
  };
}

const app = new Elysia({ name: "acp", prefix: "/acp" })
  .use(authGuardPlugin)
  .model({
    "acp-agent-list-response": AcpAgentListResponseSchema,
    "acp-relay-params": AcpRelayParamsSchema,
    "acp-relay-query": AcpRelayQuerySchema,
    "acp-registry-secret-query": AcpRegistrySecretQuerySchema,
  })

  /** GET /acp/agents — List current user's team ACP agents */
  .get(
    "/agents",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema 下的类型推断过于严格
    async ({ store }: any) => {
      const authCtx = store.authContext;
      const orgId = authCtx?.organizationId ?? store.user!.id;
      const teamEnvs = await environmentRepo.listByOrganizationId(orgId);
      const acpEnvs = teamEnvs.filter((e) => e.workerType === "acp");
      return acpEnvs.map((a) => toAcpAgentResponse(a));
    },
    {
      sessionAuth: true,
      response: "acp-agent-list-response",
      detail: {
        tags: ["ACP"],
        summary: "获取 ACP Agent 列表",
        description: "返回当前组织下所有使用 ACP worker 的环境列表及在线状态摘要。",
      },
    },
  )

  /** WS /acp/ws — WebSocket endpoint for acp-link connections */
  .ws("/ws", {
    detail: {
      tags: ["ACP"],
      summary: "ACP 机器接入 WebSocket",
      description:
        "供 `acp-link` 或兼容机器侧运行时接入的 WebSocket 端点。连接时必须通过 query 参数提供 `secret`，且需与服务端 `REGISTRY_SECRET` 匹配。建立连接后，客户端按 ACP/注册中心协议发送消息帧，服务端负责机器注册、状态同步和消息转发。",
    },
    query: "acp-registry-secret-query",
    async open(ws) {
      const url = new URL(ws.data.request.url);
      const secret = url.searchParams.get("secret");
      const registrySecret = validateEnv().REGISTRY_SECRET;

      if (!secret || !registrySecret || secret !== registrySecret) {
        log("[ACP-WS] Upgrade rejected: invalid or missing registry secret");
        adaptWs(ws).close(4003, "unauthorized");
        return;
      }

      const wsId = `acp_ws_${uuid().replace(/-/g, "")}`;
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension
      (ws.data as any).__acpWsId = wsId;
      log(`[ACP-WS] Machine upgrade accepted: wsId=${wsId} secret matched`);
      handleAcpWsOpen(adaptWs(ws), wsId, "__machine__", null, true);
    },
    message(ws, data) {
      // Elysia's parseMessage auto-parses JSON strings into objects;
      // pass the already-parsed object directly to avoid redundant stringify→parse.
      if (typeof data === "string" && data.length > MAX_WS_MESSAGE_SIZE) {
        logError(`[ACP-WS] Message too large: ${data.length} bytes`);
        adaptWs(ws).close(1009, "message too large");
        return;
      }
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
      const wsId = (ws.data as any).__acpWsId as string | undefined;
      if (wsId) {
        handleAcpWsMessage(adaptWs(ws), wsId, data as string | Record<string, unknown>);
      }
    },
    close(ws, code, reason) {
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
      const wsId = (ws.data as any).__acpWsId as string | undefined;
      if (wsId) {
        handleAcpWsClose(adaptWs(ws), wsId, code, reason);
      }
    },
  })

  /** WS /acp/file-ws — WebSocket endpoint for remote file operations */
  .ws("/file-ws", {
    detail: {
      tags: ["ACP"],
      summary: "ACP 远程文件 WebSocket",
      description:
        "供远端运行时执行文件读写操作的 WebSocket 端点。连接时同样要求 query 参数 `secret` 与服务端 `REGISTRY_SECRET` 匹配，消息帧格式由远程文件协议决定。",
    },
    query: "acp-registry-secret-query",
    async open(ws) {
      const url = new URL(ws.data.request.url);
      const secret = url.searchParams.get("secret");
      const registrySecret = validateEnv().REGISTRY_SECRET;

      if (!secret || !registrySecret || secret !== registrySecret) {
        log("[File-WS] Upgrade rejected: invalid or missing registry secret");
        adaptWs(ws).close(4003, "unauthorized");
        return;
      }

      const wsId = `file_ws_${uuid().replace(/-/g, "")}`;
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension
      (ws.data as any).__fileWsId = wsId;
      log(`[File-WS] Upgrade accepted: wsId=${wsId}`);
      handleFileWsOpen(adaptWs(ws), wsId);
    },
    message(ws, data) {
      if (typeof data === "string" && data.length > MAX_WS_MESSAGE_SIZE) {
        logError(`[File-WS] Message too large: ${data.length} bytes`);
        adaptWs(ws).close(1009, "message too large");
        return;
      }
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
      const wsId = (ws.data as any).__fileWsId as string | undefined;
      if (wsId) {
        handleFileWsMessage(adaptWs(ws), wsId, data as string | Record<string, unknown>);
      }
    },
    close(ws, _code, _reason) {
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
      const wsId = (ws.data as any).__fileWsId as string | undefined;
      if (wsId) {
        handleFileWsClose(adaptWs(ws), wsId);
      }
    },
  })

  /** WS /acp/relay/:agentId — WebSocket relay for frontend to interact with an agent */
  .ws("/relay/:agentId", {
    detail: {
      tags: ["ACP"],
      summary: "ACP 前端 Relay WebSocket",
      description:
        "前端通过该 WebSocket 与指定 ACP Agent 建立中继连接。升级时要求已登录会话，服务端会校验 `agentId` 所属组织。可选 query 参数 `sessionId` 用于复用既有会话。",
    },
    params: "acp-relay-params",
    query: "acp-relay-query",
    async open(ws) {
      // 在任何 await 之前先挂上 relayWsId，避免前端在握手刚完成时抢先发来的
      // ping/connect 消息进入 message 分支后拿不到 ws 级别的 relay 标识，产生误报日志。
      const relayWsId = `relay_${uuid().replace(/-/g, "")}`;
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
      (ws.data as any).__relayWsId = relayWsId;

      let authResult: RequestAuthResult | null = null;
      try {
        authResult = await authenticateRequest(ws.data.request);
      } catch (err) {
        if (err instanceof AppError && err.code === "RATE_LIMITED") {
          log("[ACP-Relay] Upgrade rejected: API key rate limited");
          adaptWs(ws).close(4008, "rate_limited");
          return;
        }
        throw err;
      }
      if (!authResult?.user) {
        log("[ACP-Relay] Upgrade rejected: not authenticated");
        adaptWs(ws).close(4003, "unauthorized");
        return;
      }

      const userId = authResult.user.id;
      const agentId = ws.data.params.agentId;
      const sessionId = ws.data.query?.sessionId as string | undefined;

      // Verify agent belongs to this user's team
      const env = await environmentRepo.getById(agentId);
      if (!env) {
        log(`[ACP-Relay] Upgrade rejected: agent ${agentId} not found`);
        adaptWs(ws).close(4003, "unauthorized");
        return;
      }
      // 同组织成员允许访问同一组织的 environment（含 ProdView 发布视图场景）；
      // 仅当跨组织且非本人时拒绝。
      const authCtx = authResult.authContext;
      if (!authCtx || (env.organizationId !== authCtx.organizationId && env.userId !== userId)) {
        log(`[ACP-Relay] Upgrade rejected: agent ${agentId} not owned by user ${userId}'s team`);
        adaptWs(ws).close(4003, "unauthorized");
        return;
      }

      log(`[ACP-Relay] Upgrade accepted: relayWsId=${relayWsId} agentId=${agentId}`);
      handleRelayOpen(adaptWs(ws), relayWsId, agentId, userId, sessionId);
    },
    message(ws, data) {
      // Elysia's parseMessage auto-parses JSON strings into objects;
      // pass the already-parsed object directly to avoid redundant stringify→parse.
      if (typeof data === "string" && data.length > MAX_WS_MESSAGE_SIZE) {
        logError(`[ACP-Relay] Message too large: ${data.length} bytes`);
        adaptWs(ws).close(1009, "message too large");
        return;
      }
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
      const relayWsId = (ws.data as any).__relayWsId as string | undefined;
      if (relayWsId) {
        const payload =
          typeof data === "object" && data !== null ? (data as Record<string, unknown>) : (data as string);
        handleRelayMessage(adaptWs(ws), relayWsId, payload);
      } else {
        logError(`[ACP-Relay-WS] No relayWsId on ws.data`);
      }
    },
    close(ws, code, reason) {
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
      const relayWsId = (ws.data as any).__relayWsId as string | undefined;
      if (relayWsId) {
        handleRelayClose(adaptWs(ws), relayWsId, code, reason);
      }
    },
  });

export default app;
