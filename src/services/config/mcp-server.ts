import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { mcpServer, mcpTool } from "../../db/schema";
import type { AuthContext } from "../../plugins/auth";
import {
  assertInternalWritable,
  canReadResource,
  decorateResourceAccess,
  listReadableResourceRefs,
  setPublicRead,
} from "../resource-permission";
import { parseJsonb } from "./jsonb";
import type { McpServerConfig, McpServerInfoOutput, McpServerSetOptions, ResourceAccess } from "./types";

// ────────────────────────────────────────────
// MCP Server 操作
// ────────────────────────────────────────────

type McpServerRow = typeof mcpServer.$inferSelect;
type McpServerRowWithAccess = McpServerRow & { resourceAccess: ResourceAccess };

function parseResourceKey(resourceKey: string) {
  const slashIndex = resourceKey.indexOf("/");
  if (slashIndex <= 0 || slashIndex === resourceKey.length - 1) return null;
  return {
    sourceOrganizationId: resourceKey.slice(0, slashIndex),
    resourceUid: resourceKey.slice(slashIndex + 1),
  };
}

async function listExternalMcpServers(ctx: AuthContext): Promise<McpServerRow[]> {
  const refs = await listReadableResourceRefs(ctx, "mcp_server");
  const ids = refs.map((ref) => ref.resourceId);
  if (ids.length === 0) return [];

  const rows = await db.select().from(mcpServer).where(inArray(mcpServer.id, ids));
  const refKeys = new Set(refs.map((ref) => `${ref.organizationId}/${ref.resourceId}`));
  return rows.filter((row) => refKeys.has(`${row.organizationId}/${row.id}`));
}

export async function listMcpServers(ctx: AuthContext): Promise<McpServerRowWithAccess[]> {
  const internal = await db.select().from(mcpServer).where(eq(mcpServer.organizationId, ctx.organizationId));
  const external = await listExternalMcpServers(ctx);
  return decorateResourceAccess(ctx, "mcp_server", [...internal, ...external]);
}

export async function getMcpServer(ctx: AuthContext, name: string): Promise<McpServerRowWithAccess | null> {
  const rows = await db
    .select()
    .from(mcpServer)
    .where(and(eq(mcpServer.organizationId, ctx.organizationId), eq(mcpServer.name, name)))
    .limit(1);
  const internal = rows[0] ?? null;
  if (internal) {
    const [decorated] = await decorateResourceAccess(ctx, "mcp_server", [internal]);
    return decorated;
  }

  const external = (await listExternalMcpServers(ctx)).find((row) => row.name === name);
  if (!external) return null;
  const canRead = await canReadResource(ctx, "mcp_server", external.id, external.organizationId);
  if (!canRead) return null;
  const [decorated] = await decorateResourceAccess(ctx, "mcp_server", [external]);
  return decorated;
}

export async function getMcpServerById(ctx: AuthContext, serverId: string): Promise<McpServerRowWithAccess | null> {
  const rows = await db.select().from(mcpServer).where(eq(mcpServer.id, serverId)).limit(1);
  const row = rows[0] ?? null;
  if (!row) return null;

  if (row.organizationId === ctx.organizationId) {
    const [decorated] = await decorateResourceAccess(ctx, "mcp_server", [row]);
    return decorated;
  }

  const readable = await canReadResource(ctx, "mcp_server", row.id, row.organizationId);
  if (!readable) return null;

  const [decorated] = await decorateResourceAccess(ctx, "mcp_server", [row]);
  return decorated;
}

export async function getMcpServerByResourceKey(
  ctx: AuthContext,
  resourceKey: string,
): Promise<McpServerRowWithAccess | null> {
  const parsed = parseResourceKey(resourceKey);
  if (!parsed) return null;

  const rows = await db.select().from(mcpServer).where(eq(mcpServer.id, parsed.resourceUid)).limit(1);
  const row = rows[0] ?? null;
  if (!row || row.organizationId !== parsed.sourceOrganizationId) return null;

  const readable = await canReadResource(ctx, "mcp_server", row.id, row.organizationId);
  if (!readable) return null;

  const [decorated] = await decorateResourceAccess(ctx, "mcp_server", [row]);
  return decorated;
}

