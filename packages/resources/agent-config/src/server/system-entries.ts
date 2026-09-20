import type { ActorContext } from "@fenix/platform-sdk";
import type { AgentConfigRow, ScopedAgentConfigRow } from "./repositories/agent-config-resource";
import { getAgentConfigModule } from "./runtime";
import type { AgentConfigDetailWithAccess } from "./services/config/types";

/**
 * AgentConfig 的**进程级系统入口**：不经授权谓词、或按"组织可见性"读，供已完成归属校验的非请求
 * 路径使用。
 *
 * 与 `facade` 的分工是刻意的：`facade` 的每个方法都要求一个可信 `ActorContext` 且必须走授权栈；
 * 本文件的三个入口分别对应三类系统场景，调用方写出函数名即可看出自己拿的是哪一种权限。
 *
 * - {@link getAgentConfigById}：**无授权**读取（LaunchSpec 构建、Observer 展示、acp-ws 归属解析、
 *   站点绑定校验）。这些路径已经持有环境 / 实例 ID 并校验过归属，再要求一个 actor 只会导致调用方
 *   伪造身份。
 * - {@link getReadableAgentConfigById}：**按组织可见性**读取，语义与迁移前的 `canReadResource`
 *   一致（归属组织相同，或资源对其他组织公开可读），主体由调用方给出。
 * - {@link getAgentConfigVisibleToUser}：同样是**按组织可见性**读取，但主体由本入口按 `userId` +
 *   组织自行构成（真实成员关系），适用于手上只有 ID 的系统流程（§9.1）。
 *
 * 前两个都不接受宿主的 `AuthContext`：主体转换（宿主 `toActorContext`）属宿主边界，包侧只接收已经
 * 转换好的 `ActorContext`（§6.4「`toActorContext` → 宿主边界转换」）。调用方原本持有 `AuthContext`
 * 时，转换点应收敛在调用方一侧，本包不替它解释 `role` 与成员关系；第三个入口连 actor 都不收，
 * 由本包用身份目录还原真实主体（这正是它存在的理由，见其函数注释）。
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
 * （`publicDefaultActions` 含 `read`），因此即便 `actor` 里的角色信息来自调用方构造，本路径也不会
 * 授予超出"读"的能力。调用方必须传入宿主边界已转换的 `ActorContext`：没有 `activeOrganizationId`
 * 或没有对应成员关系的主体读不到任何组织资源（`facade.getById` 按 `scope` 判定）。
 */
export async function getReadableAgentConfigById(
  actor: ActorContext,
  id: string,
): Promise<AgentConfigDetailWithAccess | null> {
  const authorized = await getAgentConfigModule().facade.getById(actor, id);
  return authorized ?? null;
}

/** 组织范围读的输入：真实用户 + 该用户此刻所处的组织，没有 actor 槽位（见下）。 */
export interface AgentConfigVisibleToUserInput {
  readonly agentConfigId: string;
  readonly organizationId: string;
  readonly userId: string;
}

/**
 * 按**真实用户身份**的组织可见性读取 Agent 配置行（§9.1）。
 *
 * 语义与 {@link getReadableAgentConfigById} 完全一致——判定规则来自 `AccessControlModule` 的 `read`
 * 谓词，没有第二份「同组织或 public」的手写规则；差别只在**身份从哪来**：调用方只交出 `userId` 与
 * 组织，本入口用 `IdentityDirectory.listMemberships(userId)` 取全量成员关系自己拼 `ActorContext`。
 *
 * 为什么不让调用方传 actor：调用这条路径的是「实例起来之前」的系统流程（LaunchSpec 构建、环境绑定
 * 校验、实例自动建环境），它们手上只有 environmentId / agentConfigId，没有会话身份。要求它们构造
 * actor 的后果是**伪造**——迁移前那四处传的是硬编码 `role: "owner"`，读出来的行虽然一样（`read`
 * 在 `memberDefaultActions` 内），但 `access.actions` 会虚高成全量动作，是个定时炸弹（review §9.1）。
 * 因此这里取真实的成员关系，并且只返回资源行：`access` 是给持有 actor 的协议层用的，系统路径不回传。
 *
 * **行为差异（有意）**：成员关系已被移除的用户读不到该组织的私有配置（判断落到公开受众那一条），
 * 而伪造 `owner` 的旧实现会无条件放行。这与 `apps/server/src/services/model-gateway-subject-verification.ts`
 * 的 `MEMBERSHIP_NOT_FOUND` 同一口径：「还能不能用这个 Agent」必须反映当前身份，不能靠调用方声明。
 */
export async function getAgentConfigVisibleToUser(
  input: AgentConfigVisibleToUserInput,
): Promise<ScopedAgentConfigRow | null> {
  const module = getAgentConfigModule();
  const memberships = await module.identity.listMemberships(input.userId);
  const actor: ActorContext = {
    kind: "user",
    userId: input.userId,
    activeOrganizationId: input.organizationId,
    memberships,
  };
  return (await module.facade.findReadableRowById(actor, input.agentConfigId)) ?? null;
}
