import { createLogger } from "@fenix/logger";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import Elysia from "elysia";
import type { CloudDriveModuleConfig } from "../../config";
import type { CloudDriveFacade } from "../../facades/cloud-drive-facade";
import {
  buildCloudDriveDiscoverResult,
  CLOUD_DRIVE_MCP_PROTOCOL_VERSION,
  CLOUD_DRIVE_MCP_SDK_PROTOCOL_VERSION,
} from "../../mcp/protocol";
import { createCloudDriveMcpServer } from "../../mcp/server";
import { verifyCloudDriveMcpToken } from "../../mcp/token";

/**
 * `/mcp/cloud-drive`：平台托管的 stateless MCP 入口（与 `/mcp/knowledge` 同模式）。
 *
 * 与知识库入口的三处差异都是云盘特有的：
 * 1. 鉴权材料是 Fenix 签发的 HMAC token，不是 Environment Secret；因此本入口不读 `store`，也不使用
 *    `sessionAuth` 宏——Agent 进程没有登录会话。
 * 2. token 的 `scope` 决定工具集：只读 token 的 `tools/list` 里不存在写工具。
 * 3. 未配置密钥或未配置 CloudDrive 时直接 503，而不是让 Agent 拿到一组永远失败的只读工具。
 *
 * 日志只记 `tool` / `uid` / `orgId` / `outcome` / `durationMs` / `upstreamStatus`：token、master key、
 * 文件正文、下载票据都不进入日志。
 */

/** 请求体上限；工具参数最大 1 MiB 文本 + JSON 包装，2 MiB 足够阻断放大型请求。 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const logger = createLogger("cloud-drive");

export interface CloudDriveMcpRouteDependencies {
  readonly facade: CloudDriveFacade;
  /** 惰性读取模块配置：应用基础设施未完成初始化时装配阶段不能读。 */
  readonly getConfig: () => CloudDriveModuleConfig;
  /** 测试注入的当前时间（epoch 秒），与 token 校验共用。 */
  readonly nowSeconds?: () => number;
}

function getBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

/** 未配置（密钥缺失或 CloudDrive 未启用）统一 503：这是部署问题，不是调用方凭据问题。 */
function isConfigured(config: CloudDriveModuleConfig): boolean {
  return Boolean(config.mcpTokenSecret?.trim() && config.baseUrl?.trim() && config.masterKey?.trim());
}

function isRpcId(value: unknown): value is string | number | null {
  return value === null || typeof value === "string" || typeof value === "number";
}

/**
 * 识别单条 JSON-RPC 的 `server/discover`。
 *
 * 用 `request.clone()` 读取：原始 Request 的 body 还要交给 SDK transport，不能被消费。只解析信封，
 * 不读取也不记录 `_meta` 里的 clientInfo/capabilities，避免把客户端元数据写进日志。
 */
async function readDiscoverRequest(request: Request): Promise<{ found: boolean; id?: unknown }> {
  if (request.method !== "POST") return { found: false };
  let text: string;
  try {
    text = await request.clone().text();
  } catch {
    return { found: false };
  }
  if (!text) return { found: false };
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { found: false };
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return { found: false };
  const envelope = payload as Record<string, unknown>;
  if (envelope.jsonrpc !== "2.0" || envelope.method !== "server/discover") return { found: false };
  return { found: true, id: envelope.id };
}

/**
 * discover 成功后客户端会继续携带 `MCP-Protocol-Version: 2026-07-28`，而 SDK 只认到 `2025-11-25`。
 * 网关声明的是「2026-07-28 的 tools 子集」，tools/list 与 tools/call 的载荷在两者间一致，因此只归一请求头。
 */
function withSdkProtocolHeader(request: Request): Request {
  if (request.headers.get("mcp-protocol-version") !== CLOUD_DRIVE_MCP_PROTOCOL_VERSION) return request;
  const headers = new Headers(request.headers);
  headers.set("mcp-protocol-version", CLOUD_DRIVE_MCP_SDK_PROTOCOL_VERSION);
  return new Request(request, { headers });
}