export async function createMcpServer(
  ctx: AuthContext,
  name: string,
  type: string,
  config: McpServerConfig,
  options: McpServerSetOptions = {},
) {
  const values = {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    name,
    type,
    config,
    enabled: true,
    updatedAt: new Date(),
  };
  const rows = await db
    .insert(mcpServer)
    .values(values)
    .onConflictDoUpdate({
      target: [mcpServer.organizationId, mcpServer.name],
      set: {
        type,
        config,
        updatedAt: new Date(),
      },
    })
    .returning({ id: mcpServer.id });

  if (options.publicReadable !== undefined && rows[0]) {
    await setPublicRead(ctx, "mcp_server", ctx.organizationId, rows[0].id, options.publicReadable);
  }
}

export async function updateMcpServer(
  ctx: AuthContext,
  name: string,
  config: McpServerConfig,
  options: McpServerSetOptions = {},
): Promise<boolean> {
  const existing = await getMcpServer(ctx, name);
  if (!existing) return false;

  assertInternalWritable(ctx, "mcp_server", existing.id, existing.organizationId);
  const updates: Partial<typeof mcpServer.$inferInsert> = { config, updatedAt: new Date() };
  if ("type" in config && typeof config.type === "string" && VALID_MCP_TYPES.includes(config.type)) {
    updates.type = config.type;
  }
  const result = await db
    .update(mcpServer)
    .set(updates)
    .where(eq(mcpServer.id, existing.id))
    .returning({ id: mcpServer.id });
  if (result.length > 0 && options.publicReadable !== undefined) {
    await setPublicRead(ctx, "mcp_server", ctx.organizationId, existing.id, options.publicReadable);
  }
  return result.length > 0;
}

export async function updateMcpServerById(
  ctx: AuthContext,
  serverId: string,
  config: McpServerConfig,
  options: McpServerSetOptions = {},
): Promise<boolean> {
  const existing = await getMcpServerById(ctx, serverId);
  if (!existing) return false;

  assertInternalWritable(ctx, "mcp_server", existing.id, existing.organizationId);
  const updates: Partial<typeof mcpServer.$inferInsert> = { config, updatedAt: new Date() };
  if ("type" in config && typeof config.type === "string" && VALID_MCP_TYPES.includes(config.type)) {
    updates.type = config.type;
  }
  const result = await db
    .update(mcpServer)
    .set(updates)
    .where(eq(mcpServer.id, existing.id))
    .returning({ id: mcpServer.id });
  if (result.length > 0 && options.publicReadable !== undefined) {
    await setPublicRead(ctx, "mcp_server", ctx.organizationId, existing.id, options.publicReadable);
  }
  return result.length > 0;
}

export async function deleteMcpServer(ctx: AuthContext, name: string): Promise<boolean> {
  const row = await getMcpServer(ctx, name);
  if (!row) return false;

  assertInternalWritable(ctx, "mcp_server", row.id, row.organizationId);
  const result = await db.delete(mcpServer).where(eq(mcpServer.id, row.id)).returning({ id: mcpServer.id });
  return result.length > 0;
}

export async function deleteMcpServerById(ctx: AuthContext, serverId: string): Promise<boolean> {
  const row = await getMcpServerById(ctx, serverId);
  if (!row) return false;

  assertInternalWritable(ctx, "mcp_server", row.id, row.organizationId);
  const result = await db.delete(mcpServer).where(eq(mcpServer.id, row.id)).returning({ id: mcpServer.id });
  return result.length > 0;
}

export async function setMcpServerEnabled(ctx: AuthContext, name: string, enabled: boolean): Promise<boolean> {
  const row = await getMcpServer(ctx, name);
  if (!row) return false;

  assertInternalWritable(ctx, "mcp_server", row.id, row.organizationId);
  const result = await db
    .update(mcpServer)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(mcpServer.id, row.id))
    .returning({ id: mcpServer.id });
  return result.length > 0;
}

export async function assertMcpServerInternalWritable(
  ctx: AuthContext,
  name: string,
): Promise<McpServerRowWithAccess | null> {
  const row = await getMcpServer(ctx, name);
  if (!row) return null;
  assertInternalWritable(ctx, "mcp_server", row.id, row.organizationId);
  return row;
}

export async function assertMcpServerInternalWritableById(
  ctx: AuthContext,
  serverId: string,
): Promise<McpServerRowWithAccess | null> {
  const row = await getMcpServerById(ctx, serverId);
  if (!row) return null;
  assertInternalWritable(ctx, "mcp_server", row.id, row.organizationId);
  return row;
}

// ────────────────────────────────────────────
// MCP Tool 缓存操作（mcp_tool 表）
// ────────────────────────────────────────────

