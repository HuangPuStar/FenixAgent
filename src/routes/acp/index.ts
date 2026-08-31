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
import { formatFileWsCloseLog } from "../../transport/file-ws-close-log";
import { handleFileWsClose, handleFileWsMessage, handleFileWsOpen } from "../../transport/file-ws-handler";
import {
  checkParsedObjectSize,
  checkWsMessageSize,
  estimateWsMessageBytes,
  parseFileWsMessage,
} from "../../transport/file-ws-payload";
import {
  handleExternalRelayClose,
  handleExternalRelayMessage,
  handleExternalRelayOpen,
} from "../../transport/relay/external-relay";
import type { WsConnection } from "../../transport/ws-types";

/** Maximum WebSocket message size: 10 MB — 仅用于 acp-ws / yjs / relay（file-ws 用 RCS_FILE_WS_MAX_PAYLOAD_MB，见下） */
const MAX_WS_MESSAGE_SIZE = 10 * 1024 * 1024;

/**
 * 统一尺寸检查（acp-ws / yjs / relay 共用，10MB 上限不变）。
 *
 * 字符串按 UTF-8 字节、二进制帧按 byteLength；object 帧（Elysia 默认
 * `createWSMessageParser` 已把 `{` 开头单行 JSON 自动 parse 成对象）必须补
 * 重序列化检查——仅 `typeof === "string"` 检查会绕过（D12 残留），
 * 而 uWS 全局 maxPayloadLength 已放宽到 32MB（file-ws 需要），
 * 若不补检查，本端点真实上限将从 16MB 静默变为 32MB。
 */
function isOverWsLimit(data: unknown): boolean {
  return (
    checkWsMessageSize(data as string | Uint8Array, MAX_WS_MESSAGE_SIZE) ||
    checkParsedObjectSize(data, MAX_WS_MESSAGE_SIZE)
  );
}

/**
 * file-ws 单帧最大载荷（字节），来源 `RCS_FILE_WS_MAX_PAYLOAD_MB`（默认 32MB，§7.6）。
 *
 * 惰性求值并缓存：本模块在 index.ts 的 `applyEnv(validateEnv())` 之前被静态 import，
 * 且 validateEnv 在测试环境缺少必填变量时会抛错，不能在模块顶层调用；
 * 首次消息到达时 env 已校验完毕，取一次后缓存。
 */
let fileWsMaxPayloadBytes: number | null = null;
function getFileWsMaxPayloadBytes(): number {
  fileWsMaxPayloadBytes ??= validateEnv().RCS_FILE_WS_MAX_PAYLOAD_MB * 1024 * 1024;
  return fileWsMaxPayloadBytes;
}

