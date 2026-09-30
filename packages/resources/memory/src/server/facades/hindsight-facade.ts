/**
 * Hindsight 记忆域的资源应用 Facade：`route → Facade → Domain Service` 的应用入口。
 *
 * 迁移前的形态是：`/web/hindsight/**` 的 17 个端点各自把宿主 `store.authContext` 整个对象交给
 * `services/hindsight` 的 `resolveMemberId()`，由领域服务经 `IdentityDirectory` 解析成员、把结果当 bank
 * ID 用，路由再据此决定 403。那让「以什么身份访问哪个 bank」这件应用层决策落在领域层，也让 17 处各写
 * 一遍 403 分支。
 *
 * 本层承接三件事（§3.2）：
 *   1. **actor → bank**：成员关系（组织 + 用户）唯一决定 bank ID，解析不出即拒绝；
 *   2. **拒绝语义**：无法映射到 bank 时抛 `ForbiddenError`，由路由映射 403 且不访问上游；
 *   3. **跨资源编排**：把请求代理到 actor 自己的 bank（地址前缀由本层与上游路径拼装）。
 *
 * 隔离依据：bank 的隔离维度只有「当前组织 + 当前用户」，两者都取自 actor，路由与请求数据都无法影响它
 * ——同一个 Hindsight 主机上，他人 bank 的记忆、文档、心智模型与实体在 URL 层面不可能被访问到。bankId
 * 本身是既有外部约定（Hindsight 的成员 ID），不是判据；成员关系读取唯一经 `IdentityDirectory`，本包不得
 * 直接查身份表。
 *
 * 失败语义：与迁移前逐条一致，本层不吞错、不改写——上游不可达或未配置时由 `proxyToHindsight` 抛出，
 * 由路由映射 503；只有「解析不出 bank」是本层新增的拒绝信号。
 */

import { ForbiddenError } from "@fenix/platform-sdk";
import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import { getHindsightConfig, proxyToHindsight } from "../services/hindsight";

/**
 * 本 Facade 接受的最小主体投影。
 *
 * 刻意不引用宿主 `@server/plugins/auth` 的 `AuthContext`（该类型属宿主内部实现，包一旦依赖就无法
 * 独立测试与构建）。结构化声明让宿主的 `store.authContext` 直接可传，同时把本包对调用方的要求
 * 收窄到「组织 + 用户」——bank 的隔离维度只有这两个。
 */
export interface HindsightActor {
  readonly organizationId: string;
  readonly userId: string;
}

/** `/web/hindsight/status` 的领域结论：未启用时只有一个布尔，启用时给出地址与当前 actor 的 bank。 */
export type HindsightStatus =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly url: string; readonly bankId: string | null };

/** Hindsight 的应用接口（Facade 的契约面）。路由只依赖这组方法。 */
export interface HindsightFacadeApi {
  /**
   * 读取 Hindsight 的可用状态。
   *
   * 未认证（`actor` 为 null）时只报告启用状态、bankId 为 null——路由由 `sessionAuth` 保证已认证，这里保留
   * 迁移前对缺失上下文的防御，不把它升格成错误。
   */
  status(actor: HindsightActor | null): Promise<HindsightStatus>;
  /**
   * 把请求代理到 actor 自己的 bank 下的相对路径。
   *
   * `path` 是 bank 之后的相对路径（含 query），由路由从路径参数与 query 拼装；bank 前缀由本层拼装，
   * 调用方无法影响访问哪个 bank。解析不出 bank 时抛 `ForbiddenError`。
   */
  proxy(actor: HindsightActor, path: string, options?: RequestInit): Promise<Response>;
}

/** bank 地址前缀：`/v1/default/banks/{bankId}`，bankId 编码后拼接（与其他路径段同口径）。 */
function bankPath(bankId: string): string {
  return `/v1/default/banks/${encodeURIComponent(bankId)}`;
}

/**
 * 解析组织成员在 Hindsight 侧的 bank ID（= 组织成员 ID）。
 *
 * 为什么导出：记忆包的**第二个应用层消费者**是 agent 启动参数装配（`@fenix/resource-agent-config` 的
 * `agent-launch-spec/memory-env`）——它要把同一个 bank ID 注入 opencode 插件参数与 `HINDSIGHT_BANK_ID`。
 * 两处各写一份「成员 → bank」的映射，改口径（例如以后按实例而非按成员分 bank）时会静默分叉，因此唯一
 * 实现放在应用层这里。领域服务不再碰身份目录（§3.2「Domain Service 不接受 actor」）。
 *
 * 只做映射、不做授权：解析不出（非当前组织成员）返回 null，由调用方决定语义——门面据此抛
 * `ForbiddenError` 拒绝，启动参数装配据此把记忆退化为「不区分 bank」。
 */
export async function resolveMemberId(scope: {
  readonly organizationId: string;
  readonly userId: string;
}): Promise<string | null> {
  const membershipId = await getIdentityDirectory().resolveMembershipId({
    organizationId: scope.organizationId,
    userId: scope.userId,
  });
  return membershipId ?? null;
}

/** 进程级无状态实现：Facade 不持有连接、缓存或 actor，每次调用只用入参推导 bank。 */
export const hindsightFacade: HindsightFacadeApi = {
  async status(actor) {
    const config = getHindsightConfig();
    if (!config) return { enabled: false };
    return { enabled: true, url: config.url, bankId: actor ? await resolveMemberId(actor) : null };
  },

  async proxy(actor, path, options) {
    const bankId = await resolveMemberId(actor);
    // 无成员映射不退化到共享或用户级 bank：拒绝而不是猜一个可写地址（既有 403 语义）。
    if (!bankId) throw new ForbiddenError("Cannot resolve bank ID");
    return proxyToHindsight(`${bankPath(bankId)}${path}`, options);
  },
};