export function createCloudDriveMcpRoutes(dependencies: CloudDriveMcpRouteDependencies) {
  return new Elysia({ name: "mcp-cloud-drive" })
    .onError(({ code, error, status }) => {
      if (code === "PARSE" || code === "VALIDATION") {
        return status(400, { error: { code: "INVALID_ARGUMENT", message: "请求体不合法" } });
      }
      if (code === "NOT_FOUND") return;
      logger.error("CloudDrive MCP 请求失败", {
        errorName: error instanceof Error ? error.name : "unknown",
      });
      return status(500, { error: { code: "INTERNAL_ERROR", message: "MCP 服务内部错误" } });
    })
    .all(
      "/mcp/cloud-drive",
      async ({ request, status }) => {
        const config = dependencies.getConfig();
        if (!isConfigured(config)) {
          return status(503, { error: { code: "NOT_CONFIGURED", message: "个人云盘 MCP 未配置" } });
        }

        // 鉴权先于协议解析：缺失或非法 token 一律 401，不因请求体格式泄漏任何分支。
        const token = getBearerToken(request.headers.get("Authorization") ?? undefined);
        if (!token) return status(401, { error: { code: "UNAUTHORIZED", message: "缺少 Bearer token" } });

        const claims = await verifyCloudDriveMcpToken(token, config.mcpTokenSecret, dependencies.nowSeconds?.());
        if (!claims) return status(401, { error: { code: "UNAUTHORIZED", message: "token 无效或已过期" } });

        const declared = request.headers.get("content-length");
        if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
          return status(413, { error: { code: "PAYLOAD_TOO_LARGE", message: "请求体过大" } });
        }

        // peri/rmcp 的首个请求是 server/discover；SDK 不实现该方法。这里只接管这一条，其余方法仍走
        // SDK，避免复制工具协议实现。
        const discover = await readDiscoverRequest(request);
        if (discover.found) {
          if (discover.id === undefined) return new Response(null, { status: 202 });
          if (!isRpcId(discover.id)) {
            return Response.json(
              { jsonrpc: "2.0", id: null, error: { code: -32600, message: "server/discover 需要合法的 id" } },
              { status: 400 },
            );
          }
          return Response.json({ jsonrpc: "2.0", id: discover.id, result: buildCloudDriveDiscoverResult() });
        }

        const server = createCloudDriveMcpServer({
          claims,
          facade: dependencies.facade,
          readTimeoutMs: config.mcpTimeoutMs,
          onToolCall: (event) => {
            logger.info("CloudDrive MCP 工具调用", {
              tool: event.tool,
              scope: event.scope,
              uid: claims.userId,
              orgId: claims.organizationId,
              outcome: event.outcome,
              durationMs: event.durationMs,
              ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
              ...(event.upstreamStatus === undefined ? {} : { upstreamStatus: event.upstreamStatus }),
              ...(event.upstreamCode === undefined ? {} : { upstreamCode: event.upstreamCode }),
            });
          },
        });

        const transport = new WebStandardStreamableHTTPServerTransport({
          enableJsonResponse: true,
          sessionIdGenerator: undefined,
        });
        await server.connect(transport);
        return transport.handleRequest(withSdkProtocolHeader(request));
      },
      {
        detail: {
          hide: true,
          tags: ["CloudDrive"],
          summary: "个人云盘 MCP 入口",
          description:
            "MCP Streamable HTTP stateless 入口。调用方需通过 `Authorization: Bearer <CLOUDDRIVE_MCP_TOKEN>` 鉴权；" +
            "token 由 Fenix 服务端签发，主体与 scope 从 token 派生。默认提供只读工具，" +
            "scope=write 时额外提供 mkdir / write_text / move / rename。该接口为 MCP 协议入口，不按普通 REST 响应建模，因此在公开文档中隐藏。",
        },
      },
    );
}
