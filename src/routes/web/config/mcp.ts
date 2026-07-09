import Elysia from "elysia";
import * as z from "zod/v4";
import { AppError } from "../../../errors";
import { type AuthContext, authGuardPlugin } from "../../../plugins/auth";
import { WebErrSchema, WebOkSchema } from "../../../schemas/common.schema";
import * as configPg from "../../../services/config/index";
import {
  countToolsByServer,
  deleteToolsByServer,
  isValidMcpName,
  listToolsByServer,
  replaceToolsForServer,
  toServerInfo,
  validateMcpConfig,
} from "../../../services/config/mcp-server";
import type { McpRemoteConfig, McpServerConfig } from "../../../services/config/types";
import { inspectRemoteMcpServer } from "../../../services/mcp-inspector";

function splitMcpConfigInput(input: unknown) {
  if (typeof input !== "object" || input === null) {
    return { config: input as McpServerConfig, publicReadable: undefined as boolean | undefined };
  }
  const raw = input as Record<string, unknown>;
  const publicReadable = typeof raw.publicReadable === "boolean" ? raw.publicReadable : undefined;
  const { publicReadable: _ignored, ...config } = raw;
  return {
    config: config as unknown as McpServerConfig,
    publicReadable,
  };
}

// --- Helper: extract name from query params (handles resource keys with slashes) ---
function extractName(query: unknown): string | undefined {
  if (typeof query !== "object" || query === null) return;
  const name = (query as Record<string, unknown>).name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

// --- Action Handlers ---

async function handleList(ctx: AuthContext) {
  const servers = await configPg.listMcpServers(ctx);

  const serversWithCount = await Promise.all(
    servers.map(async (s) => {
      try {
        const info = toServerInfo(s.name, s);
        const toolsCount = await countToolsByServer(s.organizationId, s.name);
        return {
          id: s.id,
          ...info,
          resourceAccess: s.resourceAccess,
          toolsCount,
        };
      } catch {
        const info = toServerInfo(s.name, s);
        return {
          id: s.id,
          ...info,
          resourceAccess: s.resourceAccess,
          toolsCount: 0,
        };
      }
    }),
  );

  return { success: true, data: { servers: serversWithCount } };
}

async function handleGet(ctx: AuthContext, name: string) {
  const s = name.includes("/")
    ? await configPg.getMcpServerByResourceKey(ctx, name)
    : await configPg.getMcpServer(ctx, name);
  if (!s) return { success: false, error: { code: "NOT_FOUND", message: `MCP server '${name}' not found` } };
  return { success: true, data: { name: s.name, config: s.config, resourceAccess: s.resourceAccess } };
}

async function _handleCreate(ctx: AuthContext, name: string, configInput: unknown, bodyPublicReadable?: boolean) {
  const { config, publicReadable: configPublicReadable } = splitMcpConfigInput(configInput);
  const publicReadable = bodyPublicReadable ?? configPublicReadable;
  if (!isValidMcpName(name)) {
    return {
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid server name: must be 1-64 lowercase alphanumeric chars with single hyphens",
      },
    };
  }
  const validation = validateMcpConfig(config);
  if (validation) return { success: false, error: { code: "VALIDATION_ERROR", message: validation } };

  const existing = await configPg.getMcpServer(ctx, name);
  if (existing?.resourceAccess?.ownership === "internal")
    return { success: false, error: { code: "ALREADY_EXISTS", message: `MCP server '${name}' already exists` } };

  const cfgType =
    typeof config === "object" && config !== null && "type" in config
      ? ((config as unknown as Record<string, unknown>).type as string)
      : "local";
  await configPg.createMcpServer(ctx, name, cfgType, config as McpServerConfig, { publicReadable });
  return { success: true, data: { name } };
}

async function handleUpdate(ctx: AuthContext, name: string, configInput: unknown, bodyPublicReadable?: boolean) {
  const { config, publicReadable: configPublicReadable } = splitMcpConfigInput(configInput);
  const publicReadable = bodyPublicReadable ?? configPublicReadable;
  const validation = validateMcpConfig(config);
  if (validation) return { success: false, error: { code: "VALIDATION_ERROR", message: validation } };

  const existing = await configPg.getMcpServer(ctx, name);
  if (!existing) return { success: false, error: { code: "NOT_FOUND", message: `MCP server '${name}' not found` } };

  await configPg.updateMcpServer(ctx, name, config as McpServerConfig, { publicReadable });
  return { success: true, data: { name } };
}

