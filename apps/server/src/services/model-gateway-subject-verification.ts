/**
 * 模型网关主体的复验端口实现（宿主装配层）。
 *
 * `model-management` 声明了窄端口 `SubjectVerificationPort`，但不依赖身份、授权实现与 `agent_config`
 * 资源定义；本文件把三者接起来：
 *
 *   - 身份存在性与成员关系来自 `IdentityDirectory`；
 *   - `agent_config` 行的归属来自该资源包的**系统读取**（无授权，仅用于区分"不存在"与"存在但越权"）；
 *   - "这个用户现在还能不能用这个 Agent"来自 `AccessControlModule.authorize` 的 `use` 动作——与
 *     平台其它入口判定 agent_config 可用性的是同一条规则。
 *
 * 为什么归在 `apps/server/src/services/`：它是宿主对资源包端口的适配，不是资源包的领域逻辑，也不是
 * 路由。放在装配层可以让"谁实现端口"在目录上直接可查。
 */

import { agentConfigResource } from "@fenix/agent-config/server";
import type { SubjectVerificationInput, SubjectVerificationPort } from "@fenix/model-management/server";
import {
  type AccessControlModule,
  type ActorContext,
  type IdentityDirectory,
  ResourceAccessDeniedError,
} from "@fenix/platform-sdk";

export interface ModelGatewaySubjectVerificationDeps {
  readonly accessControl: AccessControlModule;
  readonly identity: IdentityDirectory;
  /**
   * 读取 `agent_config` 行的归属组织；不存在时返回 `undefined`。
   *
   * 必须是无授权读取：这一步只回答"这行是否存在于该组织"，权限判断紧随其后统一走
   * `accessControl.authorize`，因此这里读到的结果不能作为放行依据。
   */
  readonly findAgentConfigOrganization: (agentConfigId: string) => Promise<string | undefined>;
}

/**
 * 构造主体复验端口。
 *
 * 判定顺序与迁移前一致（用户 → 组织 → 成员 → Agent 存在性 → 授权），因此同一种失效仍然报告同样的
 * 原因——凭据吊销检测据此决定"删除上游凭据"还是"保留映射等待权限恢复"，改变顺序会让处置方式漂移。
 *
 * 只有 `ResourceAccessDeniedError` 被映射为 `AGENT_ACCESS_REVOKED`；其余异常（数据库不可用、连接超时
 * 等）原样上抛，让调用方以失败告终而不是把基础设施故障伪装成"权限已被收回"。
 */
export function createModelGatewaySubjectVerification(
  deps: ModelGatewaySubjectVerificationDeps,
): SubjectVerificationPort {
  return {
    async verify(input: SubjectVerificationInput) {
      const { organizationId, userId, agentConfigId } = input;

      const user = await deps.identity.getUser(userId);
      if (!user) return { valid: false, reason: "USER_NOT_FOUND" } as const;

      const organization = await deps.identity.getOrganization(organizationId);
      if (!organization) return { valid: false, reason: "ORGANIZATION_NOT_FOUND" } as const;

      // 一次取全量成员关系：既判定成员资格，又用于构造 actor（actor 的 memberships 是身份投影的
      // 全量快照；这里的 active organization 就是被校验的 organizationId）。
      const memberships = await deps.identity.listMemberships(userId);
      if (!memberships.some((membership) => membership.organizationId === organizationId)) {
        return { valid: false, reason: "MEMBERSHIP_NOT_FOUND" } as const;
      }

      const ownerOrganizationId = await deps.findAgentConfigOrganization(agentConfigId);
      if (ownerOrganizationId !== organizationId) return { valid: false, reason: "AGENT_NOT_FOUND" } as const;

      const actor: ActorContext = {
        kind: "user",
        userId,
        activeOrganizationId: organizationId,
        memberships,
      };
      try {
        await deps.accessControl.authorize({
          actor,
          action: "use",
          resource: agentConfigResource.definition,
          resourceId: agentConfigId,
        });
      } catch (error) {
        if (error instanceof ResourceAccessDeniedError) {
          return { valid: false, reason: "AGENT_ACCESS_REVOKED" } as const;
        }
        throw error;
      }

      return { valid: true } as const;
    },
  };
}
