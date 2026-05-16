import { db } from "../../db";
import { mcpServer, mcpTool } from "../../db/schema";
import { eq, and } from "drizzle-orm";
import { parseJsonb } from "./jsonb";
import { randomUUID } from "node:crypto";

// ────────────────────────────────────────────
// MCP Server 操作
// ────────────────────────────────────────────

export async function listMcpServers(userId: string) {
  return db.select().from(mcpServer)
    .where(eq(mcpServer.userId, userId));
}

export async function getMcpServer(userId: string, name: string) {
  const rows = await db.select().from(mcpServer)
    .where(and(eq(mcpServer.userId, userId), eq(mcpServer.name, name)))
    .limit(1);
  return rows[0] ?? null;
}

export async function createMcpServer(
  userId: string,
  name: string,
  type: string,
  config: Record<string, unknown>,
) {
  await db.insert(mcpServer).values({
    userId,
    name,
    type,
    config,
  });
}

export async function updateMcpServer(
  userId: string,
  name: string,
  config: Record<string, unknown>,
) {
  await db.update(mcpServer)
    .set({ config, updatedAt: new Date() })
    .where(and(eq(mcpServer.userId, userId), eq(mcpServer.name, name)));
}

export async function deleteMcpServer(userId: string, name: string): Promise<boolean> {
  const result = await db.delete(mcpServer)
    .where(and(eq(mcpServer.userId, userId), eq(mcpServer.name, name)))
    .returning({ id: mcpServer.id });
  return result.length > 0;
}

export async function setMcpServerEnabled(userId: string, name: string, enabled: boolean) {
  await db.update(mcpServer)
    .set({ enabled, updatedAt: new Date() })
    .where(and(eq(mcpServer.userId, userId), eq(mcpServer.name, name)));
}

// ────────────────────────────────────────────
// MCP Tool 缓存操作（mcp_tool 表）
// ────────────────────────────────────────────

/** 统计指定 server 的 tool 数量 */
export async function countToolsByServer(serverName: string): Promise<number> {
  const rows = await db.select({ id: mcpTool.id })
    .from(mcpTool)
    .where(eq(mcpTool.serverName, serverName));
  return rows.length;
}

/** 删除指定 server 的所有缓存 tool */
export async function deleteToolsByServer(serverName: string): Promise<void> {
  await db.delete(mcpTool).where(eq(mcpTool.serverName, serverName));
}

/** 替换指定 server 的缓存 tool（先删后插） */
export async function replaceToolsForServer(
  serverName: string,
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
): Promise<void> {
  await deleteToolsByServer(serverName);
  if (tools.length > 0) {
    const now = new Date();
    const rows = tools.map((t) => ({
      id: randomUUID(),
      serverName,
      toolName: t.name,
      description: t.description ?? null,
      inputSchema: t.inputSchema ?? null,
      inspectedAt: now,
    }));
    await db.insert(mcpTool).values(rows);
  }
}

/** 列出指定 server 的缓存 tool */
export async function listToolsByServer(serverName: string) {
  return db.select()
    .from(mcpTool)
    .where(eq(mcpTool.serverName, serverName));
}

// ────────────────────────────────────────────
// MCP Server 验证与转换
// ────────────────────────────────────────────

/** MCP 服务器名称校验 */
export function isValidMcpName(name: string): boolean {
  return typeof name === "string"
    && name.length >= 1 && name.length <= 64
    && !/--/.test(name)
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name);
}

/** 校验 MCP 配置结构，返回错误码或 null */
export function validateMcpConfig(config: unknown): string | null {
  if (typeof config !== "object" || config === null) return "INVALID_CONFIG";
  const cfg = config as Record<string, unknown>;

  if ("enabled" in cfg && cfg.enabled === false && Object.keys(cfg).length === 1) return null;

  if (!("type" in cfg) || typeof cfg.type !== "string") return "INVALID_CONFIG_TYPE";
  const type = cfg.type as string;

  if (type === "local") {
    if (!Array.isArray(cfg.command) || cfg.command.length === 0 || !cfg.command.every((c: unknown) => typeof c === "string")) {
      return "INVALID_COMMAND";
    }
    if (cfg.environment !== undefined && (typeof cfg.environment !== "object" || cfg.environment === null)) {
      return "INVALID_ENVIRONMENT";
    }
    if (cfg.timeout !== undefined && (typeof cfg.timeout !== "number" || cfg.timeout <= 0)) {
      return "INVALID_TIMEOUT";
    }
  } else if (type === "remote") {
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
export function toServerInfo(name: string, row: { type: string; config: unknown; enabled: boolean }) {
  const config = parseJsonb<Record<string, unknown>>(row.config) ?? {};
  if (!row.enabled && !("type" in config)) {
    return { name, type: "disabled" as const, enabled: false, summary: "已禁用" };
  }
  const cfgType = config.type as string;
  if (cfgType === "local") {
    const command = config.command as string[];
    return {
      name,
      type: "local" as const,
      enabled: row.enabled,
      summary: command[0] ?? "",
      timeout: config.timeout,
    };
  }
  return {
    name,
    type: "remote" as const,
    enabled: row.enabled,
    summary: config.url ?? "",
    timeout: config.timeout,
  };
}
