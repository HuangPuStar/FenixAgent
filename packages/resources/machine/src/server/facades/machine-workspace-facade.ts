/**
 * `/api/environments/:environmentId/workspace/files` 的资源应用 Facade。
 *
 * 迁移前的形态是：路由把宿主认证上下文交给 `services/api-workspace`，由领域服务自己调用
 * `getOwnedEnvironment` 做归属校验。授权止于 Facade（§3.2、§4.1），因此这里把「环境属于谁」的判定
 * 收口到门面，领域服务只接收已授权的环境标识。
 *
 * actor 语义与 `/web` 文件面（`machine-file-facade`）刻意不同：本面是对外稳定 API，迁移前只按组织 +
 * 属主校验（`getOwnedEnvironment` 不传角色），因此这里**不引入**角色门槛——新增 `member` → 403 会改变
 * 已发布契约下的可用性，属行为变更。两侧的差异是既有行为，不是遗漏。
 *
 * 失败语义与迁移前一致：归属失败是 `AppError`（`NOT_FOUND` / 403），由路由的 `/api` 错误映射沿用既有
 * 状态码与错误信封；本层不吞错、不改写。
 */

import { getOwnedEnvironment } from "../environment-port";
import { uploadWorkspaceFiles, type WorkspaceFileUploadResult } from "../services/api-workspace";

/**
 * 本 Facade 接受的最小主体投影。
 *
 * 只有组织与用户两项——它们就是环境隔离的全部维度；宿主 `AuthContext` 是它的结构超集，调用点无需转换。
 */
export interface MachineWorkspaceActor {
  readonly organizationId: string;
  readonly userId: string;
}

/** 工作区上传的应用接口（Facade 的契约面）。 */
export interface MachineWorkspaceFacadeApi {
  /**
   * 把 multipart 文件写入 actor 可见的 environment workspace。
   *
   * 校验顺序与迁移前一致：先归属、后解析表单；环境不可见时不会读取任何文件内容。
   */
  upload(actor: MachineWorkspaceActor, environmentId: string, formData: FormData): Promise<WorkspaceFileUploadResult>;
}

/** 进程级无状态实现：Facade 不持有连接、缓存或 actor，每次调用只用入参推导范围。 */
export const machineWorkspaceFacade: MachineWorkspaceFacadeApi = {
  async upload(actor, environmentId, formData) {
    await getOwnedEnvironment(environmentId, actor.organizationId, actor.userId);
    return uploadWorkspaceFiles(environmentId, formData);
  },
};
