/**
 * 工单的**平台管理面** Facade（`/api/system/tickets`）：跨组织只读列表（T06）。
 *
 * 为什么与 `ticket-facade.ts` 分开而不是往那个类上加一个方法：`TicketFacade` 的每个入口都以
 * `AuthorizedResourceFacade` 的受控查询为前置（授权判定是它的存在意义），而本面的调用方**不是一个用户**
 * ——宿主 `systemApiAuthPlugin` 刻意不恢复用户 / 组织上下文（`apps/server/src/plugins/system-api-auth.ts`），
 * 因此这里没有 actor 可传，判据就是「手里有系统 key」（`systemApiKeyAuth: true`，判据在路由守卫）。把两类
 * 凭据的入口放进同一个类，会让「哪条路径其实没有走授权」在评审时需要读完整个类才能确认；分开后，本文件
 * 的全部代码都是「已完成平台认证之后的读取编排」。
 *
 * 与授权模型的关系（**不改动组织内可见性**）：`ticket_project` 仍是 `ownershipMode: "organization"` 且无
 * `visibility` 列——组织成员读项目、读工单的规则一条不变，跨组织读取只发生在这一条系统路径上。因此这里
 * 既不构造 `systemRole: "super-admin"` 的旁路 actor（决策 D8：该分支没有生产赋值点，见
 * `apps/server/src/plugins/auth.ts`），也不给 `ticket_project` 加平台受众列。
 *
 * 分层：route（协议映射）→ 本 Facade（视图组装）→ `TicketService`（跨组织查询）→ 仓储（唯一的跨组织 SQL）。
 * 展示名与组织名解析只用于展示，失败时退化为写入期快照或 ID，绝不参与任何判定。
 */

import type { IdentityDirectory } from "@fenix/platform-sdk";
import type { TicketPlatformListInput, TicketService } from "../services/ticket-service";
import { collectIndexActorIds, type DisplayNames, type TicketSummaryView, toTicketSummaryView } from "./ticket-view";

/**
 * 管理面列表行：`/web` 列表行的字段（同源同义，仍是 `ticket_index` 的投影）再加**归属坐标**。
 *
 * 跨组织视图里没有项目与组织坐标，两行 `#7` 就无法区分，管理员也就无法判断该找谁。坐标取自
 * `ticket_projects` 的仓库快照（不是事实源回读）：列表不回源上游，坐标可能落后于远端改名，这一点与
 * `/web` 列表同源同级别。
 */
export interface TicketPlatformSummaryView extends TicketSummaryView {
  readonly organizationId: string;
  /** 组织展示名；身份目录查不到时回退为组织 ID（展示退化，不影响请求成功与否）。 */
  readonly organizationName: string;
  readonly projectId: string;
  /** 仓库名（`ticket_projects.name`）。 */
  readonly projectName: string;
  /** 仓库 owner（托管平台命名空间），与 `projectName` 一起构成仓库坐标。 */
  readonly projectOwner: string;
}

export interface TicketPlatformListPage {
  readonly items: readonly TicketPlatformSummaryView[];
  /** 同一筛选条件下的命中总数（跨页）。 */
  readonly total: number;
}

export interface TicketPlatformFacadeApi {
  /** 跨组织分页列出工单索引（只读）。不接收 actor：判据是系统路由守卫。 */
  list(query: TicketPlatformListInput): Promise<TicketPlatformListPage>;
}

export interface TicketPlatformFacadeDeps {
  /** 工单领域服务：跨组织查询的入口（本面不接触仓储，与其它 Facade 同口径）。 */
  readonly tickets: TicketService;
  /** 只用于展示名解析（用户与组织），绝不参与判定。 */
  readonly identity: IdentityDirectory;
}

class TicketPlatformFacade implements TicketPlatformFacadeApi {
  private readonly tickets: TicketService;
  private readonly identity: IdentityDirectory;

  constructor(deps: TicketPlatformFacadeDeps) {
    this.tickets = deps.tickets;
    this.identity = deps.identity;
  }

  async list(query: TicketPlatformListInput): Promise<TicketPlatformListPage> {
    const page = await this.tickets.listPlatformPage(query);
    // 两次展示解析并行：作者名（身份目录）与组织名（组织名录）互不依赖，串行只是多一次往返。
    const [displayNames, organizationNames] = await Promise.all([
      this.resolveDisplayNames(collectIndexActorIds(page.items.map((row) => row.issue))),
      this.resolveOrganizationNames(page.items.map((row) => row.organizationId)),
    ]);
    return {
      items: page.items.map((row) => ({
        ...toTicketSummaryView(row.issue, displayNames),
        organizationId: row.organizationId,
        organizationName: organizationNames.get(row.organizationId) ?? row.organizationId,
        projectId: row.projectId,
        projectName: row.projectName,
        projectOwner: row.projectOwner,
      })),
      total: page.total,
    };
  }

  /** 一次批量解析本页会展示到的 AOS 主体；空集合不发查询（整页都是外部来源时不该多一次往返）。 */
  private async resolveDisplayNames(userIds: readonly string[]): Promise<DisplayNames> {
    if (userIds.length === 0) return new Map();
    return this.identity.listUserDisplayInfo(userIds);
  }

  /** 一次批量解析本页涉及的组织名；去重后查询，缺名时由调用方回退成 ID。 */
  private async resolveOrganizationNames(organizationIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const unique = [...new Set(organizationIds)];
    if (unique.length === 0) return new Map();
    return this.identity.listOrganizationNames(unique);
  }
}

/** 构造管理面 Facade；只构造不读 DB、不写单例，测试可注入替身。 */
export function createTicketPlatformFacade(deps: TicketPlatformFacadeDeps): TicketPlatformFacadeApi {
  return new TicketPlatformFacade(deps);
}
