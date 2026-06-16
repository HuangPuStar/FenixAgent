import Elysia from "elysia";
import { AppError } from "../../../errors";
import { type AuthContext, authGuardPlugin } from "../../../plugins/auth";
import { type ConfigBody, ConfigBodySchema } from "../../../schemas/config.schema";
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

async function handleCreate(ctx: AuthContext, name: string, configInput: unknown, bodyPublicReadable?: boolean) {
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

  return { success: true };
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

// --- 路由注册 ---
const app = new Elysia({ name: "web-config-mcp" }).use(authGuardPlugin).model({
  "config-body": ConfigBodySchema,
});

// ────────────────────────────────────────────
// MCP Server 管理（RESTful 接口）
// ────────────────────────────────────────────

/** 获取 MCP Server 列表 */
app.get(
  "/config/mcp",
  async ({ store }) => {
    const authCtx = store.authContext!;
    try {
      return await handleList(authCtx);
    } catch (e: unknown) {
      if (e instanceof AppError) return { success: false, error: { code: e.code, message: e.message } };
      return {
        success: false,
        error: { code: "CONFIG_READ_ERROR", message: e instanceof Error ? e.message : "Unknown error" },
      };
    }
  },
  {
    sessionAuth: true,
    detail: { tags: ["McpConfig"], summary: "获取 MCP Server 列表" },
  },
);

/** 获取单个 MCP Server 详情 */
app.get(
  "/config/mcp/:name",
  async ({ store, params }) => {
    const authCtx = store.authContext!;
    try {
      return await handleGet(authCtx, params.name);
    } catch (e: unknown) {
      if (e instanceof AppError) return { success: false, error: { code: e.code, message: e.message } };
      return {
        success: false,
        error: { code: "CONFIG_READ_ERROR", message: e instanceof Error ? e.message : "Unknown error" },
      };
    }
  },
  {
    sessionAuth: true,
    detail: { tags: ["McpConfig"], summary: "获取 MCP Server 详情" },
  },
);

/** 创建 MCP Server */
app.post(
  "/config/mcp",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;
    const b = body ?? {};
    const name = b.name as string | undefined;
    const { name: _ignored, publicReadable: bodyPublicReadable, ...rest } = b;
    try {
      if (!name)
        return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "name is required" } });
      return await handleCreate(authCtx, name, rest, bodyPublicReadable);
    } catch (e: unknown) {
      if (e instanceof AppError)
        return error(e.statusCode, { success: false, error: { code: e.code, message: e.message } });
      return error(500, {
        success: false,
        error: { code: "CONFIG_WRITE_ERROR", message: e instanceof Error ? e.message : "Unknown error" },
      });
    }
  },
  {
    sessionAuth: true,
    detail: { tags: ["McpConfig"], summary: "创建 MCP Server" },
  },
);

/** 更新 MCP Server */
app.put(
  "/config/mcp/:name",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext!;
    const b = body ?? {};
    const { publicReadable: bodyPublicReadable, ...rest } = b;
    try {
      return await handleUpdate(authCtx, params.name, rest, bodyPublicReadable);
    } catch (e: unknown) {
      if (e instanceof AppError)
        return error(e.statusCode, { success: false, error: { code: e.code, message: e.message } });
      return error(500, {
        success: false,
        error: { code: "CONFIG_WRITE_ERROR", message: e instanceof Error ? e.message : "Unknown error" },
      });
    }
  },
  {
    sessionAuth: true,
    detail: { tags: ["McpConfig"], summary: "更新 MCP Server" },
  },
);

/** 删除 MCP Server */
app.delete(
  "/config/mcp/:name",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    try {
      return await handleDelete(authCtx, params.name);
    } catch (e: unknown) {
      if (e instanceof AppError)
        return error(e.statusCode, { success: false, error: { code: e.code, message: e.message } });
      return error(500, {
        success: false,
        error: { code: "CONFIG_WRITE_ERROR", message: e instanceof Error ? e.message : "Unknown error" },
      });
    }
  },
  {
    sessionAuth: true,
    detail: { tags: ["McpConfig"], summary: "删除 MCP Server" },
  },
);