async function handleDelete(ctx: AuthContext, name: string) {
  const server = await configPg.assertMcpServerInternalWritable(ctx, name);
  if (!server) return { success: false, error: { code: "NOT_FOUND", message: `MCP server '${name}' not found` } };

  const deleted = await configPg.deleteMcpServer(ctx, name);
  if (!deleted) return { success: false, error: { code: "NOT_FOUND", message: `MCP server '${name}' not found` } };

  try {
    await deleteToolsByServer(server.organizationId, name);
  } catch {
    // ignore db errors on cleanup
  }

  return { success: true, data: null };
}

async function handleEnable(ctx: AuthContext, name: string) {
  const existing = await configPg.assertMcpServerInternalWritable(ctx, name);
  if (!existing) return { success: false, error: { code: "NOT_FOUND", message: `MCP server '${name}' not found` } };

  const config = existing.config as Record<string, unknown>;
  if (!("type" in config)) {
    return {
      success: false,
      error: { code: "VALIDATION_ERROR", message: `Cannot enable '${name}': original config lost, please recreate` },
    };
  }

  await configPg.setMcpServerEnabled(ctx, name, true);
  return { success: true, data: { name, enabled: true } };
}

async function handleDisable(ctx: AuthContext, name: string) {
  const existing = await configPg.assertMcpServerInternalWritable(ctx, name);
  if (!existing) return { success: false, error: { code: "NOT_FOUND", message: `MCP server '${name}' not found` } };

  await configPg.setMcpServerEnabled(ctx, name, false);
  return { success: true, data: { name, enabled: false } };
}

