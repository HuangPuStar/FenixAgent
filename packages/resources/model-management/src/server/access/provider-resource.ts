import { provider } from "@fenix/model-management/db";
import type { ResourceRegistration } from "@fenix/platform-sdk";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * Provider 的资源注册：语义定义 + 物理绑定。
 *
 * 归属列直接在主表（`organization_id` / `user_id` / `visibility`），因此创建期归属由
 * `AccessControlModule.resolveInitialScope` 解析后与 INSERT 同批写入，不需要 side-table 初始化。
 *
 * 动作收敛（决策 D1）：member 只拿到 `read`，创建、修改、删除与公开受众设置属于 owner 与 admin；
 * `public` 只放大读范围，不提升写权限。资源包只声明这份语义与列，授权判断与 SQL 由注入的
 * `AccessControlModule` 产出。
 *
 * 不声明 `use`：Provider 没有独立的"运行"语义——运行发生在 Agent 上（`agent_config` 的 `use`），
 * Provider 只是被 LaunchSpec 读取的配置行，而该读取是系统路径（见 `@fenix/agent-config` 的
 * `server/services/agent-launch-spec/model-resolution.ts`）。
 *
 * 这是本包唯一的授权聚合根（决策 D6）：Model 是 Provider 的子表，不注册独立资源、不建 owner /
 * visibility，其读写一律先对 Provider 授权（见 `provider-facade.ts` 的 `listModels` / `addModel`）。
 */

/** 受控资源类型；与旧 `resource_permission.resource_type` 的取值一致（S6 删除旧表）。 */
export const PROVIDER_RESOURCE_TYPE = "provider";

export const providerResource = {
  definition: {
    type: PROVIDER_RESOURCE_TYPE,
    ownershipMode: "organization",
    actions: ["read", "create", "update", "delete"],
    memberDefaultActions: ["read"],
    publicDefaultActions: ["read"],
  },
  storage: {
    resourceType: PROVIDER_RESOURCE_TYPE,
    table: provider,
    columns: {
      id: provider.id,
      organizationId: provider.organizationId,
      ownerUserId: provider.userId,
      visibility: provider.visibility,
    },
  },
} satisfies ResourceRegistration<typeof provider, PgColumn>;
