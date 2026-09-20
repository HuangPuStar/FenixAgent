/** Hindsight 记忆 MCP 服务配置与 Bank 管理 */

import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import { getMemoryConfig } from "../config";

/**
 * Hindsight 领域需要的最小调用方形状。
 *
 * 刻意不引用宿主 `@server/plugins/auth` 的 `AuthContext`（该类型属宿主内部实现，包一旦依赖就无法
 * 独立测试与构建）。结构化声明让宿主的 `store.authContext` 直接可传，同时把本包对调用方的要求
 * 收窄到「组织 + 用户」——bank 的隔离维度只有这两个。
 */
export interface HindsightActor {
  readonly organizationId: string;
  readonly userId: string;
}

/**
 * 系统托管 MCP server 的登记入口，由宿主注入。
 *
 * 为什么不直接 import：Hindsight MCP server 的写入实现在 `@fenix/resource-mcp`（系统路径
 * `upsertSystemServer`，不走用户授权），而本包 manifest 的 `dependsOn` 冻结为 `[]`
 * （生成器的 `assertDependsOnDeclared` 要求 `dependsOn` 的每条都在 `package.json` 有 workspace 依赖，
 * 写入模块 ID 就会失败）。登记属于「外部能力」而不是本包的领域规则，注入是唯一正确的方向：
 * 宿主 `apps/server` 的实现可原样传入（`upsertSystemMcpServer` 的入参形状是本类型的超集）。
 */
export type RegisterSystemMcpServer = (input: {
  readonly name: string;
  readonly type: string;
  readonly config: { readonly type: "remote"; readonly url: string };
  readonly organizationId: string;
  readonly ownerUserId: string;
}) => Promise<string>;

/**
 * 读取 Hindsight 服务地址，未配置返回 null。
 *
 * 值来自 `getModuleConfig("memory")`（宿主在装配阶段注入 `HINDSIGHT_MCP_URL` 的解析结果）；
 * 本包不读 `process.env`：包内的环境读取会让「包认为已配置、宿主认为未配置」的分歧只能等到
 * 运行期以 503 的形式暴露。
 */
export function getHindsightConfig(): { url: string } | null {
  const { hindsightMcpUrl } = getMemoryConfig();
  if (!hindsightMcpUrl) return null;
  return { url: hindsightMcpUrl };
}

/**
 * 确保 Hindsight bank 存在。幂等操作：
 * PUT /v1/default/banks/{bankId} 自动创建或更新。
 * 返回 true 表示成功，false 表示失败。
 */
export async function ensureBank(bankId: string): Promise<{ ok: boolean; error?: string }> {
  const config = getHindsightConfig();
  if (!config) return { ok: false, error: "Hindsight 未配置：memory 模块配置缺少 hindsightMcpUrl" };

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
export async function resolveMemberId(ctx: HindsightActor): Promise<string | null> {
  const membershipId = await getIdentityDirectory().resolveMembershipId({
    organizationId: ctx.organizationId,
    userId: ctx.userId,
  });
  return membershipId ?? null;
}

/**
 * 为当前用户创建/更新 hindsight MCP server 条目 + 确保 bank 存在。
 * 幂等操作：系统路径内部使用 onConflictDoUpdate。
 *
 * 写入实现由宿主注入（见 `RegisterSystemMcpServer`）；本包只负责决定「写什么」——固定名称、remote
 * 类型、指向该成员 bank 的 MCP 地址，以及「先登记 server 再确保 bank」的先后关系。
 */
export async function ensureHindsightMcpServer(
  ctx: HindsightActor,
  deps: { readonly registerSystemMcpServer: RegisterSystemMcpServer },
): Promise<{ ok: boolean; error?: string }> {
  const config = getHindsightConfig();
  if (!config) return { ok: false, error: "Hindsight 未配置：memory 模块配置缺少 hindsightMcpUrl" };

  const memberId = await resolveMemberId(ctx);
  if (!memberId) return { ok: false, error: "Failed to resolve member ID" };

  const mcpConfig = {
    type: "remote" as const,
    url: `${config.url}/mcp/${memberId}`,
  };

  // 创建/更新 mcpServer 表记录（幂等）：系统托管服务器由系统路径写入，不经过用户授权。
  await deps.registerSystemMcpServer({
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
    throw new Error("Hindsight 未配置：memory 模块配置缺少 hindsightMcpUrl");
  }
  return fetch(`${config.url}${path}`, options);
}
