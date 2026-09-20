import type { ActorContext, IdentityDirectory } from "@fenix/platform-sdk";
import { AppError, NotFoundError, ValidationError, WebErrSchema, WebOkSchema } from "@fenix/platform-sdk";
import { authGuardPlugin } from "@server/plugins/auth";
import Elysia from "elysia";
import * as z from "zod/v4";
import type { AuthorizedMcpServer } from "../../../facades/mcp-server-facade";
import { getMcpServerModule } from "../../../runtime";
import {
  isValidMcpName,
  type McpRemoteConfig,
  type McpServerConfig,
  parseMcpConfigValue,
  readMcpServerType,
  toServerInfo,
  validateMcpConfig,
} from "../../../services/config/mcp-config";
import { inspectRemoteMcpServer } from "../../../services/mcp-inspector";

/**
 * `/web/config/mcp` 协议层。
 *
 * 只做协议接入：参数与配置结构校验、把请求映射为应用调用、把结果映射为 `/web` 视图、把宿主错误类
 * 映射为稳定错误体。授权、可见性与资源解析全部在应用 Facade 内完成，本文件不判断组织、角色或
 * `visibility`。
 *
 * 视图变化（决策 D2）：列表与详情不再返回旧栈的 `resourceAccess`，改为返回资源归属 `scope` 与
 * 当前主体有效动作 `access.actions`；`organizationName` 是展示字段，由身份目录批量解析。
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

/** 从 query 中取出 `name`；它同时承载服务器名称与跨组织资源键（`org_id/server-uuid`）。 */
function extractName(query: unknown): string | undefined {
  if (typeof query !== "object" || query === null) return;
  const name = (query as Record<string, unknown>).name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
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

async function handleGet(actor: ActorContext, nameOrKey: string): Promise<WebHandlerResult> {
  const { facade, identity } = getMcpServerModule();
  const server = await facade.get(actor, nameOrKey);
  if (!server) throw new NotFoundError(`MCP server '${nameOrKey}' not found`);
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
  if (!isValidMcpName(name)) {
    throw new ValidationError("Invalid server name: must be 1-64 lowercase alphanumeric chars with single hyphens");
  }
  const validation = validateMcpConfig(config);
  if (validation) throw new ValidationError(validation);

  await getMcpServerModule().facade.create(actor, {
    name,
    type: readMcpServerType(config),
    config,
    ...(publicReadable === undefined ? {} : { publicReadable }),
  });
  return { success: true, data: { name } };
}

async function handleUpdate(
  actor: ActorContext,
  nameOrKey: string,
  configInput: unknown,
  bodyPublicReadable?: boolean,
): Promise<WebHandlerResult> {
  const { config, publicReadable: configPublicReadable } = splitMcpConfigInput(configInput);
  const publicReadable = bodyPublicReadable ?? configPublicReadable;
  const validation = validateMcpConfig(config);
  if (validation) throw new ValidationError(validation);

  await getMcpServerModule().facade.update(actor, nameOrKey, config, {
    ...(publicReadable === undefined ? {} : { publicReadable }),
  });
  return { success: true, data: { name: nameOrKey } };
}

async function handleDelete(actor: ActorContext, nameOrKey: string): Promise<WebHandlerResult> {
  // 删除与 tool 缓存清理在同一个事务里完成，不再做 best-effort 补偿清理。
  await getMcpServerModule().facade.remove(actor, nameOrKey);
  return { success: true, data: null };
}

async function handleEnable(actor: ActorContext, nameOrKey: string): Promise<WebHandlerResult> {
  const { facade } = getMcpServerModule();
  const server = await facade.getWritable(actor, nameOrKey);
  if (!("type" in (parseMcpConfigValue(server.config) ?? {}))) {
    throw new ValidationError(`Cannot enable '${nameOrKey}': original config lost, please recreate`);
  }
  const name = await facade.setEnabled(actor, nameOrKey, true);
  return { success: true, data: { name, enabled: true } };
}

async function handleDisable(actor: ActorContext, nameOrKey: string): Promise<WebHandlerResult> {
  const name = await getMcpServerModule().facade.setEnabled(actor, nameOrKey, false);
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

async function handleTest(actor: ActorContext, nameOrKey: string): Promise<WebHandlerResult> {
  const server = await getMcpServerModule().facade.getWritable(actor, nameOrKey);
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
      const proc = Bun.spawn(["which", cmd], { stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      if (proc.exitCode === 0) {
        return { success: true, data: { name, reachable: true, protocol: false, message: `命令 "${cmd}" 可用` } };
      }
      return { success: true, data: { name, reachable: false, protocol: false, message: `命令 "${cmd}" 未找到` } };
    } catch {
      return { success: true, data: { name, reachable: false, protocol: false, message: `命令 "${cmd}" 检查失败` } };
    }
  }

  throw new ValidationError(`Cannot test '${nameOrKey}': unsupported config type`);
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

async function handleInspect(actor: ActorContext, nameOrKey: string): Promise<WebHandlerResult> {
  const { facade } = getMcpServerModule();
  const server = await facade.getWritable(actor, nameOrKey);
  const config = parseMcpConfigValue(server.config) ?? {};
  if (config.type !== "remote") {
    throw new ValidationError("Inspect only supports remote MCP servers");
  }

  const remote = config as unknown as McpRemoteConfig;
  const result = await inspectRemoteMcpServer(remote.url, buildRemoteHeaders(remote), remote.timeout ?? 10000);
  if (!result.reachable || !result.protocol) {
    throw new ValidationError(result.message ?? "无法连接到 MCP 服务器");
  }

  const name = await facade.saveInspectedTools(actor, nameOrKey, result.tools);

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

async function handleListTools(actor: ActorContext, nameOrKey: string): Promise<WebHandlerResult> {
  const { name, tools } = await getMcpServerModule().facade.listTools(actor, nameOrKey);
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

/** 将 handler 执行中抛出的 AppError 映射为标准错误响应（无主体要求的端点使用）。 */
function resolveThrownError(error_: unknown): { code: number; body: WebErrorBody } | null {
  if (error_ instanceof AppError) {
    return {
      code: mapConfigErrorStatus(error_.code),
      body: buildWebErrorBody(error_.code, error_.message),
    };
  }
  return null;
}

// ── Name query schema (shared across routes that accept ?name=xxx) ──
const nameQuerySchema = z.object({
  name: z.string().optional().describe("MCP 服务器名称或共享资源键（org_id/server-uuid）；不传则为列表模式。"),
});

// 宽松对象响应 schema，兼容各 handler 的不同 data 结构
const looseOkSchema = WebOkSchema(z.union([z.looseObject({}), z.null()]));

// ── 路由注册 ──

const app = new Elysia({ name: "web-config-mcp" }).use(authGuardPlugin);

// GET /web/config/mcp — list all MCP servers (or get single when ?name=xxx)
app.get(
  "/config/mcp",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia query type is loose at runtime
  ({ store, query, status }: any) => {
    const name = extractName(query);
    return runWebHandler(status, store, (actor) => (name ? handleGet(actor, name) : handleList(actor)));
  },
  {
    sessionAuth: true,
    query: nameQuerySchema,
    response: {
      200: looseOkSchema,
      400: WebErrSchema,
      401: WebErrSchema,
      403: WebErrSchema,
      404: WebErrSchema,
    },
    detail: {
      tags: ["McpConfig"],
      summary: "获取 MCP 服务器列表或详情",
      description:
        "不带 `name` 查询参数时返回当前主体可见的 MCP 服务器列表（含归属 `scope` 与有效动作 `access.actions`）；带 `name` 时返回指定服务器的完整配置详情（名称支持 resource key 格式 org_id/server-uuid）。",
      parameters: [
        {
          name: "name",
          in: "query",
          required: false,
          description: "MCP 服务器名称或共享资源键；传入后接口切换为详情查询模式。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

// POST /web/config/mcp — create MCP server
app.post(
  "/config/mcp",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia body type is loose at runtime
  ({ store, body, status }: any) => {
    const name = typeof body?.name === "string" ? body.name : "";
    const configInput = body?.config ?? body;
    const publicReadable = typeof body?.publicReadable === "boolean" ? body.publicReadable : undefined;
    return runWebHandler(status, store, (actor) => handleCreate(actor, name, configInput, publicReadable));
  },
  {
    sessionAuth: true,
    response: {
      200: looseOkSchema,
      400: WebErrSchema,
      401: WebErrSchema,
      403: WebErrSchema,
      409: WebErrSchema,
    },
    detail: {
      tags: ["McpConfig"],
      summary: "创建 MCP 服务器",
      description:
        "创建新的 MCP 服务器配置。请求体需要提供 `name` 和 `config`，并支持可选 `publicReadable`。同组织内同名服务器返回 409；创建组织资源的动作由当前主体的角色决定。",
    },
  },
);

// PUT /web/config/mcp?name=xxx — update MCP server
app.put(
  "/config/mcp",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia body type is loose at runtime
  ({ store, query, body, status }: any) => {
    const name = extractName(query);
    if (!name) {
      return status(400, buildWebErrorBody("VALIDATION_ERROR", "缺少 'name' 查询参数"));
    }
    const configInput = body?.config ?? body;
    return runWebHandler(status, store, (actor) => handleUpdate(actor, name, configInput));
  },
  {
    sessionAuth: true,
    query: nameQuerySchema,
    response: {
      200: looseOkSchema,
      400: WebErrSchema,
      401: WebErrSchema,
      403: WebErrSchema,
      404: WebErrSchema,
    },
    detail: {
      tags: ["McpConfig"],
      summary: "更新 MCP 服务器配置",
      description:
        "更新指定 MCP 服务器的完整配置对象。名称通过 `name` 查询参数传入，请求体为 `config` 对象（可含 `publicReadable`）。不可见返回 404，可见但无修改权限返回 403。",
      parameters: [
        {
          name: "name",
          in: "query",
          required: true,
          description: "MCP 服务器名称或共享资源键。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

// DELETE /web/config/mcp?name=xxx — delete MCP server
app.delete(
  "/config/mcp",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia store type
  ({ store, query, status }: any) => {
    const name = extractName(query);
    if (!name) {
      return status(400, buildWebErrorBody("VALIDATION_ERROR", "缺少 'name' 查询参数"));
    }
    return runWebHandler(status, store, (actor) => handleDelete(actor, name));
  },
  {
    sessionAuth: true,
    query: nameQuerySchema,
    response: {
      200: looseOkSchema,
      400: WebErrSchema,
      401: WebErrSchema,
      403: WebErrSchema,
      404: WebErrSchema,
    },
    detail: {
      tags: ["McpConfig"],
      summary: "删除 MCP 服务器",
      description:
        "删除指定的 MCP 服务器及其缓存的工具记录（同一事务）。仅对资源拥有 `delete` 动作的主体可删除（owner / admin；其他组织的公开资源不可删除）。",
      parameters: [
        {
          name: "name",
          in: "query",
          required: true,
          description: "待删除的 MCP 服务器名称或共享资源键。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

// ─── Action routes (use "/actions/" prefix to avoid name collision) ───

// POST /web/config/mcp/actions/enable?name=xxx — enable server
app.post(
  "/config/mcp/actions/enable",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia store type
  ({ store, query, status }: any) => {
    const name = extractName(query);
    if (!name) {
      return status(400, buildWebErrorBody("VALIDATION_ERROR", "缺少 'name' 查询参数"));
    }
    return runWebHandler(status, store, (actor) => handleEnable(actor, name));
  },
  {
    sessionAuth: true,
    query: nameQuerySchema,
    response: {
      200: looseOkSchema,
      400: WebErrSchema,
      401: WebErrSchema,
      403: WebErrSchema,
      404: WebErrSchema,
    },
    detail: {
      tags: ["McpConfig"],
      summary: "启用 MCP 服务器",
      description: "启用指定的 MCP 服务器，使其可在 Agent 运行时被使用。名称通过 `name` 查询参数传入。",
      parameters: [
        {
          name: "name",
          in: "query",
          required: true,
          description: "待启用的 MCP 服务器名称或共享资源键。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

// POST /web/config/mcp/actions/disable?name=xxx — disable server
app.post(
  "/config/mcp/actions/disable",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia store type
  ({ store, query, status }: any) => {
    const name = extractName(query);
    if (!name) {
      return status(400, buildWebErrorBody("VALIDATION_ERROR", "缺少 'name' 查询参数"));
    }
    return runWebHandler(status, store, (actor) => handleDisable(actor, name));
  },
  {
    sessionAuth: true,
    query: nameQuerySchema,
    response: {
      200: looseOkSchema,
      400: WebErrSchema,
      401: WebErrSchema,
      403: WebErrSchema,
      404: WebErrSchema,
    },
    detail: {
      tags: ["McpConfig"],
      summary: "禁用 MCP 服务器",
      description: "禁用指定的 MCP 服务器，使其在 Agent 运行时暂时不可用。名称通过 `name` 查询参数传入。",
      parameters: [
        {
          name: "name",
          in: "query",
          required: true,
          description: "待禁用的 MCP 服务器名称或共享资源键。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

// POST /web/config/mcp/actions/test?name=xxx — test saved server connection
app.post(
  "/config/mcp/actions/test",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia store type
  ({ store, query, status }: any) => {
    const name = extractName(query);
    if (!name) {
      return status(400, buildWebErrorBody("VALIDATION_ERROR", "缺少 'name' 查询参数"));
    }
    return runWebHandler(status, store, (actor) => handleTest(actor, name));
  },
  {
    sessionAuth: true,
    query: nameQuerySchema,
    response: {
      200: looseOkSchema,
      400: WebErrSchema,
      401: WebErrSchema,
      403: WebErrSchema,
      404: WebErrSchema,
    },
    detail: {
      tags: ["McpConfig"],
      summary: "测试已保存的 MCP 服务器连接",
      description:
        "测试指定 MCP 服务器的连接可达性与协议兼容性。对远程服务器执行 MCP 协议握手，对本地服务器检查命令可用性。名称通过 `name` 查询参数传入。",
      parameters: [
        {
          name: "name",
          in: "query",
          required: true,
          description: "待测试的 MCP 服务器名称或共享资源键。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

// POST /web/config/mcp/actions/test-url — test arbitrary URL
app.post(
  "/config/mcp/actions/test-url",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia body type is loose at runtime
  async ({ body, status }: any) => {
    const url = typeof body?.url === "string" ? body.url : undefined;
    const headers =
      typeof body?.headers === "object" && body?.headers !== null
        ? (body.headers as Record<string, string>)
        : undefined;
    const timeout = typeof body?.timeout === "number" ? (body.timeout as number) : undefined;

    try {
      // 任意 URL 探活不涉及已保存资源，因此不需要主体与授权。
      return await handleTestUrl(url!, headers, timeout);
    } catch (error_) {
      const err = resolveThrownError(error_);
      if (err) return status(err.code, err.body);
      throw error_;
    }
  },
  {
    sessionAuth: true,
    response: {
      200: looseOkSchema,
      400: WebErrSchema,
      401: WebErrSchema,
    },
    detail: {
      tags: ["McpConfig"],
      summary: "测试任意 URL 的 MCP 协议兼容性",
      description:
        "向任意 URL 发起 MCP 协议探测，验证其是否可连接且支持 MCP 协议。请求体需包含 `url` 字段，可选的 `headers` 和 `timeout`。",
    },
  },
);

// POST /web/config/mcp/actions/inspect?name=xxx — inspect remote MCP server tools
app.post(
  "/config/mcp/actions/inspect",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia store type
  ({ store, query, status }: any) => {
    const name = extractName(query);
    if (!name) {
      return status(400, buildWebErrorBody("VALIDATION_ERROR", "缺少 'name' 查询参数"));
    }
    return runWebHandler(status, store, (actor) => handleInspect(actor, name));
  },
  {
    sessionAuth: true,
    query: nameQuerySchema,
    response: {
      200: looseOkSchema,
      400: WebErrSchema,
      401: WebErrSchema,
      403: WebErrSchema,
      404: WebErrSchema,
    },
    detail: {
      tags: ["McpConfig"],
      summary: "检测远程 MCP 服务器工具列表",
      description:
        "连接指定的远程 MCP 服务器，获取其工具列表并存入数据库。仅支持 remote 类型的服务器。名称通过 `name` 查询参数传入。",
      parameters: [
        {
          name: "name",
          in: "query",
          required: true,
          description: "待检测的 MCP 服务器名称或共享资源键。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

// GET /web/config/mcp/actions/tools?name=xxx — list cached tools
app.get(
  "/config/mcp/actions/tools",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia store type
  ({ store, query, status }: any) => {
    const name = extractName(query);
    if (!name) {
      return status(400, buildWebErrorBody("VALIDATION_ERROR", "缺少 'name' 查询参数"));
    }
    return runWebHandler(status, store, (actor) => handleListTools(actor, name));
  },
  {
    sessionAuth: true,
    query: nameQuerySchema,
    response: {
      200: looseOkSchema,
      400: WebErrSchema,
      401: WebErrSchema,
      404: WebErrSchema,
    },
    detail: {
      tags: ["McpConfig"],
      summary: "获取 MCP 服务器的缓存工具列表",
      description:
        "获取指定 MCP 服务器上次检测后缓存的工具列表。适用于内部和外部（只读共享）MCP 服务器；`name` 返回资源自身的名称，与查询用的资源键无关。名称通过 `name` 查询参数传入。",
      parameters: [
        {
          name: "name",
          in: "query",
          required: true,
          description: "MCP 服务器名称或共享资源键。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

export default app;