/** Adapt Elysia WS to WsConnection interface */
// biome-ignore lint/suspicious/noExplicitAny: Elysia WS type not directly compatible with WsConnection
function adaptWs(ws: any): WsConnection {
  return {
    // 二进制 yjs:update 帧（SP-A4）必须走 sendBinary：Elysia 的 send 对 object 一律
    // JSON.stringify，Uint8Array 会被序列化成数字索引对象文本而非透传二进制
    send: (data: string | Uint8Array) => {
      if (typeof data === "string") ws.send(data);
      else ws.sendBinary(data);
    },
    close: (code?: number, reason?: string) => ws.close(code, reason),
    get readyState() {
      return ws.readyState;
    },
    // 背压检测（SP-A7）：Bun ServerWebSocket 以 getBufferedAmount() 暴露待发送缓冲，
    // 不暴露则按 0 处理（永不拥塞，与历史行为一致）
    get bufferedAmount() {
      return typeof ws.getBufferedAmount === "function" ? ws.getBufferedAmount() : 0;
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
      if (isOverWsLimit(data)) {
        logError(`[ACP-WS] Message too large: ${estimateWsMessageBytes(data)} bytes`);
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
    parse(ws, message) {
      // 解析前显式检查（D12）：Elysia 的 createWSMessageParser 会在自定义 parse 之前
      // 对 `{` 开头字符串先做 JSON.parse，大 JSON 帧全量进内存后 10MB 上限形同虚设。
      // 此处先按真实字节数检查，超限 close(1009)（uWS 语义：消息过大）；未超原样返回，
      // 阻止 Elysia 默认 parse 破坏 NDJSON 多行帧（整帧 parse 必失败，单对象帧会被
      // parse 成 object 改变分发语义——NDJSON 逐行解析统一在 message 回调完成）。
      // 返回空串哨兵：close 后 Elysia 仍会分发本条消息，空串经 parseFileWsMessage
      // 解析出 0 条消息，超大帧不会进入业务处理。
      // 已知框架限制（记录在案）：单行 JSON 对象帧会被默认 parser 提前 parse 成
      // object，到不了本函数的字符串检查——该路径由 uWS 全局 maxPayloadLength
      // （src/index.ts，32MB）在解析前硬拦截（超限即断连，客户端侧表现为 1006），
      // file-ws 32MB 上限在 uWS 层真实生效；本钩子覆盖 NDJSON 多行帧与二进制帧。
      if (typeof message === "string" && checkWsMessageSize(message, getFileWsMaxPayloadBytes())) {
        logError(`[File-WS] Message too large: ${Buffer.byteLength(message)} bytes`);
        adaptWs(ws).close(1009, "message too large");
        return "";
      }
      return message;
    },
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
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
      const wsId = (ws.data as any).__fileWsId as string | undefined;
      if (!wsId) return;
      if (typeof data !== "string") {
        // 防御分支：parse 钩子已把文本帧归一为字符串，此处仅兜底二进制等异常帧
        handleFileWsMessage(adaptWs(ws), wsId, data as string | Record<string, unknown>);
        return;
      }
      // NDJSON 逐行解析（坏行记日志跳过，不中断整批），逐条分发；尺寸检查已在 parse 钩子完成
      for (const msg of parseFileWsMessage(data)) {
        handleFileWsMessage(adaptWs(ws), wsId, msg);
      }
    },
    close(ws, code, reason) {
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
      const wsId = (ws.data as any).__fileWsId as string | undefined;
      if (wsId) {
        log(formatFileWsCloseLog(wsId, code, reason));
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
      const url = new URL(ws.data.request.url);
      const instanceUid = url.searchParams.get("instanceUid");
      const rcsSessionId = url.searchParams.get("rcsSessionId");
      const acpSessionId = url.searchParams.get("acpSessionId") ?? undefined;
      if (!instanceUid || !rcsSessionId) {
        adaptWs(ws).close(4000, "invalid chat locator");
        return;
      }
      const expectedRcsSessionId = createDeterministicRcsSessionId(agentId, userId, instanceUid);
      if (rcsSessionId !== expectedRcsSessionId) {
        adaptWs(ws).close(4003, "unauthorized");
        return;
      }

      const env = await environmentRepo.getById(agentId);
      const authCtx = authResult.authContext;
      if (!env || !authCtx || env.organizationId !== authCtx.organizationId || env.userId !== userId) {
        adaptWs(ws).close(4003, "unauthorized");
        return;
      }

      log(`[YJS-WS] Opening: wsId=${yjsWsId} user=${userId} agentId=${agentId} instanceUid=${instanceUid}`);

      try {
        await getChatChannelController().gateway.handleOpen(adaptWs(ws), yjsWsId, userId, agentId, {
          instanceUid,
          rcsSessionId: expectedRcsSessionId,
          acpSessionId,
        });
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
      if (isOverWsLimit(data)) {
        logError(`[YJS-WS] Message too large: ${estimateWsMessageBytes(data)} bytes`);
        adaptWs(ws).close(1009, "message too large");
        return;
      }
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
      const yjsWsId = (ws.data as any).__yjsWsId as string | undefined;
      if (yjsWsId) {
        const payload =
          typeof data === "string"
            ? data
            : data instanceof Uint8Array
              ? data
              : ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : data instanceof ArrayBuffer
                  ? new Uint8Array(data)
                  : JSON.stringify(data);
        getChatChannelController().gateway.handleMessage(adaptWs(ws), yjsWsId, payload);
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
      if (isOverWsLimit(data)) {
        logError(`[External-Relay] Message too large: ${estimateWsMessageBytes(data)} bytes`);
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
