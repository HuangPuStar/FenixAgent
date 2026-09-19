import type { AuthContext } from "@server/plugins/auth";
import { toActorContext } from "@server/plugins/auth";
import type { AgentConfigRow } from "./repositories/agent-config-resource";
import { getAgentConfigModule } from "./runtime";
import type { AgentConfigDetailWithAccess } from "./services/config/types";

/**
 * AgentConfig 的**进程级系统入口**：不经授权谓词、或按"组织可见性"读，供已完成归属校验的非请求
 * 路径使用。
 *
 * 与 `facade` 的分工是刻意的：`facade` 的每个方法都要求一个可信 `ActorContext` 且必须走授权栈；
 * 本文件的两个入口分别对应两类系统场景，调用方写出函数名即可看出自己拿的是哪一种权限。
 *
 * - {@link getAgentConfigById}：**无授权**读取（LaunchSpec 构建、Observer 展示、acp-ws 归属解析、
 *   站点绑定校验）。这些路径已经持有环境 / 实例 ID 并校验过归属，再要求一个 actor 只会导致调用方
 *   伪造身份。
 * - {@link getReadableAgentConfigById}：**按组织可见性**读取，语义与迁移前的 `canReadResource`
 *   一致（归属组织相同，或资源对其他组织公开可读）。迁移期兼容入口：宿主与 agent-runtime 中多处
 *   调用点仍以 `AuthContext` 形式传上下文，本函数把转换收敛在一处（`toActorContext`），1.2 不改造
 *   那些调用方；它们全部只用于读，不构成权限提升。
 */

/**
 * 按资源 ID 无授权读取 Agent 配置行。
 *
 * `organizationId` 传入时同时校验归属：环境绑定 / 站点绑定这类场景需要一个"这个 Agent 确实属于当前
 * 组织"的判定，用参数表达比让调用方读到行之后自己比较更不容易漏。
 */
export async function getAgentConfigById(id: string, organizationId?: string): Promise<AgentConfigRow | null> {
  const row = await getAgentConfigModule().service.findRowUnscoped(id);
  if (!row) return null;
  if (organizationId !== undefined && row.organizationId !== organizationId) return null;
  return row;
}

/**
 * 按资源 ID 读取当前主体可读的 Agent 配置。
 *
 * 读动作对所有成员开放（`memberDefaultActions` 含 `read`），公开资源对所有已认证用户开放
 * （`publicDefaultActions` 含 `read`），因此即便 `ctx` 里的角色信息来自调用方构造，本路径也不会
 * 授予超出"读"的能力。
 */
export async function getReadableAgentConfigById(
  ctx: AuthContext,
  id: string,
): Promise<AgentConfigDetailWithAccess | null> {
  const authorized = await getAgentConfigModule().facade.getById(toActorContext(ctx), id);
  return authorized ?? null;
}
