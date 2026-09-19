/** Hindsight 记忆 MCP 服务配置与 Bank 管理 */

import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import type { AuthContext } from "@server/plugins/auth";
import { upsertSystemMcpServer } from "@server/services/config";

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
      // Hindsight API 要求 body 不能为空（422 missing body），传空 JSON 即可
      body: JSON.stringify({}),
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
 *
 * bankId 是既有外部约定（Hindsight bank 标识），不是授权判据；成员关系读取唯一经
 * `IdentityDirectory`，本包不得直接查身份表。
 */
export async function resolveMemberId(ctx: AuthContext): Promise<string | null> {
  const membershipId = await getIdentityDirectory().resolveMembershipId({
    organizationId: ctx.organizationId,
    userId: ctx.userId,
  });
  return membershipId ?? null;
}

/**
 * 为当前用户创建/更新 hindsight MCP server 条目 + 确保 bank 存在。
 * 幂等操作：系统路径内部使用 onConflictDoUpdate。
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

  // 创建/更新 mcpServer 表记录（幂等）：系统托管服务器由系统路径写入，不经过用户授权。
  await upsertSystemMcpServer({
    name: HINDSIGHT_MCP_SERVER_NAME,
    type: "remote",
    config: mcpConfig,
    organizationId: ctx.organizationId,
    ownerUserId: ctx.userId,
  });

  // 确保 Hindsight bank 存在
  const bankResult = await ensureBank(memberId);
  if (!bankResult.ok) {
    return { ok: false, error: bankResult.error };
  }

  return { ok: true };
}

/**
 * 通用 Hindsight API 转发。构造目标 URL 并转发请求。
 * 调用方负责传入正确的 path。
 */
export async function proxyToHindsight(path: string, options?: RequestInit): Promise<Response> {
  const config = getHindsightConfig();
  if (!config) {
    throw new Error("HINDSIGHT_MCP_URL not configured");
  }
  return fetch(`${config.url}${path}`, options);
}