/** 统计指定 server 的 tool 数量（使用 SQL COUNT，避免全量拉取） */
export async function countToolsByServer(organizationId: string, serverName: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(mcpTool)
    .where(and(eq(mcpTool.organizationId, organizationId), eq(mcpTool.serverName, serverName)));
  return Number(row?.count ?? 0);
}

/** 删除指定 server 的所有缓存 tool */
export async function deleteToolsByServer(organizationId: string, serverName: string): Promise<void> {
  await db.delete(mcpTool).where(and(eq(mcpTool.organizationId, organizationId), eq(mcpTool.serverName, serverName)));
}

/** 替换指定 server 的缓存 tool（事务保证原子性：先删后插） */
export async function replaceToolsForServer(
  organizationId: string,
  serverName: string,
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(mcpTool).where(and(eq(mcpTool.organizationId, organizationId), eq(mcpTool.serverName, serverName)));
    if (tools.length > 0) {
      const now = new Date();
      const rows = tools.map((t) => ({
        id: randomUUID(),
        organizationId,
        serverName,
        toolName: t.name,
        description: t.description ?? null,
        inputSchema: t.inputSchema ?? null,
        inspectedAt: now,
      }));
      await tx.insert(mcpTool).values(rows);
    }
  });
}

/** 列出指定 server 的缓存 tool */
export async function listToolsByServer(organizationId: string, serverName: string) {
  return db
    .select()
    .from(mcpTool)
    .where(and(eq(mcpTool.organizationId, organizationId), eq(mcpTool.serverName, serverName)));
}

// ────────────────────────────────────────────
// MCP Server 验证与转换
// ────────────────────────────────────────────

/** MCP 服务器名称校验 */
export function isValidMcpName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length >= 1 &&
    name.length <= 64 &&
    !/--/.test(name) &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)
  );
}

/** 允许的 MCP 服务器类型 */
const VALID_MCP_TYPES: string[] = ["local", "remote", "streamable-http"];

/** 校验 MCP 配置结构，返回错误码或 null */
export function validateMcpConfig(config: unknown): string | null {
  if (typeof config !== "object" || config === null) return "INVALID_CONFIG";
  const cfg = config as Record<string, unknown>;

  if ("enabled" in cfg && cfg.enabled === false && Object.keys(cfg).length === 1) return null;

  if (!("type" in cfg) || typeof cfg.type !== "string") return "INVALID_CONFIG_TYPE";
  const type = cfg.type as string;

  if (type === "local") {
    if (
      !Array.isArray(cfg.command) ||
      cfg.command.length === 0 ||
      cfg.command.some((c: unknown) => typeof c !== "string")
    ) {
      return "INVALID_COMMAND";
    }
    if (cfg.environment !== undefined && (typeof cfg.environment !== "object" || cfg.environment === null)) {
      return "INVALID_ENVIRONMENT";
    }
    if (cfg.timeout !== undefined && (typeof cfg.timeout !== "number" || cfg.timeout <= 0)) {
      return "INVALID_TIMEOUT";
    }
  } else if (type === "remote" || type === "streamable-http") {
    if (typeof cfg.url !== "string" || cfg.url.length === 0) return "INVALID_URL";
    if (cfg.headers !== undefined && (typeof cfg.headers !== "object" || cfg.headers === null)) {
      return "INVALID_HEADERS";
    }
    if (cfg.timeout !== undefined && (typeof cfg.timeout !== "number" || cfg.timeout <= 0)) {
      return "INVALID_TIMEOUT";
    }
  } else {
    return "INVALID_CONFIG_TYPE";
  }
  return null;
}

/** 将 PG 行数据转为前端展示信息 */
export function toServerInfo(
  name: string,
  row: { type: string; config: unknown; enabled: boolean },
): McpServerInfoOutput {
  const config = parseJsonb<Record<string, unknown>>(row.config) ?? {};
  if (!row.enabled && !("type" in config)) {
    return { name, type: "disabled", enabled: false, summary: "已禁用" };
  }
  const cfgType = config.type as string;
  if (cfgType === "local") {
    const command = Array.isArray(config.command) ? (config.command as string[]) : [];
    return {
      name,
      type: "local",
      enabled: row.enabled,
      summary: command[0] ?? "",
      timeout: config.timeout as number | undefined,
    };
  }
  // streamable-http 和 remote 统一展示（使用 URL）
  const typeLabel = cfgType === "streamable-http" ? ("streamable-http" as const) : ("remote" as const);
  return {
    name,
    type: typeLabel,
    enabled: row.enabled,
    summary: (config.url as string) ?? "",
    timeout: config.timeout as number | undefined,
  };
}