/** 启用 MCP Server */
app.post(
  "/config/mcp/:name/enable",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    try {
      return await handleEnable(authCtx, params.name);
    } catch (e: unknown) {
      if (e instanceof AppError)
        return error(e.statusCode, { success: false, error: { code: e.code, message: e.message } });
      return error(500, {
        success: false,
        error: { code: "CONFIG_WRITE_ERROR", message: e instanceof Error ? e.message : "Unknown error" },
      });
    }
  },
  {
    sessionAuth: true,
    detail: { tags: ["McpConfig"], summary: "启用 MCP Server" },
  },
);

/** 禁用 MCP Server */
app.post(
  "/config/mcp/:name/disable",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    try {
      return await handleDisable(authCtx, params.name);
    } catch (e: unknown) {
      if (e instanceof AppError)
        return error(e.statusCode, { success: false, error: { code: e.code, message: e.message } });
      return error(500, {
        success: false,
        error: { code: "CONFIG_WRITE_ERROR", message: e instanceof Error ? e.message : "Unknown error" },
      });
    }
  },
  {
    sessionAuth: true,
    detail: { tags: ["McpConfig"], summary: "禁用 MCP Server" },
  },
);

/** 测试 MCP Server 连接 */
app.post(
  "/config/mcp/:name/test",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    try {
      return await handleTest(authCtx, params.name);
    } catch (e: unknown) {
      if (e instanceof AppError)
        return error(e.statusCode, { success: false, error: { code: e.code, message: e.message } });
      return error(500, {
        success: false,
        error: { code: "CONFIG_READ_ERROR", message: e instanceof Error ? e.message : "Unknown error" },
      });
    }
  },
  {
    sessionAuth: true,
    detail: { tags: ["McpConfig"], summary: "测试 MCP Server 连接" },
  },
);

/** 测试远端 MCP URL */
app.post(
  "/config/mcp/test-url",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, body, error }: any) => {
    const b = body ?? {};
    const { url, headers, timeout } = b as { url?: string; headers?: Record<string, string>; timeout?: number };
    try {
      if (!url) return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "URL is required" } });
      return await handleTestUrl(url, headers, timeout);
    } catch (e: unknown) {
      if (e instanceof AppError)
        return error(e.statusCode, { success: false, error: { code: e.code, message: e.message } });
      return error(500, {
        success: false,
        error: { code: "CONFIG_READ_ERROR", message: e instanceof Error ? e.message : "Unknown error" },
      });
    }
  },
  {
    sessionAuth: true,
    detail: { tags: ["McpConfig"], summary: "测试远端 MCP URL" },
  },
);

/** 检查远程 MCP Server 并导入工具 */
app.post(
  "/config/mcp/:name/inspect",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    try {
      return await handleInspect(authCtx, params.name);
    } catch (e: unknown) {
      if (e instanceof AppError)
        return error(e.statusCode, { success: false, error: { code: e.code, message: e.message } });
      return error(500, {
        success: false,
        error: { code: "CONFIG_READ_ERROR", message: e instanceof Error ? e.message : "Unknown error" },
      });
    }
  },
  {
    sessionAuth: true,
    detail: { tags: ["McpConfig"], summary: "检查 MCP Server 并导入工具" },
  },
);

/** 获取 MCP Server 的工具列表 */
app.get(
  "/config/mcp/:name/tools",
  async ({ store, params }) => {
    const authCtx = store.authContext!;
    try {
      return await handleListTools(authCtx, params.name);
    } catch (e: unknown) {
      if (e instanceof AppError) return { success: false, error: { code: e.code, message: e.message } };
      return {
        success: false,
        error: { code: "CONFIG_READ_ERROR", message: e instanceof Error ? e.message : "Unknown error" },
      };
    }
  },
  {
    sessionAuth: true,
    detail: { tags: ["McpConfig"], summary: "获取 MCP Server 的工具列表" },
  },
);

export default app;
