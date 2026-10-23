import type { ActorContext, IdentityDirectory } from "@fenix/platform-sdk";
import { AppError, NotFoundError, ValidationError, type WebErrSchema } from "@fenix/platform-sdk";
import type * as z from "zod/v4";
import type { AuthorizedMcpServer } from "../../../facades/mcp-server-facade";
import { getMcpServerModule } from "../../../runtime";
import { buildCommandProbeEnv } from "../../../services/command-probe-env";
import {
  type McpRemoteConfig,
  type McpServerConfig,
  parseMcpConfigValue,
  readMcpServerType,
  toServerInfo,
} from "../../../services/config/mcp-config";
import { inspectRemoteMcpServer } from "../../../services/mcp-inspector";

/**
 * `/web/config/mcp` 协议层。
 *
 * 只做协议接入：定位符等协议参数校验、把请求映射为应用调用、把结果映射为 `/web` 视图、把宿主错误类
 * 映射为稳定错误体。授权、可见性与资源解析全部在应用 Facade 内完成，本文件不判断组织、角色或
 * `visibility`；MCP 名称格式与配置结构的领域校验同样归 Facade（`assertCreatable` / `assertValidConfig`），
 * 本文件不重复，避免与 `/api/mcp` 这类并列入口再次分叉。
 *
 * 视图变化（决策 D2）：列表与详情不再返回旧栈的 `resourceAccess`，改为返回资源归属 `scope` 与
 * 当前主体有效动作 `access.actions`；`organizationName` 是展示字段，由身份目录批量解析。
 *
 * 导出的是**路由工厂**而非构造好的实例：`sessionAuth` 宏与 `store.actor` 由宿主守卫写入，
 * Elysia 的 `macro` / `state` 又是实例作用域的，父实例无法向已构造的子实例回填，因此守卫必须由
 * 宿主注入（`McpRouteDependencies`）；包内不复制认证策略，测试注入替身（`src/__tests__/guard-stubs`）。
 */

function splitMcpConfigInput(input: unknown): { config: McpServerConfig; publicReadable?: boolean } {
  if (typeof input !== "object" || input === null) {
    return { config: input as McpServerConfig };
  }
  const raw = input as Record<string, unknown>;
  const publicReadable = typeof raw.publicReadable === "boolean" ? raw.publicReadable : undefined;
  const { publicReadable: _ignored, ...config } = raw;
  return {
    config: config as unknown as McpServerConfig,
    ...(publicReadable === undefined ? {} : { publicReadable }),
  };
}

