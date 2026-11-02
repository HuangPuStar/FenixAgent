/**
 * 宿主为 `@fenix/resource-channel` 提供的 Agent 配置可用性端口（`ChannelAgentConfigLookup`）。
 *
 * 为什么在宿主构造：通道路由要绑定 `agent_config.id`，而「这个 Agent 对谁可用」由 `@fenix/access-control`
 * 与 `@fenix/agent-config` 判定。channel 包既不拥有那张表，也不得复制授权规则，因此只声明端口，宿主把
 * 「通道所有者视角的 actor」翻译成一次复用既有 Facade 的读取。
 *
 * 执行身份是**通道所有者**（`im_channel.userId`），不是发起请求的管理员：IM 消息以所有者身份运行 Agent，
 * 若按管理员权限校验，管理员就能把路由绑到自己可见、所有者不可见的 Agent，故障要到入站消息才暴露。
 *
 * 不缓存结果：每次写入路由都重新判定，所有者的组织角色或 Agent 可见性变化立即生效。
 */

import { getAgentConfigModule } from "@fenix/agent-config/server";
import type { ActorContext } from "@fenix/platform-sdk";
import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import { type ChannelAgentConfigLookup, ChannelAgentConfigUnavailableError } from "@fenix/resource-channel/server";

export function createChannelAgentConfigLookup(): ChannelAgentConfigLookup {
  return {
    async requireUsable(input) {
      // 所有者必须仍是该组织成员；成员关系已撤销时不能以「组织外用户」的身份读到任何 Agent。
      const memberships = await getIdentityDirectory().listMemberships(input.ownerUserId);
      const membership = memberships.find((item) => item.organizationId === input.organizationId);
      if (!membership) throw new ChannelAgentConfigUnavailableError();

      const actor: ActorContext = {
        kind: "user",
        userId: input.ownerUserId,
        activeOrganizationId: input.organizationId,
        memberships: [{ organizationId: input.organizationId, role: membership.role }],
      };

      const config = await getAgentConfigModule().facade.getById(actor, input.agentConfigId);
      if (!config?.access.actions.includes("use")) throw new ChannelAgentConfigUnavailableError();

      return { id: config.id, name: config.name, engineType: config.engineType ?? null };
    },
  };
}
