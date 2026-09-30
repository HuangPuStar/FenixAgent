/**
 * Machine 注册表的资源应用 Facade：`route → Facade → Domain Service → Repository` 的应用入口。
 *
 * 立这一层之前的形态是：`/web/registry/machines*` 路由把宿主认证上下文（含 `role` / `memberships` 等身份
 * 语义）原样交给 `services/registry`，服务自己从其中两个字段推导归属谓词。那让「以什么身份、什么范围读」
 * 这件应用层决策沉到领域层，也让持久层看到身份数据。现在拆成两半：
 *   - **本层**：把 actor 换成显式范围（{@link MachineScope}），只取用到的两个字段；
 *   - **领域服务**：只收显式范围与领域输入，不认识 actor（§3.2）。
 *
 * 授权来源：`machine` 不在五张受控资源主表之列（无 `visibility`），因此不接 `@fenix/access-control`，
 * 包内也不复制组织/角色规则。它的租户边界是「会话守卫已认证的 active organization」——由宿主
 * `apps/server` 的 `/web` 认证插件保证（本包只消费 `store.authContext`）；本层把该组织与当前用户落成每条
 * 查询的归属谓词，因此跨组织、跨属主的机器不可能被读到或改到。角色不参与判断：同组织成员对机器记录的
 * 操作权限相同，这与迁移前逐条一致，不新增也不放宽——迁移前服务也从未读过 `role`，它只是随整个上下文
 * 一起传下去的死字段，故不再进入本层类型。
 *
 * 失败语义与迁移前逐条一致，本层不吞错、不改写：不存在或不可见时 `get` 返回 `null`（路由映射 404），
 * `update` / `remove` 抛出领域服务给出的 `Error`（消息里带 `not found`，由路由映射 404）。
 */

import type { machine, registryEvent } from "@fenix/resource-machine/db";
import {
  createMachine,
  deleteMachine,
  getMachine,
  listEvents,
  listMachines,
  updateMachine,
} from "../services/registry";
import type {
  MachineCreateInput,
  MachineListFilters,
  MachineScope,
  MachineUpdateInput,
} from "../types/machine-registry";

type MachineRow = typeof machine.$inferSelect;
type RegistryEventRow = typeof registryEvent.$inferSelect;

/**
 * 本 Facade 接受的最小主体投影。
 *
 * 只取用到的两个字段，不 import 宿主 `AuthContext`（那是 `apps/server` 协议层的类型，包一旦依赖它就无法
 * 独立构建）：组织边界来自 `organizationId`（当前 active organization），属主边界来自 `userId`。宿主的
 * `AuthContext` 是它的结构超集，调用点无需转换；`role` / `memberships` 不进入本层判断。
 */
export interface MachineActor {
  readonly organizationId: string;
  readonly userId: string;
}

/**
 * Machine 注册表的应用接口（Facade 的契约面）。
 *
 * 路由只依赖这组方法，用例可以提供实现而不触达真实数据库。方法的入参是 actor 与协议已校验的请求数据，
 * 组织与属主范围由实现内部推导——调用方无法通过请求体影响自己读到哪个组织的机器。
 */
export interface MachineRegistryFacadeApi {
  /** 当前组织与当前用户可见的机器列表（含系统/组织级机器），支持状态、类型、标签与分页过滤。 */
  list(actor: MachineActor, filters: MachineListFilters): Promise<{ data: MachineRow[]; total: number }>;
  /** 读取单台机器及其近期事件；不可见或不存在返回 `null`（两者不可区分，不给出可探测的差异）。 */
  get(actor: MachineActor, id: string): Promise<(MachineRow & { recentEvents: RegistryEventRow[] }) | null>;
  /** 指定机器的注册事件历史；机器不可见时返回空分页，不泄漏其生命周期数据。 */
  listEvents(
    actor: MachineActor,
    machineId: string,
    opts: { limit: number; offset: number },
  ): Promise<{ data: RegistryEventRow[]; total: number }>;
  /** 预创建机器记录（`status=pending`）；组织取 actor，机器归属组织而非个人（`userId=null`）。 */
  create(
    actor: MachineActor,
    params: MachineCreateInput,
  ): Promise<{ id: string; name: string; status: "pending"; initCommand: string }>;
  /** 更新机器的名称、标签与引擎类型；不可见或不存在时抛错（消息含 `not found`，由路由映射 404）。 */
  update(actor: MachineActor, id: string, params: MachineUpdateInput): Promise<MachineRow>;
  /** 删除机器（在线与被引用时由领域服务拒绝）；不可见或不存在时抛错。 */
  remove(actor: MachineActor, id: string): Promise<{ deleted: true }>;
}

/**
 * 把 actor 缩成服务需要的归属范围。
 *
 * 刻意**重新构造**这个最小对象，而不是把宿主认证上下文原样下传：持久层不应看到 `role` / `memberships`
 * 之类的身份语义（即使当前实现只读其中两个字段）。
 */
function scopeOf(actor: MachineActor): MachineScope {
  return { organizationId: actor.organizationId, userId: actor.userId };
}

/** 进程级无状态实现：Facade 不持有连接、缓存或 actor，每次调用只用入参推导范围。 */
export const machineRegistryFacade: MachineRegistryFacadeApi = {
  list: (actor, filters) => listMachines(scopeOf(actor), filters),

  get: (actor, id) => getMachine(scopeOf(actor), id),

  listEvents: (actor, machineId, opts) => listEvents(scopeOf(actor), machineId, opts),

  create: (actor, params) => createMachine(actor.organizationId, params),

  update: (actor, id, params) => updateMachine(scopeOf(actor), id, params),

  remove: (actor, id) => deleteMachine(scopeOf(actor), id),
};
