/**
 * 沙盒资源池的资源应用 Facade：`route → Facade → Domain Service → Repository` 的应用入口。
 *
 * 立这一层之前的形态是：`/web/config/sandbox-pools` 的处理器自己读模块配置、把 `authCtx.organizationId`
 * 拆出来当位置参数传给领域服务。那让「以什么身份、什么范围读」这件应用层决策留在协议层，也让
 * 「沙盒未启用」这条状态判断与资源池可见范围分别落在两个文件里。
 *
 * 现在拆成两半：
 *   - **本层**：从 actor 取出组织、读取模块配置里的启用开关，决定「这次请求读哪个范围」；
 *   - **领域服务**（`../services/sandbox-admin-service`）：只收显式参数（组织 ID、启用开关、读取入口），
 *     处理「可读资源池 = 全局池 ∪ 本组织池」与 DTO 裁剪，不认识 actor，也不做用户权限判断。
 *
 * 授权来源：沙盒资源池不在五张受控资源主表之列（没有 `visibility`），因此本包不接
 * `@fenix/access-control`、也不复制组织规则。它的租户边界是「会话守卫已认证的 active organization」——
 * 由宿主 `apps/server` 的 `/web` 认证插件保证，本层把该组织落成读取范围，所以跨组织读不到别组织的私有
 * 池；全局池（`organizationId = null`）对所有组织可读，那是资源池自身的领域语义，不是授权放宽。
 *
 * 范围仅此一处：`/api/system/sandbox-*` 三条系统管理端点由系统 API key 守卫、按显式 `organization_id`
 * 读取**全部**资源池（含不可读池），属于系统管理面而不是本门面（`actor` 概念在那里不成立），故不并入。
 *
 * ## 系统管理面绕过本门面的登记（§10.7.4）
 *
 * - **豁免内容**：`../routes/api/sandbox.ts` 10 条（`/api/system/sandbox-pools`、`/sandbox-pools/:poolId`、
 *   `/sandbox-instances`、`/sandbox-instances/:instanceId`、`/sandbox-instances/rebuild`）、
 *   `../routes/api/sandbox-cluster.ts` 13 条（`/api/system/sandbox-cluster/pools[/:poolId]`、
 *   `.../servers[/:serverId]`、`.../servers/:serverId/{health-check,tunnel,tunnel/frpc.toml}`）、
 *   `../routes/api/sandbox-server.ts` 4 条（`/api/system/sandbox-server/servers/:serverId/sandboxes[/:sandboxId]`、
 *   `.../diagnostics`、`.../commands`），共 27 条路由**跳过本 Facade**，直接调用
 *   `../services/sandbox-admin-service`（领域服务，含仓储读取）与 cluster 侧的两个客户端服务
 *   （`sandbox-cluster-admin-service` / `sandbox-server-admin-service`，出网到 OpenSandbox Cluster，不读本包 DB）。
 *   绕过的层是本层（范围决策），不是领域服务。实测补充：这三个路由文件都不 import db 或 `../repositories/**`，
 *   也不在本层解释组织 / 用户归属（文件内无 `organizationId` / `userId` / `authContext` 取值）；作用范围由调用方
 *   以**显式参数**声明（查询 `organization_id`、请求体 `organizationId`、重建 `userIds`），不从会话推导。
 * - **依据**：这些端点的认证是宿主的 `systemApiAuthPlugin`（`RCS_SYSTEM_API_KEYS`，Bearer 或 `?token=`），该守卫
 *   刻意不恢复用户 / 组织上下文（`apps/server/src/plugins/system-api-auth.ts`），因此**没有 actor 可以传给本层**
 *   ——`listOptions` 要求的 `SandboxPoolActor` 在系统面上无法构造，硬接只能伪造主体。调用方是平台运维者而不是
 *   某个用户，凭据本身就是判据，与 observer 的 `/api/system/logs`、plugin-market 管理面同类。两面的可见范围语义
 *   因此不同且不可互换：用户面恒为「全局池 ∪ actor 的组织」，系统面是调用方声明的范围（不限组织、含不可读池）；
 *   把后者并入前者会得到一个没有任何组织真正拥有的读口径。
 * - **owner**：`@fenix/resource-sandbox` 的 `/api/system/*` 系统管理面（`src/server/routes/api/**` 三个文件）。
 *   本层 owner 仍是 `/web/config/sandbox-pools` 这一条用户面路由；两面不共享范围决策。
 * - **移除条件**：下列任一成立时本豁免消失，27 条路由改为经本包 Facade（届时须为无 actor 的系统面新增入口）——
 *   ① 这些端点改为面向普通用户会话（必带 actor，也必然要判归属）；② 平台定下「系统面与用户面共用同一门面」的
 *   统一契约。在此之前，系统面新增的每一条范围解释都要回到本条复核。
 *
 * 本节是代码侧的裁定摘要；§10.7.4 要求的登记正文在 `docs/design/ce-ee-refactoring/boundary-exemptions.md`
 * 第 2 行「Sandbox `/api/system/*` 系统管理面绕过本包 Facade」。改本节的结论时必须同步那一行——代码文件头
 * 只是摘要，不是登记本身。
 *
 * 失败语义：与领域服务一致——配置缺失或格式错误时 `getSandboxConfig()` 抛错，本层不吞、不包装。
 */

