import { agentSiteApp } from "@fenix/agent-config/db";
import type { ResourceQueryConstraint } from "@fenix/platform-sdk";
import { asc, eq, inArray, ne, or, type SQL, sql } from "drizzle-orm";
import type {
  AgentSiteAppRepository,
  AgentSiteAppRow,
  CreateSiteAppParams,
  ScopedAgentSiteAppRow,
  SiteAppWriteData,
} from "../repositories/agent-site-app";

/**
 * 站点 App 的领域服务。
 *
 * 只承载站点自身的领域规则（发布范围的读口径、按 ID / 远端 ID 的定位、写入编排）与持久化编排；
 * **不接收 actor、不做权限判断**——授权在 Facade 完成，受控读取把不透明的 `access` 条件原样交给仓储
 * 下推（§3.2）。
 *
 * 这里唯一"解释 `visibility`"的地方是 {@link publishRangeCondition}，它是**站点专属发布字段的读口径**
 * （§3.3：「匿名访问由 Site 等资源专属发布字段或发布实体表达」）：平台的 `private` 对组织资源意味着
 * "按归属与成员角色访问"，而站点表的四值表达的是部署出去的站点给谁看。平台受众模型表达不了
 * "非 private 即对同组织成员公开"，因此这条口径由资源自己声明为业务条件，与平台授权谓词 AND 之后
 * 下推为同一条 SQL。绑定编排与写路径**不用**这条口径：它们只需要"这行属于当前组织"（既有契约）。
 */
export interface AgentSiteAppService {
  /**
   * 管理面列表：平台谓词（同组织）+ 站点读口径（`private` 仅归属者）。
   *
   * 排序是站点的业务序（`created_at` 升序），与既有列表一致；授权过滤与排序下推为同一条 SQL。
   */
  listVisible(input: {
    readonly access: ResourceQueryConstraint;
    readonly userId: string;
  }): Promise<readonly ScopedAgentSiteAppRow[]>;
  /** 管理面详情：按资源 ID 或远端 app id 定位，读口径与 {@link listVisible} 相同。 */
  findVisible(input: {
    readonly access: ResourceQueryConstraint;
    readonly userId: string;
    readonly resourceId?: string;
    readonly remoteAppId?: string;
  }): Promise<ScopedAgentSiteAppRow | undefined>;
  /**
   * 组织范围定位（不做发布范围过滤）。
   *
   * 两类调用方：写路径（修改 / 删除 / 换 token / 上传 / 部署先要拿到行再判写权限）与绑定编排
   * （`agent_config_site_app` 的读写只要求站点属于当前组织）。
   */
  findInOrganization(input: {
    readonly access: ResourceQueryConstraint;
    readonly resourceId?: string;
    readonly remoteAppId?: string;
  }): Promise<ScopedAgentSiteAppRow | undefined>;
  /** 组织范围内按 ID 集合读取可见站点，并按调用方给定的顺序返回（绑定展开的展示序）。 */
  listVisibleByIds(input: {
    readonly access: ResourceQueryConstraint;
    readonly userId: string;
    readonly ids: readonly string[];
  }): Promise<readonly ScopedAgentSiteAppRow[]>;
  /**
   * 发布面定位（**无授权**）：对外站点访问按远端 app id 找发布目标，调用方是站点代理。
   *
   * 单独命名而不是复用受控入口：这条路径上没有 actor（访客可能未登录），站点代理只按远端 app id
   * 取发布范围与归属标识，授权语义由站点的发布范围承担。
   */
  findPublishTargetByRemoteAppId(remoteAppId: string): Promise<AgentSiteAppRow | undefined>;
  create(params: CreateSiteAppParams): Promise<AgentSiteAppRow>;
  update(id: string, data: SiteAppWriteData): Promise<AgentSiteAppRow | undefined>;
  remove(id: string): Promise<boolean>;
}

export function createAgentSiteAppService(repository: AgentSiteAppRepository): AgentSiteAppService {
  return {
    async listVisible(input) {
      return repository.listReadable({
        access: input.access,
        businessWhere: [publishRangeCondition(input.userId)],
        // 既有展示顺序：创建时间升序（不新增次序键——站点列表不分页，不存在跨页稳定性问题）。
        businessOrder: [asc(agentSiteApp.createdAt)],
      });
    },

    async findVisible(input) {
      const businessWhere = [
        publishRangeCondition(input.userId),
        ...(input.resourceId === undefined ? [] : [eq(agentSiteApp.id, input.resourceId)]),
        ...(input.remoteAppId === undefined ? [] : [eq(agentSiteApp.remoteAppId, input.remoteAppId)]),
      ];
      const rows = await repository.listReadable({ access: input.access, businessWhere, limit: 1 });
      return rows[0];
    },

    async findInOrganization(input) {
      if (input.resourceId === undefined && input.remoteAppId === undefined) {
        throw new Error("站点定位需要 resourceId 或 remoteAppId");
      }
      const businessWhere =
        input.resourceId === undefined
          ? [eq(agentSiteApp.remoteAppId, input.remoteAppId as string)]
          : [eq(agentSiteApp.id, input.resourceId)];
      const rows = await repository.listReadable({ access: input.access, businessWhere, limit: 1 });
      return rows[0];
    },

    async listVisibleByIds(input) {
      if (input.ids.length === 0) return [];
      const rows = await repository.listReadable({
        access: input.access,
        businessWhere: [publishRangeCondition(input.userId), inArray(agentSiteApp.id, [...input.ids])],
      });
      // 保持绑定顺序（与用户勾选顺序一致），而不是数据库返回顺序。
      return input.ids
        .map((id) => rows.find((row) => row.id === id))
        .filter((row): row is ScopedAgentSiteAppRow => row !== undefined);
    },

    async findPublishTargetByRemoteAppId(remoteAppId) {
      return repository.findByRemoteAppIdUnscoped(remoteAppId);
    },

    create: (params) => repository.create(params),
    update: (id, data) => repository.update(id, data),
    remove: (id) => repository.remove(id),
  };
}

/**
 * 站点管理面的读范围条件：`private` 只对归属者可见，其余发布范围对同组织成员可见。
 *
 * 组织口径由平台的授权谓词给出（本条件是 AND 上去的第二半），因此跨组织读仍然不可能；这里只回答
 * "同一组织内，这条站点对谁可见"。`visibility` 为 NOT NULL，取值异常（含 NULL）一律按 `private`
 * 之外不成立处理，即失败方向是收紧而不是放开。
 */
export function publishRangeCondition(userId: string): SQL {
  return or(ne(agentSiteApp.visibility, "private"), eq(agentSiteApp.userId, userId)) ?? sql`false`;
}
