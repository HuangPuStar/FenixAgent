import Elysia from "elysia";
import * as z from "zod/v4";
import { AppError } from "../../../errors";
import { type AuthContext, authGuardPlugin } from "../../../plugins/auth";
import { WebErrSchema, WebOkSchema } from "../../../schemas/common.schema";
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

app.post(
  "/config/mcp",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + body model
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;
    const b = body as ConfigBody;
    const { action, name, config, url, headers, timeout, publicReadable } = {
      action: b.action ?? "",
      name: b.name as string | undefined,
      config: (b.config ?? b.data) as McpServerConfig | undefined,
      url: b.url as string | undefined,
      headers: b.headers as Record<string, string> | undefined,
      timeout: b.timeout as number | undefined,
      publicReadable:
        typeof (b.data as Record<string, unknown> | undefined)?.publicReadable === "boolean"
          ? ((b.data as Record<string, unknown>).publicReadable as boolean)
          : typeof (b.config as Record<string, unknown> | undefined)?.publicReadable === "boolean"
            ? ((b.config as Record<string, unknown>).publicReadable as boolean)
            : undefined,
    };

    try {
      switch (action) {
        case "list":
          return await handleList(authCtx);
        case "get":
          return await handleGet(authCtx, name!);
        case "create":
          return await handleCreate(authCtx, name!, config, publicReadable);
        case "set":
        case "update":
          return await handleUpdate(authCtx, name!, config, publicReadable);
        case "delete":
          return await handleDelete(authCtx, name!);
        case "enable":
          return await handleEnable(authCtx, name!);
        case "disable":
          return await handleDisable(authCtx, name!);
        case "test":
          return await handleTest(authCtx, name!);
        case "test_url":
          return await handleTestUrl(url!, headers, timeout);
        case "inspect":
          return await handleInspect(authCtx, name!);
        case "list_tools":
          return await handleListTools(authCtx, name!);
        default:
          return error(400, {
            success: false,
            error: { code: "VALIDATION_ERROR", message: `Unknown action '${action}'` },
          });
      }
    } catch (e: unknown) {
      if (e instanceof AppError) {
        return error(e.statusCode, { success: false, error: { code: e.code, message: e.message } });
      }
      const message = e instanceof Error ? e.message : "Unknown error";
      return error(500, { success: false, error: { code: "CONFIG_READ_ERROR", message } });
    }
  },
  {
    sessionAuth: true,
    body: "config-body",
    response: {
      // TODO: 当前仍是 action 分发入口，成功 data 先以宽松对象占位；后续应拆分为独立接口并补精确成功响应 schema。
      200: WebOkSchema(z.looseObject({})),
      400: WebErrSchema,
      500: WebErrSchema,
    },
    detail: { tags: ["McpConfig"], summary: "MCP 服务器配置管理" },
  },
);

export default app;
