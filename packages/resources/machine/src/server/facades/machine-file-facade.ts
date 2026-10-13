/**
 * Machine 文件域的资源应用 Facade：`route → Facade → AgentFileService（领域执行面）` 的应用入口。
 *
 * 迁移前的形态是：`/web/environments/:id/fs/*` 路由在处理器里把宿主认证上下文就地拆成
 * `FileAuthContext`（组织 / 用户 / 角色 / 审计身份），执行面（`gate()`）在**每次操作内部**调用
 * `getOwnedEnvironment` 做归属校验。那让两件事错位：身份到范围的转换散在 10 个路由处理器里，而
 * 「谁可以操作这个环境的文件」这件应用层决策落在领域执行面里。
 *
 * 本层做两件事：
 *   1. **授权**：环境必须属于 actor 的当前组织与本人；`role` 为 `member` 时一律拒绝
 *      （`getOwnedEnvironment` 抛 403，fail-closed）；
 *   2. **换成显式范围**：把 actor 换成 {@link AgentFileScope}（环境 + 写操作审计身份）后交给执行面，
 *      执行面不再持有组织/用户/角色。
 *
 * 包内还有一处归属判定消费者：`/web/file-events` 的 WS 订阅帧（逐环境校验订阅者访问权，
 * docs/arch/12-files.md §4.3）。它同样止于本层——路由只做协议校验与订阅建立，经
 * {@link MachineFileFacadeApi.authorizeEventSubscription} 取得判定结果，不自己调用 `getOwnedEnvironment`。
 * 两个入口共用同一份判据（见本文件的 `requireOwnedEnvironment`），差异只在「是否下传角色」这一个维度。
 *
 * 失败语义与迁移前逐条一致：授权失败经 `mapFileError` 映射成文件域错误信封（不存在/跨组织 →
 * `not_found` 404，`member` → `forbidden` 403，其余 → `file_service_unavailable` 503），由路由按同一张
 * 错误码表映射，响应状态码、错误分类与字段均不变。本层不吞错、不改写错误码。
 */

import { getOwnedEnvironment } from "../environment-port";
import { type AgentFileService, createAgentFileService, mapFileError } from "../services/agent-file-service";

/**
 * 本 Facade 接受的最小主体投影。
 *
 * 不 import 宿主 `AuthContext`（那是 `apps/server` 协议层的类型，包一旦依赖它就无法独立构建）；宿主的
 * `AuthContext` 是它的结构超集，调用点无需转换。
 *
 * `role` 参与判定，不是「仅透传」字段：环境归属检查对 `member` 一律拒绝（403 fail-closed）。取值域与
 * `agent-runtime` 的 `EnvironmentRole` 一致；缺省表示调用方未声明角色，此时归属检查只按组织与属主判定
 * （与迁移前 `FileAuthContext.role` 为 `undefined` 时的行为相同）。
 */
export interface MachineFileActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly role?: "owner" | "admin" | "member";
}

/** 文件域的应用接口（Facade 的契约面）。路由只依赖这两个方法。 */
export interface MachineFileFacadeApi {
  /**
   * 授权通过后打开该环境的文件执行面。
   *
   * 逐次调用都会重新做归属与角色校验：执行面的授权边界就是本方法，调用方拿不到「未授权的执行面」。
   * 授权失败抛 `FileServiceError`，与执行期失败同一套分类与文案。
   */
  open(actor: MachineFileActor, environmentId: string): Promise<AgentFileService>;

  /**
   * 授权通过后允许 actor 订阅该环境的文件变更事件（`WS /web/file-events`）。
   *
   * 与 {@link open} 共用同一份归属判定，但**不打开执行面**：订阅是只读观测，把一个可写的文件句柄交给订阅方
   * 只是扩大授权面。判定按读操作语义完成（不下传角色，`member` 可订阅共享环境的变更），理由见本文件
   * `requireOwnedEnvironment` 的说明。
   *
   * 拒绝时抛 `FileServiceError`：不存在 / 跨组织 / 跨属主 → `not_found` 404，需要更高角色的写操作 → `forbidden`
   * 403。路由据 `type` 决定回 `subscribe_error` 帧还是只记日志——分类（而非异常类）是两侧共用的判据，
   * 避免同一个「环境不可见」在执行期与订阅期落进不同分支。
   */
  authorizeEventSubscription(actor: MachineFileActor, environmentId: string): Promise<void>;
}

/**
 * 归属判定的唯一实现：两个入口都经此处，包内不存在第二份判据。
 *
 * `role` 由调用方按**动作语义**决定是否下传，这里不做隐式默认：`undefined` 表示读操作（`member` 放行），
 * `member` 表示需要 owner/admin 的写操作（拒绝）。这条语义归 `getOwnedEnvironment`（owner：agent-runtime），
 * 本层只负责把它的失败换成文件域错误信封。
 */
async function requireOwnedEnvironment(
  actor: MachineFileActor,
  environmentId: string,
  role: MachineFileActor["role"],
): Promise<void> {
  try {
    await getOwnedEnvironment(environmentId, actor.organizationId, actor.userId, role);
  } catch (err) {
    // 授权失败按文件域错误信封上抛：路由的 4xx 映射与执行期失败共用同一张错误码表（§2.4）。
    throw mapFileError(err);
  }
}

/** 进程级无状态实现：Facade 不持有连接、缓存或 actor，每次调用只用入参推导范围。 */
export const machineFileFacade: MachineFileFacadeApi = {
  async open(actor, environmentId) {
    await requireOwnedEnvironment(actor, environmentId, actor.role);
    // 审计身份由本层决定：`/web` 面的写操作主体是当前用户（source=user），执行面只接收结果。
    return createAgentFileService({ environmentId, actorId: actor.userId, source: "user" });
  },
  async authorizeEventSubscription(actor, environmentId) {
    // 读侧入口刻意不下传 `actor.role`：订阅不需要写权限，`member` 也能观察共享环境的变更（迁移前后一致；
    // 与 `open` 的写侧 fail-closed 门槛不对称属既有行为，改动它会让成员静默失去已发布的行为）。
    await requireOwnedEnvironment(actor, environmentId, undefined);
  },
};
