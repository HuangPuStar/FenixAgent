import Elysia from "elysia";
import * as z from "zod/v4";
import { AppError } from "../../../errors";
import { type AuthContext, authGuardPlugin } from "../../../plugins/auth";
import {
  type ConfigBody,
  ConfigBodySchema,
  McpServerCreateRequestSchema,
  McpServerUpdateRequestSchema,
  McpTestUrlRequestSchema,
} from "../../../schemas/config.schema";
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
  "mcp-create-request": McpServerCreateRequestSchema,
  "mcp-update-request": McpServerUpdateRequestSchema,
  "mcp-test-url-request": McpTestUrlRequestSchema,
  "mcp-name-param": z
    .object({
      name: z.string().describe("MCP Server 名称或跨组织共享资源键（resourceKey）。"),
    })
    .describe("MCP Server 路径参数。"),
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
    detail: {
      tags: ["McpConfig"],
      summary: "获取 MCP Server 列表",
      description: "返回当前用户可见的所有 MCP 服务器列表，包含服务器基本信息、关联工具数量和跨组织共享访问控制信息。",
      responses: {
        "200": {
          description: "成功返回 MCP 服务器列表。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: true, description: "接口调用成功。" },
                  data: {
                    type: "object",
                    properties: {
                      servers: {
                        type: "array",
                        description: "MCP 服务器列表。",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string", description: "服务器 ID。" },
                            name: { type: "string", description: "服务器名称。" },
                            type: {
                              type: "string",
                              enum: ["local", "remote", "disabled"],
                              description: "服务器类型。",
                            },
                            enabled: { type: "boolean", description: "是否已启用。" },
                            summary: { type: "string", description: "功能摘要。" },
                            timeout: { type: "number", description: "超时时间（毫秒）。" },
                            toolsCount: { type: "number", description: "关联工具数量。" },
                            resourceAccess: {
                              type: "object",
                              description: "访问控制信息，内部服务器有全部权限，外部只读。",
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "400": {
          description: "请求参数错误，缺少必填字段或参数格式不合法。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false, description: "是否成功。false 表示失败。" },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 VALIDATION_ERROR。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "403": {
          description: "无权限操作，外部共享资源不可写。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 FORBIDDEN。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "404": {
          description: "资源不存在。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 NOT_FOUND。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "500": {
          description: "服务器内部错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
      } as any,
    },
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
    params: "mcp-name-param",
    detail: {
      tags: ["McpConfig"],
      summary: "获取 MCP Server 详情",
      description:
        "根据名称或跨组织共享资源键（resourceKey）获取单个 MCP 服务器的详细配置。支持通过 resourceKey 读取外部组织共享的服务器。",
      responses: {
        "200": {
          description: "成功返回 MCP Server 详情。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: true, description: "接口调用成功。" },
                  data: {
                    type: "object",
                    properties: {
                      name: { type: "string", description: "服务器名称。" },
                      config: { type: "object", description: "服务器完整配置对象，包含 type/command/url/headers 等。" },
                      resourceAccess: { type: "object", description: "跨组织访问控制信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "400": {
          description: "请求参数错误，缺少必填字段或参数格式不合法。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false, description: "是否成功。false 表示失败。" },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 VALIDATION_ERROR。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "403": {
          description: "无权限操作，外部共享资源不可写。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 FORBIDDEN。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "404": {
          description: "资源不存在。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 NOT_FOUND。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "500": {
          description: "服务器内部错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
      } as any,
    },
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
    body: "mcp-create-request",
    detail: {
      tags: ["McpConfig"],
      summary: "创建 MCP Server",
      description:
        "创建一个新的 MCP 服务器配置。支持 local（本地子进程）和 remote（远端 HTTP SSE）两种类型。请求体需包含服务器名称 name 和类型 type。local 类型需提供 command 命令数组，remote 类型需提供 url。名称必须为 1-64 位小写字母数字加单连字符。创建时会检查名称是否已存在。",
      responses: {
        "200": {
          description: "操作成功。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: true, description: "接口调用成功。" },
                  data: {
                    type: "object",
                    properties: {
                      name: { type: "string", description: "MCP Server 名称。" },
                    },
                  },
                },
              },
            },
          },
        },
        "400": {
          description: "请求参数错误，缺少必填字段或参数格式不合法。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false, description: "是否成功。false 表示失败。" },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 VALIDATION_ERROR。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "403": {
          description: "无权限操作，外部共享资源不可写。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 FORBIDDEN。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "404": {
          description: "资源不存在。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 NOT_FOUND。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "500": {
          description: "服务器内部错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
      } as any,
    },
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
    params: "mcp-name-param",
    body: "mcp-update-request",
    detail: {
      tags: ["McpConfig"],
      summary: "更新 MCP Server",
      description:
        "更新指定 MCP 服务器的配置。支持修改服务器类型、连接参数、环境变量和公开可读状态。请求体只需包含需要更新的字段。外部共享服务器不可更新。",
      responses: {
        "200": {
          description: "操作成功。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: true, description: "接口调用成功。" },
                  data: {
                    type: "object",
                    properties: {
                      name: { type: "string", description: "MCP Server 名称。" },
                    },
                  },
                },
              },
            },
          },
        },
        "400": {
          description: "请求参数错误，缺少必填字段或参数格式不合法。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false, description: "是否成功。false 表示失败。" },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 VALIDATION_ERROR。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "403": {
          description: "无权限操作，外部共享资源不可写。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 FORBIDDEN。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "404": {
          description: "资源不存在。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 NOT_FOUND。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "500": {
          description: "服务器内部错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
      } as any,
    },
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
    params: "mcp-name-param",
    detail: {
      tags: ["McpConfig"],
      summary: "删除 MCP Server",
      description: "删除指定的 MCP 服务器配置，同时清理关联的工具缓存。仅可删除内部可写服务器。",
      responses: {
        "200": {
          description: "删除成功。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: true, description: "接口调用成功。" },
                  data: { type: "null", description: "删除成功后固定返回 null。" },
                },
              },
            },
          },
        },
        "400": {
          description: "请求参数错误，缺少必填字段或参数格式不合法。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false, description: "是否成功。false 表示失败。" },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 VALIDATION_ERROR。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "403": {
          description: "无权限操作，外部共享资源不可写。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 FORBIDDEN。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "404": {
          description: "资源不存在。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 NOT_FOUND。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "500": {
          description: "服务器内部错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
      } as any,
    },
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
    params: "mcp-name-param",
    detail: {
      tags: ["McpConfig"],
      summary: "启用 MCP Server",
      description: "启用指定的 MCP 服务器，使其可被 Agent 用于工具查询调用。",
      responses: {
        "200": {
          description: "操作成功。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: true, description: "接口调用成功。" },
                  data: {
                    type: "object",
                    properties: {
                      name: { type: "string", description: "MCP Server 名称。" },
                      enabled: { type: "boolean", description: "启停状态。" },
                    },
                  },
                },
              },
            },
          },
        },
        "400": {
          description: "请求参数错误，缺少必填字段或参数格式不合法。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false, description: "是否成功。false 表示失败。" },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 VALIDATION_ERROR。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "403": {
          description: "无权限操作，外部共享资源不可写。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 FORBIDDEN。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "404": {
          description: "资源不存在。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 NOT_FOUND。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "500": {
          description: "服务器内部错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
      } as any,
    },
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
    params: "mcp-name-param",
    detail: {
      tags: ["McpConfig"],
      summary: "禁用 MCP Server",
      description: "禁用指定的 MCP 服务器，使其不再对 Agent 可用。",
      responses: {
        "200": {
          description: "操作成功。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: true, description: "接口调用成功。" },
                  data: {
                    type: "object",
                    properties: {
                      name: { type: "string", description: "MCP Server 名称。" },
                      enabled: { type: "boolean", description: "启停状态。" },
                    },
                  },
                },
              },
            },
          },
        },
        "400": {
          description: "请求参数错误，缺少必填字段或参数格式不合法。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false, description: "是否成功。false 表示失败。" },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 VALIDATION_ERROR。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "403": {
          description: "无权限操作，外部共享资源不可写。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 FORBIDDEN。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "404": {
          description: "资源不存在。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 NOT_FOUND。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "500": {
          description: "服务器内部错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
      } as any,
    },
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
    params: "mcp-name-param",
    detail: {
      tags: ["McpConfig"],
      summary: "测试 MCP Server 连接",
      description:
        "测试指定 MCP 服务器的连接可达性。remote 类型尝试连接远端 URL 并检查 MCP 协议兼容性；local 类型检查对应的可执行命令是否已安装。",
      responses: {
        "200": {
          description: "测试结果，返回连接可达性和服务器信息。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: true, description: "接口调用成功。" },
                  data: {
                    type: "object",
                    properties: {
                      name: { type: "string", description: "服务器名称。" },
                      reachable: { type: "boolean", description: "服务器是否可达。" },
                      protocol: { type: "boolean", description: "是否兼容 MCP 协议。" },
                      serverName: { type: "string", description: "远端服务器名称。" },
                      serverVersion: { type: "string", description: "远端服务器版本。" },
                      toolsCount: { type: "number", description: "发现的工具数量。" },
                      transport: { type: "string", description: "传输协议。" },
                      message: { type: "string", description: "附加消息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "400": {
          description: "请求参数错误，缺少必填字段或参数格式不合法。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false, description: "是否成功。false 表示失败。" },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 VALIDATION_ERROR。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "403": {
          description: "无权限操作，外部共享资源不可写。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 FORBIDDEN。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "404": {
          description: "资源不存在。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 NOT_FOUND。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "500": {
          description: "服务器内部错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
      } as any,
    },
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
    body: "mcp-test-url-request",
    detail: {
      tags: ["McpConfig"],
      summary: "测试远端 MCP URL",
      description:
        "直接测试一个远端 URL 是否为可用的 MCP HTTP 服务端点，无需提前创建 MCP 服务器配置。请求体需提交 url 地址，可选自定义请求头和超时时间。返回远端服务器的可达性、MCP 协议兼容性、服务器版本和工具数量。",
      responses: {
        "200": {
          description: "测试结果，返回 URL 可达性和服务器信息。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: true, description: "接口调用成功。" },
                  data: {
                    type: "object",
                    properties: {
                      reachable: { type: "boolean", description: "URL 是否可达。" },
                      protocol: { type: "boolean", description: "是否兼容 MCP 协议。" },
                      serverName: { type: "string", description: "远端服务器名称。" },
                      serverVersion: { type: "string", description: "远端服务器版本。" },
                      toolsCount: { type: "number", description: "发现的工具数量。" },
                      transport: { type: "string", description: "传输协议。" },
                      message: { type: "string", description: "附加消息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "400": {
          description: "请求参数错误，缺少必填字段或参数格式不合法。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false, description: "是否成功。false 表示失败。" },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 VALIDATION_ERROR。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "403": {
          description: "无权限操作，外部共享资源不可写。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 FORBIDDEN。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "404": {
          description: "资源不存在。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 NOT_FOUND。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "500": {
          description: "服务器内部错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
      } as any,
    },
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
    params: "mcp-name-param",
    detail: {
      tags: ["McpConfig"],
      summary: "检查 MCP Server 并导入工具",
      description:
        "连接指定远程 MCP 服务器的远端 URL，获取其工具列表并自动导入存储。仅支持 remote 类型服务器。导入的工具会替换已有工具缓存。",
      responses: {
        "200": {
          description: "成功检查并导入工具列表。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: true, description: "接口调用成功。" },
                  data: {
                    type: "object",
                    properties: {
                      name: { type: "string", description: "服务器名称。" },
                      serverInfo: {
                        type: "object",
                        properties: {
                          name: { type: "string", description: "远端服务器名称。" },
                          version: { type: "string", description: "远端服务器版本。" },
                        },
                      },
                      tools: {
                        type: "array",
                        description: "发现的工具列表。",
                        items: {
                          type: "object",
                          properties: {
                            name: { type: "string", description: "工具名称。" },
                            description: { type: "string", description: "工具描述。" },
                            inputSchema: { type: "object", description: "工具输入 JSON Schema。" },
                          },
                        },
                      },
                      transport: { type: "string", description: "传输协议类型。" },
                      stored: { type: "boolean", description: "工具是否已存储。" },
                    },
                  },
                },
              },
            },
          },
        },
        "400": {
          description: "请求参数错误，缺少必填字段或参数格式不合法。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false, description: "是否成功。false 表示失败。" },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 VALIDATION_ERROR。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "403": {
          description: "无权限操作，外部共享资源不可写。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 FORBIDDEN。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "404": {
          description: "资源不存在。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 NOT_FOUND。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "500": {
          description: "服务器内部错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
      } as any,
    },
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
    params: "mcp-name-param",
    detail: {
      tags: ["McpConfig"],
      summary: "获取 MCP Server 的工具列表",
      description: "获取指定 MCP 服务器已检查导入的工具列表，包括工具名称、描述、输入 Schema 和检查时间。",
      responses: {
        "200": {
          description: "成功返回工具列表。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: true, description: "接口调用成功。" },
                  data: {
                    type: "object",
                    properties: {
                      name: { type: "string", description: "服务器名称。" },
                      tools: {
                        type: "array",
                        description: "工具列表。",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string", description: "工具 ID。" },
                            toolName: { type: "string", description: "工具名称。" },
                            description: { type: "string", description: "工具描述。" },
                            inputSchema: { type: "string", description: "工具输入 JSON Schema（序列化字符串）。" },
                            inspectedAt: { type: "number", description: "最近检查时间戳。" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "400": {
          description: "请求参数错误，缺少必填字段或参数格式不合法。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false, description: "是否成功。false 表示失败。" },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 VALIDATION_ERROR。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "403": {
          description: "无权限操作，外部共享资源不可写。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 FORBIDDEN。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "404": {
          description: "资源不存在。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码，如 NOT_FOUND。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
        "500": {
          description: "服务器内部错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string", description: "错误码。" },
                      message: { type: "string", description: "错误描述信息。" },
                    },
                  },
                },
              },
            },
          },
        },
      } as any,
    },
  },
);

export default app;