import type { SandboxPool } from "@fenix/resource-sandbox/db";
import { getSandboxConfig } from "../config";
import { listReadableSandboxPools } from "../repositories/sandbox-pool-repository";
import { listPoolOptions } from "../services/sandbox-admin-service";

/**
 * 本 Facade 接受的最小主体投影。
 *
 * 只取用到的那个字段，不 import 宿主 `AuthContext`（那是 `apps/server` 协议层的类型，包一旦依赖它
 * 就无法独立构建）：资源池的可见范围只由组织决定，`userId` 与 `role` / `memberships` 都不参与判断。
 * 宿主的 `AuthContext` 是它的结构超集，调用点无需转换。
 */
export interface SandboxPoolActor {
  readonly organizationId: string;
}

/** 控制台可选的资源池：`enabled=false` 表示本部署没有开启沙盒能力。 */
export interface SandboxPoolOptions {
  readonly enabled: boolean;
  readonly pools: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}

/**
 * 沙盒资源池的应用接口（Facade 的契约面）。
 *
 * 路由只依赖这组方法；用例可以注入读取入口而不触达真实数据库。组织范围由实现内部推导——调用方无法
 * 通过查询串影响自己读到哪个组织的资源池。
 */
export interface SandboxPoolFacade {
  /** 列出 actor 所在组织可选用的资源池（全局池 ∪ 本组织池）；沙盒未启用时返回空选项。 */
  listOptions(actor: SandboxPoolActor): Promise<SandboxPoolOptions>;
}

/**
 * 本 Facade 的注入点。
 *
 * 只暴露「可读资源池从哪读」这一个决定：它同时是可见范围的表达（组织 → 全局池 ∪ 本组织池）与用例的
 * 替身切口；缺省是包内仓储，与领域服务的缺省参数同义，因此生产路径上不存在第二份读取实现。
 */
export interface SandboxPoolFacadeDeps {
  readonly listReadablePools?: (organizationId: string) => Promise<SandboxPool[]>;
}

/**
 * 创建 Facade 实例。
 *
 * 启用开关在**调用时**从模块配置读取，而不是在模块加载期固化：宿主可能尚未完成基础设施初始化
 * （与路由直接读取时的理由相同，见 `../config` 的 `getSandboxConfig`）。
 */
export function createSandboxPoolFacade(deps: SandboxPoolFacadeDeps = {}): SandboxPoolFacade {
  const { listReadablePools = listReadableSandboxPools } = deps;
  return {
    listOptions: async (actor) =>
      listPoolOptions(actor.organizationId, getSandboxConfig().sandboxEnabled, listReadablePools),
  };
}

/** 生产实现：进程级无状态，不持有连接、缓存或 actor，每次调用只用入参推导范围。 */
export const sandboxPoolFacade: SandboxPoolFacade = createSandboxPoolFacade();
