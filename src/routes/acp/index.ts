import { createDeterministicRcsSessionId } from "@fenix/chat-channel";
import { log, error as logError } from "@fenix/logger";
import Elysia from "elysia";
import { v4 as uuid } from "uuid";
import { validateEnv } from "../../env";
import { AppError } from "../../errors";
import type { RequestAuthResult } from "../../plugins/auth";
import { authenticateRequest, authGuardPlugin } from "../../plugins/auth";
import { environmentRepo } from "../../repositories";
import { AcpAgentListResponseSchema, AcpRegistrySecretQuerySchema, AcpRelayParamsSchema } from "../../schemas";
import { getChatChannelController } from "../../services/chat-channel-bootstrap";
import { handleAcpWsClose, handleAcpWsMessage, handleAcpWsOpen } from "../../transport/acp-ws-handler";
import { handleFileWsClose, handleFileWsMessage, handleFileWsOpen } from "../../transport/file-ws-handler";
import {
  handleExternalRelayClose,
  handleExternalRelayMessage,
  handleExternalRelayOpen,
} from "../../transport/relay/external-relay";
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

  /** WS /acp/yjs/:agentId — YJS-only WebSocket endpoint for frontend */
  .ws("/yjs/:agentId", {
    detail: {
      tags: ["ACP"],
      summary: "YJS Frontend WebSocket",
      description:
        "专用于前端的 YJS WebSocket 端点。仅传输 yjs:update CRDT 增量消息和简单 JSON 出站命令。不涉及 ACP JSON-RPC 协议。",
    },
    params: "acp-relay-params",
    async open(ws) {
      const yjsWsId = `yjs_${uuid().replace(/-/g, "")}`;
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
      (ws.data as any).__yjsWsId = yjsWsId;

      let authResult: RequestAuthResult | null = null;
      try {
        authResult = await authenticateRequest(ws.data.request);
      } catch (err) {
        if (err instanceof AppError && err.code === "RATE_LIMITED") {
          adaptWs(ws).close(4008, "rate_limited");
          return;
        }
        throw err;
      }
      if (!authResult?.user) {
        adaptWs(ws).close(4003, "unauthorized");
        return;
      }

      const userId = authResult.user.id;
      const agentId = ws.data.params.agentId;
      // 从 query 参数读取 sessionId（DB 会话标识），
      // 用于在多实例场景下隔离不同实例的 YJS doc。
      const url = new URL(ws.data.request.url);
      const sessionId = url.searchParams.get("sessionId") || undefined;
      const rcsSessionId = createDeterministicRcsSessionId(agentId, userId, sessionId);

      const env = await environmentRepo.getById(agentId);
      const authCtx = authResult.authContext;
      if (!env || !authCtx || (env.organizationId !== authCtx.organizationId && env.userId !== userId)) {
        adaptWs(ws).close(4003, "unauthorized");
        return;
      }

      log(`[YJS-WS] Opening: wsId=${yjsWsId} user=${userId} agentId=${agentId} sessionId=${sessionId ?? "none"}`);

      try {
        await getChatChannelController().gateway.handleOpen(
          adaptWs(ws),
          yjsWsId,
          userId,
          agentId,
          rcsSessionId,
          sessionId,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError(`[YJS-WS] Open failed: ${message}`, err);
        try {
          adaptWs(ws).close(1011, "setup failed");
        } catch {
          /* ignore */
        }
      }
    },
    message(ws, data) {
      if (typeof data === "string" && data.length > MAX_WS_MESSAGE_SIZE) {
        adaptWs(ws).close(1009, "message too large");
        return;
      }
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
      const yjsWsId = (ws.data as any).__yjsWsId as string | undefined;
      if (yjsWsId) {
        const text = typeof data === "string" ? data : JSON.stringify(data);
        getChatChannelController().gateway.handleMessage(adaptWs(ws), yjsWsId, text);
      }
    },
    close(ws) {
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
      const yjsWsId = (ws.data as any).__yjsWsId as string | undefined;
      if (yjsWsId) {
        getChatChannelController().gateway.handleClose(yjsWsId);
      }
    },
  })

  /** WS /acp/relay/:agentId — 供 API Key 外部客户端经 connect API 建立 ACP JSON-RPC 中继 */
  .ws("/relay/:agentId", {
    detail: {
      tags: ["ACP"],
      summary: "ACP 外部客户端 Relay WebSocket",
      description:
        "供 API Key 外部客户端经 connect API 获取 wsUrl 后建立 ACP JSON-RPC 中继。服务端仅做传输层转发，不实现会话协议；query 可选携带 instanceId，用于多实例环境精确指定实例。",
    },
    params: "acp-relay-params",
    async open(ws) {
      const relayWsId = `ext_relay_${uuid().replace(/-/g, "")}`;
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
      (ws.data as any).__relayWsId = relayWsId;

      let authResult: RequestAuthResult | null = null;
      try {
        authResult = await authenticateRequest(ws.data.request);
      } catch (err) {
        if (err instanceof AppError && err.code === "RATE_LIMITED") {
          adaptWs(ws).close(4008, "rate_limited");
          return;
        }
        throw err;
      }
      if (!authResult?.user || !authResult.authContext) {
        adaptWs(ws).close(4003, "unauthorized");
        return;
      }

      // query 携带的 instanceId 用于多实例环境精确连接（connect API 返回的 wsUrl 已附带）；
      // 解析放在路由层，handler 只接收解析结果，便于脱离 Elysia 单测。
      const url = new URL(ws.data.request.url);
      const requestedInstanceId = url.searchParams.get("instanceId") || undefined;
      await handleExternalRelayOpen(
        adaptWs(ws),
        relayWsId,
        ws.data.params.agentId,
        authResult.authContext,
        requestedInstanceId,
      );
    },
    message(ws, data) {
      if (typeof data === "string" && data.length > MAX_WS_MESSAGE_SIZE) {
        logError(`[External-Relay] Message too large: ${data.length} bytes`);
        adaptWs(ws).close(1009, "message too large");
        return;
      }
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
      const relayWsId = (ws.data as any).__relayWsId as string | undefined;
      if (relayWsId) {
        handleExternalRelayMessage(adaptWs(ws), relayWsId, data as string | Record<string, unknown>);
      }
    },
    close(ws) {
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
      const relayWsId = (ws.data as any).__relayWsId as string | undefined;
      if (relayWsId) {
        handleExternalRelayClose(adaptWs(ws), relayWsId);
      }
    },
  });

export default app;
