/**
 * 机器注册表的显式输入契约：归属范围、列表过滤与创建/更新输入。
 *
 * 为什么单独成文件：这些类型同时被 Facade（对外入口）与 Domain Service（领域实现）引用，写在任一侧都会
 * 让另一侧反向依赖；而 `services/registry.ts` 已接近单文件上限（CLAUDE.md 的 500 行），把契约塞回去会顶
 * 破上限。本文件只有类型，运行时不产生依赖。
 *
 * 可见性为什么由「组织 + 用户」共同决定：同一组织内，`user_id IS NULL` 的系统/组织级机器对全组织可见，有
 * 属主的机器只对属主可见。列表与单资源动作必须派生自同一份条件（§4.1），因此两者成对传递，不拆成两个
 * 位置参数——漏传一侧就会把可见范围放大到整组织或整库。
 */

/** 机器归属范围：由 Facade 从 actor 推导后传入，服务只收显式范围、不认识 actor（§3.2）。 */
export interface MachineScope {
  readonly organizationId: string;
  readonly userId: string;
}

/** 机器列表过滤条件：协议层已解析为领域取值，缺省字段表示不过滤。 */
export interface MachineListFilters {
  readonly status?: "online" | "offline";
  readonly type?: "machine" | "sandbox" | "all";
  readonly labels?: readonly string[];
  readonly limit?: number;
  readonly offset?: number;
}

/** 机器创建输入；组织归属与创建者由 Facade 从 actor 推导，请求体里的同名值不被采信。 */
export interface MachineCreateInput {
  readonly name: string;
  readonly labels?: readonly string[];
  readonly agentName?: string;
}

/** 机器更新输入；未提供的字段保持原值。 */
export interface MachineUpdateInput {
  readonly name?: string;
  readonly labels?: readonly string[];
  readonly agentName?: string;
}
