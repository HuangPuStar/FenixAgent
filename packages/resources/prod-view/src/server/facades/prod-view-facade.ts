/**
 * ProdView 的资源应用 Facade：`route → Facade → Domain Service → Repository` 的应用入口。
 *
 * 立这一层之前的形态是：路由把会话认证上下文直接交给领域服务，服务自己从 `organizationId` / `userId`
 * 推导查询范围与写入归属。那让「以什么身份、什么范围读」这件应用层决策沉到了领域层，也让路由与领域
 * 服务的分工按字段而不是按职责划分。现在拆成两半：
 *   - **本层**：把 actor 换成显式范围（`organizationId` / `userId`），并决定公开读取端点要做什么校验；
 *   - **领域服务**：只收显式参数，处理资源自身规则与数据访问，不认识 actor。
 *
 * 授权来源：ProdView 不在五张受控资源主表之列（无 `visibility`），因此不接 `@fenix/access-control`，
 * 包内也不复制组织/角色规则。它的租户边界是「会话守卫已认证的 active organization」——由宿主
 * `apps/server` 的 `/web` 认证插件保证（本包只消费 `store.authContext`）；本层把该组织落成每条查询的
 * 组织谓词，所以跨组织读写不可能发生。角色不参与判断：同组织成员对发布视图的管理权限相同，
 * 这与迁移前逐条一致，不新增也不放宽。
 *
 * 失败语义：与领域服务一致的信封（`{ success: false, error: { code, message } }`），由路由映射为
 * 404；不存在或已停用时**不产生副作用**（不创建环境、不创建实例）。本层不吞错、不改写错误码。
 */

import type { ProdViewRow } from "@fenix/resource-prod-view/db";
import type { CreateProdViewInput, UpdateProdViewInput } from "../schemas/prod-view.schema";
import {
  createProdView,
  deleteProdView,
  getProdView,
  listProdViews,
  loadProdView,
  type ProdViewLoadResult,
  type ProdViewResult,
  updateProdView,
} from "../services/prod-view";

/**
 * 本 Facade 接受的最小主体投影。
 *
 * 只取用到的两个字段，不 import 宿主 `AuthContext`（那是 `apps/server` 协议层的类型，包一旦依赖它
 * 就无法独立构建）：组织边界来自 `organizationId`，记录归属与视图载体归属来自 `userId`。宿主的
 * `AuthContext` 是它的结构超集，调用点无需转换；`role` / `memberships` 不进入本层判断。
 */
export interface ProdViewActor {
  readonly organizationId: string;
  readonly userId: string;
}

/**
 * ProdView 的应用接口（Facade 的契约面）。
 *
 * 路由只依赖这组方法；用例可以提供实现而不触达真实数据库。方法的入参是 actor 与协议已校验的请求数据，
 * 组织范围由实现内部推导——调用方无法通过请求体影响自己读到哪个组织的记录。
 */
export interface ProdViewFacadeApi {
  /** 列出当前组织的发布视图，可按 agentId / enabled 过滤。 */
  list(actor: ProdViewActor, filters?: { agentId?: string; enabled?: boolean }): Promise<ProdViewResult<ProdViewRow[]>>;
  /** 读取组织内单个视图；不存在返回 `NOT_FOUND`（跨组织与不存在同形，不给出可探测的差异）。 */
  get(actor: ProdViewActor, id: string): Promise<ProdViewResult<ProdViewRow>>;
  /** 创建视图：组织与创建者取 actor，请求体里的同名值不被采信。 */
  create(actor: ProdViewActor, input: CreateProdViewInput): Promise<ProdViewResult<ProdViewRow>>;
  /**
   * 更新视图；不存在返回 `NOT_FOUND`（先读后写，不在未命中时留下无谓的 UPDATE）。
   *
   * `data` 可能是 `undefined`：先读后写之间记录被并发删除时 UPDATE 不命中，与迁移前一致地回成功信封
   * （不把并发窗口升格成对外可见的 404/409，那是协议变更）。
   */
  update(
    actor: ProdViewActor,
    id: string,
    input: UpdateProdViewInput,
  ): Promise<ProdViewResult<ProdViewRow | undefined>>;
  /** 删除视图；读到了行但删除未命中（并发删除）返回 `DELETE_FAILED`。 */
  remove(actor: ProdViewActor, id: string): Promise<ProdViewResult<{ ok: true }>>;
  /**
   * 加载发布视图（公开读取端点）。
   *
   * 可见性：**同组织**且 `enabled=true`，两者任一不满足即 `NOT_FOUND` / `DISABLED`，且不创建环境与
   * 实例；命中时为**访问者本人**（`actor.userId`）创建环境与持久实例，返回前端连接所需的三元组。
   */
  load(actor: ProdViewActor, id: string): Promise<ProdViewResult<ProdViewLoadResult>>;
}

/** 进程级无状态实现：Facade 不持有连接、缓存或 actor，每次调用只用入参推导范围。 */
export const prodViewFacade: ProdViewFacadeApi = {
  list: (actor, filters) => listProdViews(actor.organizationId, filters),

  get: (actor, id) => getProdView(actor.organizationId, id),

  create: (actor, input) => createProdView(actor.organizationId, actor.userId, input),

  update: (actor, id, input) => updateProdView(actor.organizationId, id, input),

  remove: (actor, id) => deleteProdView(actor.organizationId, id),

  load: (actor, id) => loadProdView(actor.organizationId, actor.userId, id),
};
