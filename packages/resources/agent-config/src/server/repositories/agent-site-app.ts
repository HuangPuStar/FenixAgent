import { agentSiteApp } from "@fenix/agent-config/db";
import type {
  AuthorizedResourceQuery,
  QueryStorageTypes,
  ResourceQueryConstraint,
  ScopedRow,
} from "@fenix/platform-sdk";
import { eq, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { AGENT_SITE_APP_RESOURCE_TYPE, agentSiteAppResource } from "../access/agent-site-app-resource";
import { getAgentConfigDatabase } from "../db";

export type AgentSiteAppRow = typeof agentSiteApp.$inferSelect;

/**
 * 站点 App 的**发布范围**（对外部署站点的访问受众），不是平台资源受众。
 *
 * 四值语义：`private` 仅创建者；`org` 同组织成员；`authenticated` 任意已登录用户；`public` 含匿名。
 * 由站点代理（`routes/agent-sites-proxy.ts`）在对外访问路径上解释；管理面的读范围见
 * `services/agent-site-app-service.ts`。
 */
export type SiteAppVisibility = "private" | "org" | "authenticated" | "public";

/** 管理面创建站点的写入参数；归属列（组织 / 创建者 / 发布范围）在同一批 INSERT 中写入。 */
export interface CreateSiteAppParams {
  organizationId: string;
  userId: string;
  remoteAppId: string;
  name: string;
  description?: string;
  platformToken: string;
  platformTokenId: string;
  visibility?: SiteAppVisibility;
  /** App 类型，默认 pocketbase。custom 类型支持 deploy 接口 */
  appType?: "pocketbase" | "custom";
  /** 创建此 site 的 agent_config id（用于开发/业务智能体分派） */
  createdByAgentConfigId?: string | null;
}

/** 站点行的可写列；归属列（组织 / 创建者）不在这里，任何写路径都不得改写归属。 */
export interface SiteAppWriteData {
  readonly name?: string;
  readonly description?: string;
  readonly visibility?: SiteAppVisibility;
  readonly platformToken?: string;
  readonly platformTokenId?: string;
  readonly entryFile?: string | null;
  readonly activeSlot?: "a" | "b" | null;
  readonly deployedAt?: Date | null;
}

/**
 * 站点行的受控读取输入：`access` 必须是 Facade 产出的不透明条件，业务条件由 Domain Service 拼装。
 *
 * 仓储不解释 `ResourceQueryConstraint`，也不读取 `visibility` / 归属列做过滤——谓词与业务条件都由
 * 平台实现编译进同一条 SQL（§3.2 / §3.3）。
 */
export interface SiteAppReadInput {
  readonly access: ResourceQueryConstraint;
  readonly businessWhere?: readonly SQL[];
  /** 业务排序（下推到 ORDER BY）；由 Domain Service 从站点的展示序选出。 */
  readonly businessOrder?: readonly SQL[];
  readonly limit?: number;
}

/** 本包对授权查询端口的存储类型实例化。 */
export interface AgentSiteAppQueryStorage extends QueryStorageTypes {
  readonly table: PgTable;
  readonly column: PgColumn;
  readonly condition: SQL;
  readonly order: SQL;
  readonly row: AgentSiteAppRow;
}

export type ScopedAgentSiteAppRow = ScopedRow<AgentSiteAppRow>;

/**
 * 站点 App 的持久化访问层。
 *
 * 受控读取一律经 {@link AuthorizedResourceQuery}（授权谓词、业务条件、LIMIT 由平台编译）；按 ID /
 * 远端 ID 的**无授权读取**单独命名并标注 `Unscoped`，只允许发布面这类没有 actor 的系统路径（站点代理
 * 按远端 app id 定位发布目标），用户请求路径一律经 Domain Service 的受控读取。
 */
export interface AgentSiteAppRepository {
  /** 受控列表读取：平台谓词 + 业务条件下推为同一条 SQL。 */
  listReadable(input: SiteAppReadInput): Promise<readonly ScopedAgentSiteAppRow[]>;
  /** 受控单行读取（按资源 ID），可附加业务条件。 */
  findReadableById(
    input: SiteAppReadInput & { readonly resourceId: string },
  ): Promise<ScopedAgentSiteAppRow | undefined>;
  create(params: CreateSiteAppParams): Promise<AgentSiteAppRow>;
  update(id: string, data: SiteAppWriteData): Promise<AgentSiteAppRow | undefined>;
  remove(id: string): Promise<boolean>;
  /** 无授权按远端 app id 读取；站点代理（对外发布面，没有 actor）用它定位发布目标。 */
  findByRemoteAppIdUnscoped(remoteAppId: string): Promise<AgentSiteAppRow | undefined>;
}

/** 主表归属列的唯一定义来自资源注册，仓储不再重复声明列名。 */
const storage = agentSiteAppResource.storage;

export function createAgentSiteAppRepository(
  query: AuthorizedResourceQuery<AgentSiteAppQueryStorage>,
): AgentSiteAppRepository {
  /** 端口所需的查询目标；条件按需拼装，避免把 `undefined` 传进端口。 */
  function target(input: SiteAppReadInput) {
    return {
      resourceType: AGENT_SITE_APP_RESOURCE_TYPE,
      table: storage.table,
      columns: storage.columns,
      access: input.access,
      ...(input.businessWhere === undefined ? {} : { businessWhere: input.businessWhere }),
    };
  }

  return {
    async listReadable(input) {
      const page = await query.list({
        ...target(input),
        ...(input.businessOrder === undefined ? {} : { businessOrder: input.businessOrder }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      return page.items;
    },

    async findReadableById(input) {
      return query.findById({
        resourceType: AGENT_SITE_APP_RESOURCE_TYPE,
        table: storage.table,
        columns: storage.columns,
        access: input.access,
        resourceId: input.resourceId,
        ...(input.businessWhere === undefined ? {} : { businessWhere: input.businessWhere }),
      });
    },

    /**
     * 创建站点行。`visibility` 与其他可写列同批写入：创建期的发布范围由请求给出（既有 `/web` 契约），
     * 因此归属与发布范围都由调用方解析后传入，仓储只做列级默认值。
     */
    async create(params) {
      const [row] = await getAgentConfigDatabase()
        .insert(agentSiteApp)
        .values({
          organizationId: params.organizationId,
          userId: params.userId,
          remoteAppId: params.remoteAppId,
          name: params.name,
          description: params.description ?? null,
          platformToken: params.platformToken,
          platformTokenId: params.platformTokenId,
          visibility: params.visibility ?? "private",
          appType: params.appType ?? "pocketbase",
          createdByAgentConfigId: params.createdByAgentConfigId ?? null,
        })
        .returning();
      return row;
    },

    async update(id, data) {
      const [row] = await getAgentConfigDatabase()
        .update(agentSiteApp)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(agentSiteApp.id, id))
        .returning();
      return row;
    },

    async remove(id) {
      const result = await getAgentConfigDatabase().delete(agentSiteApp).where(eq(agentSiteApp.id, id));
      return (result as unknown as { count: number }).count > 0;
    },

    async findByRemoteAppIdUnscoped(remoteAppId) {
      const rows = await getAgentConfigDatabase()
        .select()
        .from(agentSiteApp)
        .where(eq(agentSiteApp.remoteAppId, remoteAppId))
        .limit(1);
      return rows[0];
    },
  };
}
