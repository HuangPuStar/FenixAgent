import { error as logError } from "@fenix/logger";
import Elysia from "elysia";
import * as z from "zod/v4";
import { getChannelModule } from "../../runtime";
import type { ImMcpService } from "../../services/im-mcp/service";
import {
  IM_MCP_LEGACY_PROTOCOL_VERSION,
  IM_MCP_SERVER_CAPABILITIES,
  IM_MCP_SERVER_NAME,
  IM_MCP_SERVER_VERSION,
  ImMcpError,
  type ImMcpSession,
} from "../../services/im-mcp/types";
import { IM_INBOX_RESOURCE_URI } from "../../services/langbot/delivery-dispatcher";

/**
 * `/mcp/im`：IM 通道的 stateless MCP 入口（规格 §4.4 / §4.6 / §9.7）。
 *
 * 协议边界只有三件事：Bearer 连接 token 决定 conversation、JSON-RPC 方法分发、订阅流用 SSE 承载。
 * 工具与资源不接受 `chat_id`，跨会话访问没有第二条路径。
 *
 * stateless 的含义：没有 `Mcp-Session-Id`、每个 POST 独立认证；订阅流只在当前 HTTP 连接生命周期内存在，
 * 断连即注销，重启不重放。`initialize` 仅为 rmcp Auto 策略的回退保留，只协商版本与能力，不建立会话。
 */

const MAX_BODY_BYTES = 256 * 1024;

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

const JsonRpcRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

// rmcp 会在工具与资源请求上附带 `_meta`、`inputResponses`、`requestState`；非 strict 才能 strip 后放行。
const ToolCallParamsSchema = z.object({
  name: z.string().min(1),
  arguments: z.unknown().optional(),
});

const ResourceReadParamsSchema = z.object({
  uri: z.string().min(1),
  cursor: z.string().min(1).optional(),
});

const SkillGetParamsSchema = z.object({ name: z.string().min(1) });

const InitializeParamsSchema = z.object({ protocolVersion: z.string().min(1).optional() });

/** 订阅请求只认 rmcp 的 `notifications.resourceSubscriptions`；其余字段为客户端声明，不参与订阅建立。 */
const SubscriptionListenParamsSchema = z.object({
  _meta: z.unknown().optional(),
  notifications: z
    .object({
      resourceSubscriptions: z.array(z.string().min(1)).optional(),
      resourcesListChanged: z.boolean().optional(),
      toolsListChanged: z.boolean().optional(),
      promptsListChanged: z.boolean().optional(),
    })
    .optional(),
});

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return;
  }
}

/** 只回字段路径与错误码，不回显调用方传值：其中的正文或伪造 ID 不应进入错误响应。 */
function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) {
    const paths = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "<root>"))].join(", ");
    throw new ImMcpError(-32602, `请求参数不合法：${paths}`);
  }
  return parsed.data;
}

async function dispatch(service: ImMcpService, session: ImMcpSession, request: JsonRpcRequest): Promise<unknown> {
  switch (request.method) {
    case "server/discover":
      return service.discover();
    case "initialize": {
      // legacy 回退：沿用客户端的协议版本，能力与 discover 完全一致。
      const params = parseParams(InitializeParamsSchema, request.params);
      return {
        protocolVersion: params.protocolVersion ?? IM_MCP_LEGACY_PROTOCOL_VERSION,
        capabilities: IM_MCP_SERVER_CAPABILITIES,
        serverInfo: { name: IM_MCP_SERVER_NAME, version: IM_MCP_SERVER_VERSION },
      };
    }
    case "tools/list":
      return { tools: service.listTools() };
    case "tools/call": {
      const params = parseParams(ToolCallParamsSchema, request.params);
      return service.callTool({ session, name: params.name, arguments: params.arguments });
    }
    case "resources/read": {
      const params = parseParams(ResourceReadParamsSchema, request.params);
      return service.readResource({
        session,
        uri: params.uri,
        ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
      });
    }
    case "skills/list":
      return { skills: service.listSkills() };
    case "skills/get": {
      const params = parseParams(SkillGetParamsSchema, request.params);
      const skill = service.getSkill(params.name);
      if (!skill) throw new ImMcpError(-32602, "未知 Skill");
      return skill;
    }
    default:
      throw new ImMcpError(-32601, "未知方法");
  }
}

/** 订阅读取只接受资源订阅；资源 URI 固定为 im://inbox（规格 §4.6）。 */
function assertInboxSubscription(params: unknown): void {
  const parsed = parseParams(SubscriptionListenParamsSchema, params);
  const requested = parsed.notifications?.resourceSubscriptions ?? [];
  if (requested.length !== 1 || requested[0] !== IM_INBOX_RESOURCE_URI) {
    throw new ImMcpError(-32602, "只支持订阅 im://inbox");
  }
}