/** 批量解析归属组织名称；名录缺失时字段整体省略，不补空串。 */
async function resolveOrganizationNames(
  identity: IdentityDirectory,
  organizationIds: readonly (string | undefined)[],
): Promise<ReadonlyMap<string, string>> {
  const ids = [...new Set(organizationIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return new Map();
  return identity.listOrganizationNames(ids);
}

/** 列表项视图：展示投影 + 归属范围 + 有效动作。 */
function toWebServerItem(server: AuthorizedMcpServer, toolsCount: number, organizationName: string | undefined) {
  return {
    id: server.id,
    ...toServerInfo(server.name, server),
    toolsCount,
    scope: server.scope,
    access: server.access,
    ...(organizationName === undefined ? {} : { organizationName }),
  };
}

/** 详情视图：完整配置 + 归属范围 + 有效动作。 */
function toWebServerDetail(server: AuthorizedMcpServer, organizationName: string | undefined) {
  return {
    id: server.id,
    name: server.name,
    config: server.config,
    scope: server.scope,
    access: server.access,
    ...(organizationName === undefined ? {} : { organizationName }),
  };
}

async function handleList(actor: ActorContext): Promise<WebHandlerResult> {
  const { facade, identity } = getMcpServerModule();
  const { items } = await facade.list(actor);
  const organizationNames = await resolveOrganizationNames(
    identity,
    items.map((item) => item.scope.organizationId),
  );
  return {
    success: true,
    data: {
      servers: items.map((item) =>
        toWebServerItem(item, item.toolsCount, organizationNames.get(item.scope.organizationId ?? "")),
      ),
    },
  };
}

async function handleGet(actor: ActorContext, resourceId: string): Promise<WebHandlerResult> {
  const { facade, identity } = getMcpServerModule();
  const server = await facade.getById(actor, resourceId);
  if (!server) throw new NotFoundError(`MCP server '${resourceId}' not found`);
  const organizationNames = await resolveOrganizationNames(identity, [server.scope.organizationId]);
  return {
    success: true,
    data: toWebServerDetail(server, organizationNames.get(server.scope.organizationId ?? "")),
  };
}

async function handleCreate(
  actor: ActorContext,
  name: string,
  configInput: unknown,
  bodyPublicReadable?: boolean,
): Promise<WebHandlerResult> {
  const { config, publicReadable: configPublicReadable } = splitMcpConfigInput(configInput);
  const publicReadable = bodyPublicReadable ?? configPublicReadable;
  const id = await getMcpServerModule().facade.create(actor, {
    name,
    type: readMcpServerType(config),
    config,
    ...(publicReadable === undefined ? {} : { publicReadable }),
  });
  return { success: true, data: { id, name } };
}

async function handleUpdate(
  actor: ActorContext,
  resourceId: string,
  configInput: unknown,
  bodyPublicReadable?: boolean,
): Promise<WebHandlerResult> {
  const { config, publicReadable: configPublicReadable } = splitMcpConfigInput(configInput);
  const publicReadable = bodyPublicReadable ?? configPublicReadable;
  const name = await getMcpServerModule().facade.updateById(actor, resourceId, config, {
    ...(publicReadable === undefined ? {} : { publicReadable }),
  });
  return { success: true, data: { id: resourceId, name } };
}

async function handleDelete(actor: ActorContext, resourceId: string): Promise<WebHandlerResult> {
  // 删除与 tool 缓存清理在同一个事务里完成，不再做 best-effort 补偿清理。
  await getMcpServerModule().facade.removeById(actor, resourceId);
  return { success: true, data: null };
}

async function handleEnable(actor: ActorContext, resourceId: string): Promise<WebHandlerResult> {
  const { facade } = getMcpServerModule();
  const server = await facade.getWritableById(actor, resourceId);
  if (!("type" in (parseMcpConfigValue(server.config) ?? {}))) {
    throw new ValidationError(`Cannot enable '${resourceId}': original config lost, please recreate`);
  }
  const name = await facade.setEnabledById(actor, resourceId, true);
  return { success: true, data: { name, enabled: true } };
}

async function handleDisable(actor: ActorContext, resourceId: string): Promise<WebHandlerResult> {
  const name = await getMcpServerModule().facade.setEnabledById(actor, resourceId, false);
  return { success: true, data: { name, enabled: false } };
}

/** 组装远程 MCP 探测所需的请求头；OAuth 只支持以 clientId 作为 Bearer（与迁移前一致）。 */
function buildRemoteHeaders(remote: McpRemoteConfig): Record<string, string> {
  const headers: Record<string, string> = { ...remote.headers };
  if (remote.oauth && typeof remote.oauth === "object" && remote.oauth.clientId) {
    headers.Authorization = `Bearer ${remote.oauth.clientId}`;
  }
  return headers;
}

async function handleTest(actor: ActorContext, resourceId: string): Promise<WebHandlerResult> {
  const server = await getMcpServerModule().facade.getWritableById(actor, resourceId);
  const name = server.name;
  const config = parseMcpConfigValue(server.config) ?? {};

  // remote
  if (config.type === "remote") {
    const remote = config as unknown as McpRemoteConfig;
    const result = await inspectRemoteMcpServer(remote.url, buildRemoteHeaders(remote), remote.timeout ?? 10000);
    if (result.reachable && result.protocol) {
      return {
        success: true,
        data: {
          name,
          reachable: true,
          protocol: true,
          serverName: result.serverName ?? null,
          serverVersion: result.serverVersion ?? null,
          toolsCount: result.tools.length,
          transport: result.transport,
        },
      };
    }
    if (result.reachable) {
      return {
        success: true,
        data: { name, reachable: true, protocol: false, message: result.message ?? "非 MCP 协议" },
      };
    }
    return { success: true, data: { name, reachable: false, protocol: false, message: result.message ?? "连接失败" } };
  }

  // local
  if (config.type === "local") {
    const cmd = (config.command as string[])[0];
    try {
      // 探测子进程按用途白名单构造环境（§5.4）：命令名来自管理端配置，不得继承宿主环境
      const proc = Bun.spawn(["which", cmd], {
        env: buildCommandProbeEnv(),
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
      if (proc.exitCode === 0) {
        return { success: true, data: { name, reachable: true, protocol: false, message: `命令 "${cmd}" 可用` } };
      }
      return { success: true, data: { name, reachable: false, protocol: false, message: `命令 "${cmd}" 未找到` } };
    } catch {
      return { success: true, data: { name, reachable: false, protocol: false, message: `命令 "${cmd}" 检查失败` } };
    }
  }

  throw new ValidationError(`Cannot test '${resourceId}': unsupported config type`);
}

async function handleTestUrl(
  url: string,
  headers?: Record<string, string>,
  timeout?: number,
): Promise<WebHandlerResult> {
  if (!url || typeof url !== "string") throw new ValidationError("URL is required");
  const result = await inspectRemoteMcpServer(url, headers, timeout ?? 10000);
  if (result.reachable && result.protocol) {
    return {
      success: true,
      data: {
        reachable: true,
        protocol: true,
        serverName: result.serverName ?? null,
        serverVersion: result.serverVersion ?? null,
        toolsCount: result.tools.length,
        transport: result.transport,
      },
    };
  }
  if (result.reachable) {
    return { success: true, data: { reachable: true, protocol: false, message: result.message ?? "非 MCP 协议" } };
  }
  return { success: true, data: { reachable: false, protocol: false, message: result.message ?? "连接失败" } };
}

async function handleInspect(actor: ActorContext, resourceId: string): Promise<WebHandlerResult> {
  const { facade } = getMcpServerModule();
  const server = await facade.getWritableById(actor, resourceId);
  const config = parseMcpConfigValue(server.config) ?? {};
  if (config.type !== "remote") {
    throw new ValidationError("Inspect only supports remote MCP servers");
  }

  const remote = config as unknown as McpRemoteConfig;
  const result = await inspectRemoteMcpServer(remote.url, buildRemoteHeaders(remote), remote.timeout ?? 10000);
  if (!result.reachable || !result.protocol) {
    throw new ValidationError(result.message ?? "无法连接到 MCP 服务器");
  }

  const name = await facade.saveInspectedToolsById(actor, resourceId, result.tools);

  return {
    success: true,
    data: {
      name,
      serverInfo: { name: result.serverName, version: result.serverVersion },
      tools: result.tools,
      transport: result.transport,
      stored: true,
    },
  };
}

async function handleListTools(actor: ActorContext, resourceId: string): Promise<WebHandlerResult> {
  const { name, tools } = await getMcpServerModule().facade.listToolsById(actor, resourceId);
  return {
    success: true,
    data: {
      name,
      tools: tools.map((tool) => ({
        id: tool.id,
        toolName: tool.toolName,
        description: tool.description,
        inputSchema: tool.inputSchema,
        inspectedAt: tool.inspectedAt.getTime(),
      })),
    },
  };
}

// --- Error helpers ---

type WebErrorBody = z.infer<typeof WebErrSchema>;

/**
 * `/web` handler 的返回值形状：成功体或错误体。
 *
 * 显式声明而不是 `Promise<unknown>`：Elysia 的 `InlineHandler` 只接受它能渲染的联合类型，
 * 让 handler 与 `runWebHandler` 都收敛到这个类型，编译期即可发现"返回了协议未声明的形状"。
 *
 * 刻意不含 `Response`：`status(...)` 返回的是 Elysia 的 `ElysiaCustomStatusResponse`，由
 * `InlineHandler` 自己的联合类型覆盖；把 `Response` 写进来反而会让整个返回值联合无法匹配
 * Elysia 的任何一支（联合目标要求源类型的**每个**成员都能落入同一支）。
 */
type WebHandlerResult = { success: true; data: Record<string, unknown> | null } | WebErrorBody;

/** 错误码到 `/web` 声明过的 HTTP 状态码的映射；未列出的错误一律 400，避免返回未声明状态码。 */
function mapConfigErrorStatus(code: string | undefined): number {
  switch (code) {
    case "VALIDATION_ERROR":
      return 400;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "ALREADY_EXISTS":
      return 409;
    default:
      return 400;
  }
}

function buildWebErrorBody(code: string, message: string): WebErrorBody {
  return { success: false, error: { code, message } };
}

/** 执行 handler：取主体 → 执行 → 把宿主错误类映射为 `/web` 错误体。未知错误保持上抛（500）。 */
async function runWebHandler(
  // biome-ignore lint/suspicious/noExplicitAny: Elysia status 函数在自定义 response schema 下类型不稳定
  status: any,
  // biome-ignore lint/suspicious/noExplicitAny: Elysia store 类型未完全可表达
  store: any,
  handler: (actor: ActorContext) => Promise<WebHandlerResult>,
): Promise<WebHandlerResult> {
  const actor = store.actor as ActorContext | null;
  if (!actor) {
    // 已认证但没有组织上下文（例如未绑定组织的 API Key）不能操作组织资源。
    return status(401, buildWebErrorBody("UNAUTHORIZED", "请求缺少组织上下文"));
  }
  try {
    return await handler(actor);
  } catch (error_) {
    if (error_ instanceof AppError) {
      return status(mapConfigErrorStatus(error_.code), buildWebErrorBody(error_.code, error_.message));
    }
    throw error_;
  }
}

export {
  handleCreate,
  handleDelete,
  handleDisable,
  handleEnable,
  handleGet,
  handleInspect,
  handleList,
  handleListTools,
  handleTest,
  handleTestUrl,
  handleUpdate,
  runWebHandler,
};
