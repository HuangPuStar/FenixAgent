/** Hindsight 记忆 MCP 服务配置与 Bank 管理 */

import { member } from "../db/schema";
import type { AuthContext } from "../plugins/auth";
import * as configPg from "./config/index";

/** 读取 Hindsight MCP URL 配置，未配置返回 null */
export function getHindsightConfig(): { url: string } | null {
  const url = process.env.HINDSIGHT_MCP_URL;
  if (!url) return null;
  return { url };
}

/**
 * 确保 Hindsight bank 存在。幂等操作：
 * PUT /v1/default/banks/{bankId} 自动创建或更新。
 * 返回 true 表示成功，false 表示失败。
 */
export async function ensureBank(bankId: string): Promise<{ ok: boolean; error?: string }> {
  const config = getHindsightConfig();
  if (!config) return { ok: false, error: "HINDSIGHT_MCP_URL not configured" };

  try {
    const res = await fetch(`${config.url}/v1/default/banks/${encodeURIComponent(bankId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `Hindsight bank creation failed: ${res.status} ${body}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Hindsight unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** MCP server 名称，固定为 hindsight */
export const HINDSIGHT_MCP_SERVER_NAME = "hindsight";

/**
 * 解析当前用户在活跃组织中的 member ID，用作 Hindsight bank ID。
 * 从 member 表查询 (organizationId, userId) 唯一行。
 */
async function resolveMemberId(ctx: AuthContext): Promise<string | null> {
  const { db } = await import("../db");
  const { eq, and } = await import("drizzle-orm");
  const rows = await db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, ctx.organizationId), eq(member.userId, ctx.userId)))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * 为当前用户创建/更新 hindsight MCP server 条目 + 确保 bank 存在。
 * 幂等操作：createMcpServer 内部使用 onConflictDoUpdate。
 */
export async function ensureHindsightMcpServer(ctx: AuthContext): Promise<{ ok: boolean; error?: string }> {
  const config = getHindsightConfig();
  if (!config) return { ok: false, error: "HINDSIGHT_MCP_URL not configured" };

  const memberId = await resolveMemberId(ctx);
  if (!memberId) return { ok: false, error: "Failed to resolve member ID" };

  const mcpConfig = {
    type: "remote" as const,
    url: `${config.url}/mcp/${memberId}`,
  };

  // 创建/更新 mcpServer 表记录（幂等）
  await configPg.createMcpServer(ctx, HINDSIGHT_MCP_SERVER_NAME, "remote", mcpConfig);

  // 确保 Hindsight bank 存在
  const bankResult = await ensureBank(memberId);
  if (!bankResult.ok) {
    return { ok: false, error: bankResult.error };
  }

  return { ok: true };
}
