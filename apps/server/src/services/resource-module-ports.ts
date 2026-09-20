/**
 * 宿主为资源模块路由工厂提供的注入端口（CE 阶段 2 任务 1.3）。
 *
 * 资源包的路由改为「工厂 + 注入」后，有三类能力只能落在宿主：
 *
 * 1. **跨包的窄查询**（{@link environmentLookup} / {@link verifyEnvironmentOwnership}）——Environment 的
 *    owner 是 `@fenix/agent-runtime`，通道路由只消费 `id` / `name` / `organizationId` 三个字段，因此按用到
 *    的形状适配，而不是把完整仓储记录透出去（记录字段改名不会波及协议边界）；peri 任务详情路由只需要
 *    「归属校验是否通过」，故只透出校验本身，判据留在 owner 侧。
 * 2. **身份族的 `user_config` 表**（{@link userAgentPreferences} / {@link userModelPreferences}）——
 *    该表的真相来源是 `packages/platform/identity/db/schema.ts`，资源包不得直读；两个适配器把各包
 *    真正读写的偏好子集映射到宿主既有的 `getUserConfig` / `setUserConfig`，同一张表只留一组写入语义。
 * 3. **读宿主 env 的密钥引用解析**（{@link resolveSecretReference}）——`{env:NAME}` 的真相来源是
 *    宿主 `apps/server/src/env.ts`，包内 `src/**` 不得读 `process.env`。
 *
 * 端口集中在宿主服务层构造一次：它们是薄封装、不持有状态，但放在这里既符合 `routes -> services`
 * 的分层，也让「宿主实现了哪些端口」在装配面上一眼可见（`routes/**` 只做接线）。
 */

import type { UserAgentPreferencesPort } from "@fenix/agent-config/server";
import { getBoundAgentRuntime } from "@fenix/agent-runtime/runtime";
import { environmentRepo } from "@fenix/agent-runtime/server";
import type { EnvironmentOwnershipCheck, UserModelPreferencesPort } from "@fenix/model-management/server";
import type { ChannelEnvironmentLookup } from "@fenix/resource-channel/server";
// 经 `@server/services/config` barrel 取，而不是深链 `./config/user-config`：宿主测试的 config 服务替身
// （`apps/server/src/test-utils/setup-mocks.ts`）整体替换的是 barrel，深链会让「不连 DB 的宿主用例」直接
// 打到真实 `user_config` 查询（实测报错 `db.select().from(userConfig)…limit is not a function`）。
import { getUserConfig, setUserConfig } from "@server/services/config";
import type { PermissionConfig } from "./config/types";
import { resolveApiKey } from "./config-utils";

/**
 * 通道路由的 Environment 归属查询。
 *
 * `getById` 返回 `null` 而不是抛错，表示「环境不存在或已被删除」：通道路由据此按「环境不可读」
 * 处理（列表补空名称、写操作拒绝），而不是把它当成查询失败。
 */
export const environmentLookup: ChannelEnvironmentLookup = {
  async getById(id) {
    const record = await environmentRepo.getById(id);
    if (!record) return null;
    return { id: record.id, name: record.name, organizationId: record.organizationId ?? null };
  },
  async listByOrganizationId(organizationId) {
    const records = await environmentRepo.listByOrganizationId(organizationId);
    return records.map((record) => ({ id: record.id, name: record.name }));
  },
};

/**
 * Environment 归属校验（`/web/agents/…/peri-tasks/:taskId/detail` 的注入端口）。
 *
 * 经运行 port 取（`getBoundAgentRuntime()`）而不是直读仓储：归属判据（跨组织与跨用户都按权限语义抛错，
 * 路由据此统一返回 404 隐藏归属差异）只在 port 的实现里，`environmentRepo.getById` 不做这件事。取用放在
 * 调用时而不是模块加载时，宿主测试的 port 替身才能在用例内生效。
 */
export const verifyEnvironmentOwnership: EnvironmentOwnershipCheck = async (environmentId, organizationId, userId) => {
  await getBoundAgentRuntime().getOwnedEnvironment(environmentId, organizationId, userId);
};

/**
 * 用户 Agent 偏好端口（`/web/config/agents` 的「默认 Agent」）。
 *
 * 只读写本包用到的 `defaultAgent` 一列：`user_config` 其余列的 owner 在别处，在这里展开会让端口
 * 跟着它们的语义一起演进。
 */
export const userAgentPreferences: UserAgentPreferencesPort = {
  async read(subject) {
    const data = await getUserConfig(subject);
    return { defaultAgent: data.defaultAgent ?? null };
  },
  async write(subject, patch) {
    // `undefined` = 不改这一项，`null` = 清空：`setUserConfig` 用 `!== undefined` 判定，透传即可。
    await setUserConfig(subject, { defaultAgent: patch.defaultAgent });
  },
};

/** 用户模型偏好端口（`/web/config/models` 的当前模型 / 轻量模型 / 权限配置）。 */
export const userModelPreferences: UserModelPreferencesPort = {
  async read(subject) {
    const data = await getUserConfig(subject);
    return {
      currentModel: data.currentModel ?? null,
      smallModel: data.smallModel ?? null,
      permission: data.permission ?? null,
    };
  },
  async write(subject, patch) {
    await setUserConfig(subject, {
      currentModel: patch.currentModel,
      smallModel: patch.smallModel,
      // 端口把权限对象声明为 `unknown`（宿主权限栈的模型不进资源包的编译面），这里恢复成宿主自己的
      // 类型：写入值本就来自同一条读路径（`read()` 的 `permission`），宿主是它的类型真相来源。
      permission: patch.permission as PermissionConfig | null | undefined,
    });
  },
};

/**
 * 密钥引用解析：复用宿主的 `resolveApiKey`（`{env:NAME}` → `process.env[NAME]`，明文原样返回，
 * 空值 `null`）。包内的密钥提示（`toKeyHint`）经同一实现取值，提示与真实密钥不会出现两套规则。
 */
export const resolveSecretReference = resolveApiKey;