/**
 * 订阅流：第一个 SSE 事件必须是 `notifications/subscriptions/acknowledged`，之后才能推资源更新。
 *
 * rmcp 3.5.1 的 `Peer::listen` 把首条订阅通知当作 ack 校验：先收到 result 或资源更新都会判定订阅失败，
 * 最终 result 只属于优雅收尾（本入口只有断连，不发）。通知只带 uri 与 `_meta` 里的 subscriptionId，
 * 不带正文、发送者或 token，客户端必须自己 `resources/read`。
 * 流关闭（客户端断连或服务端取消）时立即从派发器注销，避免向已断开的连接写数据。
 */
function createSubscriptionResponse(input: {
  service: ImMcpService;
  session: ImMcpSession;
  /** rmcp 以 listen 请求的 JSON-RPC id 作为订阅标识，必须保留原值与类型。 */
  subscriptionId: string | number;
  signal: AbortSignal;
}): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    unsubscribe = null;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (message: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
        } catch {
          cleanup();
        }
      };

      input.signal.addEventListener(
        "abort",
        () => {
          cleanup();
          try {
            controller.close();
          } catch {
            // 已经因客户端取消而关闭；重复关闭没有副作用。
          }
        },
        { once: true },
      );

      send({
        jsonrpc: "2.0",
        method: "notifications/subscriptions/acknowledged",
        params: {
          // 只接受 im://inbox，ack 回的就是这个已接受的过滤器。
          notifications: { resourceSubscriptions: [IM_INBOX_RESOURCE_URI] },
          _meta: { "io.modelcontextprotocol/subscriptionId": input.subscriptionId },
        },
      });

      unsubscribe = input.service.subscribe({
        session: input.session,
        sink: {
          notifyResourceUpdated: ({ uri }) => {
            send({
              jsonrpc: "2.0",
              method: "notifications/resources/updated",
              params: { uri, _meta: { "io.modelcontextprotocol/subscriptionId": input.subscriptionId } },
            });
          },
        },
      });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

export function createImMcpRoutes() {
  return new Elysia({ name: "mcp-im" })
    .onError(({ code, error, status }) => {
      if (code === "PARSE" || code === "VALIDATION") {
        return status(400, rpcError(null, -32700, "无法解析 JSON-RPC 请求"));
      }
      if (code === "NOT_FOUND") return;
      logError("IM MCP 请求失败", error instanceof Error ? error : undefined);
      return status(500, rpcError(null, -32603, "服务内部错误"));
    })
    .post(
      "/mcp/im",
      async ({ body, request, status }) => {
        const service = getChannelModule().dataPlane?.mcp;
        if (!service) throw new Error("Channel MCP 入口未装配：数据面缺少 mcp 服务");

        // 鉴权先于协议解析：缺失或非法 token 一律 401，不因请求体格式泄漏任何分支。
        const session = await service.authenticate(request.headers.get("authorization"));
        if (!session) return status(401, rpcError(null, -32001, "未授权"));

        const declared = request.headers.get("content-length");
        if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
          return status(413, rpcError(null, -32600, "请求体过大"));
        }

        const payload = parseBody(body);
        if (payload === undefined) return status(400, rpcError(null, -32700, "无法解析 JSON-RPC 请求"));
        if (Array.isArray(payload)) return status(400, rpcError(null, -32600, "不支持批量请求"));

        const parsed = JsonRpcRequestSchema.safeParse(payload);
        if (!parsed.success) return status(400, rpcError(null, -32600, "不是合法的 JSON-RPC 请求"));
        const rpc = parsed.data;

        // 通知没有 id，不产生响应；同时避免把 notifications/* 当未知方法报错。
        if (rpc.id === undefined) return new Response(null, { status: 202 });

        try {
          if (rpc.method === "subscriptions/listen") {
            if (rpc.id === null) throw new ImMcpError(-32600, "订阅请求缺少 id");
            assertInboxSubscription(rpc.params);
            return createSubscriptionResponse({
              service,
              session,
              subscriptionId: rpc.id,
              signal: request.signal,
            });
          }

          return rpcResult(rpc.id, await dispatch(service, session, rpc));
        } catch (error) {
          if (error instanceof ImMcpError) return rpcError(rpc.id, error.code, error.message);
          logError("IM MCP 方法处理失败", error instanceof Error ? error : undefined);
          return status(500, rpcError(rpc.id, -32603, "服务内部错误"));
        }
      },
      {
        detail: {
          hide: true,
          tags: ["Channel"],
          summary: "IM MCP 入口",
          description:
            "MCP 2026-07-28 stateless 入口。Authorization: Bearer <IM_TOKEN> 决定 conversation；提供 server/discover、tools、resources、skills 与 subscriptions/listen，并保留 initialize 回退。",
        },
      },
    );
}
