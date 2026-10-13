// web/src/api/system-organizations.ts
// 系统侧组织目录的窄端口：资源池表单需要「资源池归属组织」下拉的候选列表（docs/arch/21 §5）。
//
// 端点 `GET /api/system/people-tree/` 同时返回组织 / 用户 / 智能体三层，本文件只保留
// 选择器真正用到的三个字段，避免把 observer 的视图模型带进 sandbox 的依赖图。
//
// 为什么不直接引用既有实现：该客户端在 `packages/resources/observer/web/api/system-people-tree.ts`，
// observer 今天已登记 `./web` 出口（可经包根入口导入，不必走被门禁禁止的 `src/**` 深链），
// 真正阻止合并的是**包级环**：observer 的 dependencies 已含 `@fenix/resource-sandbox`（其面板经
// `@fenix/resource-sandbox/web` 消费本包的组件与工具函数），本包反向 import observer 会让两个包
// 互相依赖——依赖矩阵不允许，装配与构建顺序也无法确定。
//
// 收敛条件：组织目录的 owner 是 identity（其 `./web` 出口已公开）。identity 暴露系统组织目录
// 客户端后，删除本文件并把调用方改指 identity；届时本文件不得再作为「第二份实现」保留。

import { request, unwrap } from "@fenix/web-runtime/api/request";
import { getAdminKey } from "@fenix/web-runtime/lib/admin-key";

/** 组织下拉的选项（系统组织目录的字段子集）。 */
export interface SystemOrganizationOption {
  id: string;
  name: string;
  slug: string;
}

/** people-tree 响应中本端口读取的组织层字段（其余层不进入 sandbox 的类型面）。 */
interface PeopleTreeOrganization {
  id: string;
  name: string;
  slug?: string | null;
}

/** 系统组织目录的窄端口（§5.5：单一 `*Api` 对象）。 */
export const systemOrganizationsApi = {
  /** 拉取全部组织（Bearer 系统 master key）；只返回下拉需要的字段。 */
  list: (): Promise<SystemOrganizationOption[]> =>
    unwrap(
      request<{ organizations: PeopleTreeOrganization[] }>("/api/system/people-tree/", {
        bearerToken: getAdminKey() ?? undefined,
      }),
    ).then((data) =>
      (data.organizations ?? []).map((organization) => ({
        id: organization.id,
        name: organization.name,
        // slug 参与搜索匹配，缺失时用空串（`??` 而非 `||`：空串是有意义的缺省值）。
        slug: organization.slug ?? "",
      })),
    ),
};