async function handleTest(ctx: AuthContext, name: string) {
  const s = await configPg.assertMcpServerInternalWritable(ctx, name);
  if (!s) return { success: false, error: { code: "NOT_FOUND", message: `MCP server '${name}' not found` } };

  const config = s.config as Record<string, unknown>;

  // remote
  if (config.type === "remote") {
    const remote = config as unknown as McpRemoteConfig;
    const timeout = remote.timeout ?? 10000;
    const headers: Record<string, string> = { ...remote.headers };
    if (remote.oauth && typeof remote.oauth === "object" && remote.oauth.clientId) {
      headers.Authorization = `Bearer ${remote.oauth.clientId}`;
    }
    const result = await inspectRemoteMcpServer(remote.url, headers, timeout);
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

  return {
    success: false,
    error: { code: "VALIDATION_ERROR", message: `Cannot test '${name}': unsupported config type` },
  };
}

async function handleTestUrl(url: string, headers?: Record<string, string>, timeout?: number) {
  if (!url || typeof url !== "string")
    return { success: false, error: { code: "VALIDATION_ERROR", message: "URL is required" } };
  const ms = timeout ?? 10000;
  const result = await inspectRemoteMcpServer(url, headers, ms);
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

async function handleInspect(ctx: AuthContext, name: string) {
  const s = await configPg.assertMcpServerInternalWritable(ctx, name);
  if (!s) return { success: false, error: { code: "NOT_FOUND", message: `MCP server '${name}' not found` } };

  const config = s.config as Record<string, unknown>;
  if (config.type !== "remote") {
    return { success: false, error: { code: "VALIDATION_ERROR", message: "Inspect only supports remote MCP servers" } };
  }

  const remote = config as unknown as McpRemoteConfig;
  const timeout = remote.timeout ?? 10000;
  const headers: Record<string, string> = { ...remote.headers };
  if (remote.oauth && typeof remote.oauth === "object" && remote.oauth.clientId) {
    headers.Authorization = `Bearer ${remote.oauth.clientId}`;
  }

  const result = await inspectRemoteMcpServer(remote.url, headers, timeout);
  if (!result.reachable || !result.protocol) {
    return { success: false, error: { code: "VALIDATION_ERROR", message: result.message ?? "无法连接到 MCP 服务器" } };
  }

  await replaceToolsForServer(s.organizationId, name, result.tools);

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

async function handleListTools(ctx: AuthContext, name: string) {
  // 支持内部和外部 MCP server
  const server = name.includes("/")
    ? await configPg.getMcpServerByResourceKey(ctx, name)
    : await configPg.getMcpServer(ctx, name);
  if (!server) return { success: false, error: { code: "NOT_FOUND", message: `MCP server '${name}' not found` } };
  const tools = await listToolsByServer(server.organizationId, name);

  return {
    success: true,
    data: {
      name,
      tools: tools.map((t) => ({
        id: t.id,
        toolName: t.toolName,
        description: t.description,
        inputSchema: t.inputSchema,
        inspectedAt: t.inspectedAt.getTime(),
      })),
    },
  };
}

// --- Error helpers ---

type WebErrorBody = z.infer<typeof WebErrSchema>;

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

interface ConfigErrorResult {
  success: false;
  error: { code?: string; message?: string };
}

/** 检查 handler 返回值是否为错误，若是则返回对应的 HTTP 状态码映射。 */
function resolveConfigError(result: unknown): { code: number; body: WebErrorBody } | null {
  if (
    typeof result === "object" &&
    result !== null &&
    "success" in result &&
    (result as { success?: unknown }).success === false &&
    "error" in result
  ) {
    const err = (result as ConfigErrorResult).error;
    return {
      code: mapConfigErrorStatus(err.code),
      body: buildWebErrorBody(err.code ?? "UNKNOWN_ERROR", err.message ?? "未知错误"),
    };
  }
  return null;
}

/** 将 handler 执行中抛出的 AppError 映射为标准错误响应。 */
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

// ── RESTful 路由 ──

// GET /web/config/mcp — list all MCP servers (or get single when ?name=xxx)
app.get(
  "/config/mcp",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia query type is loose at runtime
  async ({ store, query, status }: any) => {
    const authCtx = store.authContext!;
    const name = extractName(query);

    try {
      const result = name ? await handleGet(authCtx, name) : await handleList(authCtx);
      const err = resolveConfigError(result);
      if (err) return status(err.code, err.body);
      return result;
    } catch (error_) {
      const err = resolveThrownError(error_);
      if (err) return status(err.code, err.body);
      throw error_;
    }
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
        "不带 `name` 查询参数时返回当前组织可见的 MCP 服务器列表；带 `name` 时返回指定服务器的完整配置详情（名称支持 resource key 格式 org_id/server-uuid）。",
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
  async ({ store, body, status }: any) => {
    const authCtx = store.authContext!;
    const name = typeof body?.name === "string" ? body.name : "";
    const configInput = body?.config ?? body;
    const publicReadable = typeof body?.publicReadable === "boolean" ? body.publicReadable : undefined;

    try {
      const result = await _handleCreate(authCtx, name, configInput, publicReadable);
      const err = resolveConfigError(result);
      if (err) return status(err.code, err.body);
      return result;
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
      403: WebErrSchema,
      409: WebErrSchema,
    },
    detail: {
      tags: ["McpConfig"],
      summary: "创建 MCP 服务器",
      description: "创建新的 MCP 服务器配置。请求体需要提供 `name` 和 `config`，并支持可选 `publicReadable`。",
    },
  },
);

// PUT /web/config/mcp?name=xxx — update MCP server
app.put(
  "/config/mcp",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia body type is loose at runtime
  async ({ store, query, body, status }: any) => {
    const authCtx = store.authContext!;
    const name = extractName(query);
    if (!name) {
      return status(400, buildWebErrorBody("VALIDATION_ERROR", "缺少 'name' 查询参数"));
    }

    try {
      const configInput = body?.config ?? body;
      const result = await handleUpdate(authCtx, name, configInput);
      const err = resolveConfigError(result);
      if (err) return status(err.code, err.body);
      return result;
    } catch (error_) {
      const err = resolveThrownError(error_);
      if (err) return status(err.code, err.body);
      throw error_;
    }
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
      description: "更新指定 MCP 服务器的完整配置对象。名称通过 `name` 查询参数传入，请求体为 `config` 对象。",
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
  async ({ store, query, status }: any) => {
    const authCtx = store.authContext!;
    const name = extractName(query);
    if (!name) {
      return status(400, buildWebErrorBody("VALIDATION_ERROR", "缺少 'name' 查询参数"));
    }

    try {
      const result = await handleDelete(authCtx, name);
      const err = resolveConfigError(result);
      if (err) return status(err.code, err.body);
      return result;
    } catch (error_) {
      const err = resolveThrownError(error_);
      if (err) return status(err.code, err.body);
      throw error_;
    }
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
      description: "删除指定的 MCP 服务器及其关联的工具记录。仅当前组织可写的内部服务器允许删除。",
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
  async ({ store, query, status }: any) => {
    const authCtx = store.authContext!;
    const name = extractName(query);
    if (!name) {
      return status(400, buildWebErrorBody("VALIDATION_ERROR", "缺少 'name' 查询参数"));
    }

    try {
      const result = await handleEnable(authCtx, name);
      const err = resolveConfigError(result);
      if (err) return status(err.code, err.body);
      return result;
    } catch (error_) {
      const err = resolveThrownError(error_);
      if (err) return status(err.code, err.body);
      throw error_;
    }
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
  async ({ store, query, status }: any) => {
    const authCtx = store.authContext!;
    const name = extractName(query);
    if (!name) {
      return status(400, buildWebErrorBody("VALIDATION_ERROR", "缺少 'name' 查询参数"));
    }

    try {
      const result = await handleDisable(authCtx, name);
      const err = resolveConfigError(result);
      if (err) return status(err.code, err.body);
      return result;
    } catch (error_) {
      const err = resolveThrownError(error_);
      if (err) return status(err.code, err.body);
      throw error_;
    }
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
  async ({ store, query, status }: any) => {
    const authCtx = store.authContext!;
    const name = extractName(query);
    if (!name) {
      return status(400, buildWebErrorBody("VALIDATION_ERROR", "缺少 'name' 查询参数"));
    }

    try {
      const result = await handleTest(authCtx, name);
      const err = resolveConfigError(result);
      if (err) return status(err.code, err.body);
      return result;
    } catch (error_) {
      const err = resolveThrownError(error_);
      if (err) return status(err.code, err.body);
      throw error_;
    }
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
  async ({ _store, body, status }: any) => {
    const url = typeof body?.url === "string" ? body.url : undefined;
    const headers =
      typeof body?.headers === "object" && body?.headers !== null
        ? (body.headers as Record<string, string>)
        : undefined;
    const timeout = typeof body?.timeout === "number" ? (body.timeout as number) : undefined;

    try {
      const result = await handleTestUrl(url!, headers, timeout);
      const err = resolveConfigError(result);
      if (err) return status(err.code, err.body);
      return result;
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
  async ({ store, query, status }: any) => {
    const authCtx = store.authContext!;
    const name = extractName(query);
    if (!name) {
      return status(400, buildWebErrorBody("VALIDATION_ERROR", "缺少 'name' 查询参数"));
    }

    try {
      const result = await handleInspect(authCtx, name);
      const err = resolveConfigError(result);
      if (err) return status(err.code, err.body);
      return result;
    } catch (error_) {
      const err = resolveThrownError(error_);
      if (err) return status(err.code, err.body);
      throw error_;
    }
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
  async ({ store, query, status }: any) => {
    const authCtx = store.authContext!;
    const name = extractName(query);
    if (!name) {
      return status(400, buildWebErrorBody("VALIDATION_ERROR", "缺少 'name' 查询参数"));
    }

    try {
      const result = await handleListTools(authCtx, name);
      const err = resolveConfigError(result);
      if (err) return status(err.code, err.body);
      return result;
    } catch (error_) {
      const err = resolveThrownError(error_);
      if (err) return status(err.code, err.body);
      throw error_;
    }
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
        "获取指定 MCP 服务器上次检测后缓存的工具列表。适用于内部和外部（只读共享）MCP 服务器。名称通过 `name` 查询参数传入。",
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
