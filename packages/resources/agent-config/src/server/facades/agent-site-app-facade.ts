import { type ActorContext, AuthorizedResourceFacade, type AuthorizedResourceFacadeOptions } from "@fenix/platform-sdk";
import { findAgentConfigNamesByIds } from "../repositories/agent-config";
import type { AgentSiteAppRow, SiteAppVisibility } from "../repositories/agent-site-app";
import type { AgentSiteAppService } from "../services/agent-site-app-service";
import {
  invalidatePublishTarget,
  loadPublishTarget,
  type SitePublishTarget,
} from "../services/agent-site-publish-cache";
import {
  createRemoteApp,
  deleteRemoteApp,
  deployCustomApp,
  issuePlatformToken,
  revokePlatformToken,
  uploadRemoteBundle,
  uploadRemoteFile,
} from "../services/agent-sites";
import { addAgentSiteApp, listAgentSiteAppIds, removeAgentSiteApp } from "../services/config/agent-config-site-app";
import { getAgentConfigById } from "../system-entries";

/**
 * 站点 App 的资源应用 Facade：授权编排 + 站点生命周期编排。
 *
 * 它是 `/web/agent-sites/*` 与站点对外代理的**唯一应用入口**（`route → Facade → Domain Service /
 * Repository`）：route 只做协议接入、DTO 与错误映射，领域服务不认识 actor。读范围（平台谓词 +
 * 站点发布范围）由 Domain Service 拼成一条 SQL 下推；写权限与创建规则在这一层判定。
 *
 * ## 三条站点专属规则与它们的边界（为什么平台表达不了）
 *
 * 1. **读**：平台谓词产出"同组织成员可见"（`agent_site_app` 注册为 `organization` 归属，`read` 在
 *    `memberDefaultActions` 里），站点**发布范围**再收窄一次（`private` 仅归属者）——由 Domain Service
 *    作为业务条件声明，与谓词 AND 后下推为同一条 SQL。平台的 `public` 受众表达不了 `org` /
 *    `authenticated` 这两个非 `private` 取值，也表达不了"仅在组织内公开"，因此这条口径只能由资源声明
 *    （§3.3：Site 的发布范围属资源专属发布字段）。
 * 2. **写**：归属者本人，或当前组织的 `owner` / `admin`。角色这一半由平台产出（`organization` 归属下
 *    `owner` / `admin` 拿到全量动作，`member` 只有 `read`）；**归属者本人**这一半平台表达不了
 *    （`memberDefaultActions` 只接受 `read` / `use`，而 `organization-personal` 会把同组织读范围一起
 *    塌成"仅归属者"，破坏第 1 条），因此在 {@link AgentSiteAppFacade.assertCanManage} 显式叠加。
 * 3. **创建**：任意组织成员可创建自己的站点，发布范围由请求给出（既有 `/web` 契约）。平台的
 *    `resolveInitialScope` 只产出 `visibility = private`，且 `organization` 归属下 `create` 属
 *    `owner` / `admin`，与既有契约不符，因此创建期归属在 {@link AgentSiteAppFacade.create} 显式给出：
 *    组织与创建者来自可信 actor，`visibility` 来自请求。
 *
 * 三条都只作用于管理面；对外站点访问（代理）由站点的发布范围决定，与这里无关。
 *
 * 失败一律以 {@link SiteAppActionError} 抛出：`reason` 是语义，HTTP 状态码与文案由协议层决定。
 */
export class SiteAppActionError extends Error {
  constructor(
    readonly reason: SiteAppFailureReason,
    readonly context: SiteAppFailureContext = {},
  ) {
    super(`站点动作失败：${reason}`);
    this.name = "SiteAppActionError";
  }
}

/** 站点动作的失败语义；协议层据此映射 `/web` 状态码与文案。 */
export type SiteAppFailureReason =
  | "no_organization"
  | "site_not_found"
  | "agent_not_found"
  | "forbidden"
  | "not_custom"
  | "pocketbase_unsupported";

/** 失败详情：只带协议层要展示的字段（远端 app id / 类型），不含任何凭据。 */
export interface SiteAppFailureContext {
  readonly remoteAppId?: string;
  readonly appType?: string;
}

/** 管理面视图：资源行 + 展示用的创建者配置名（凭据列不进入视图）。 */
export type AgentSiteAppView = AgentSiteAppRow & { readonly createdByAgentConfigName: string | null };

/** 创建输入；`visibility` 与 `type` 已由协议层取到 schema 默认值。 */
export interface SiteAppCreateInput {
  readonly name: string;
  readonly description?: string;
  readonly visibility?: SiteAppVisibility;
  readonly type?: "pocketbase" | "custom";
  readonly agentConfigId?: string;
}

/** 更新输入；未出现的字段保持原值。 */
export interface SiteAppUpdateInput {
  readonly name?: string;
  readonly description?: string;
  readonly visibility?: SiteAppVisibility;
}

/** 部署结果：平台返回的部署元数据（`port` 是平台内部端口，不外露）。 */
export interface SiteAppDeployResult {
  readonly files: number;
  readonly totalBytes: number;
  readonly entryFile: string;
  readonly slot: "a" | "b";
  readonly deployedAt: Date;
}

/** PocketBase 透传目标：注入 platform token 转发上游所需的字段。 */
export interface PocketBaseProxyTarget {
  readonly remoteAppId: string;
  readonly platformToken: string;
}

/**
 * 站点 App 的应用接口（Facade 的契约面）。
 *
 * 路由与其它调用方只依赖本接口，不依赖 `AgentSiteAppFacade` 的私有依赖；测试可以提供实现而不构造真类。
 */
export interface AgentSiteAppFacadeApi {
  list(actor: ActorContext | null): Promise<AgentSiteAppView[]>;
  getById(actor: ActorContext | null, id: string): Promise<AgentSiteAppView>;
  getByRemoteAppId(actor: ActorContext | null, remoteAppId: string): Promise<AgentSiteAppView>;
  create(actor: ActorContext | null, input: SiteAppCreateInput): Promise<AgentSiteAppView>;
  update(actor: ActorContext | null, id: string, input: SiteAppUpdateInput): Promise<AgentSiteAppView>;
  remove(actor: ActorContext | null, id: string): Promise<void>;
  rotateToken(actor: ActorContext | null, id: string): Promise<void>;
  uploadFile(
    actor: ActorContext | null,
    id: string,
    path: string,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<unknown>;
  uploadBundle(actor: ActorContext | null, id: string, body: ReadableStream<Uint8Array> | null): Promise<unknown>;
  deploy(actor: ActorContext | null, id: string, body: ReadableStream<Uint8Array> | null): Promise<SiteAppDeployResult>;
  /** PocketBase 管理 API 透传目标；`custom` 类型没有 PocketBase，抛 `pocketbase_unsupported`。 */
  getPocketBaseProxyTarget(actor: ActorContext | null, id: string): Promise<PocketBaseProxyTarget>;
  /** AgentConfig ↔ SiteApp 绑定列表：按绑定顺序返回当前主体可见的站点。 */
  listBoundApps(actor: ActorContext | null, agentConfigId: string): Promise<AgentSiteAppView[]>;
  /** 绑定单个站点；只要求站点属于当前组织，不要求调用者能读它（绑定表不属于站点自身的受众）。 */
  bind(actor: ActorContext | null, agentConfigId: string, siteAppId: string): Promise<void>;
  unbind(actor: ActorContext | null, agentConfigId: string, siteAppId: string): Promise<void>;
  /** 发布面定位（**无 actor**）：对外站点访问按远端 app id 取发布范围与归属标识。 */
  findPublishTarget(remoteAppId: string): Promise<SitePublishTarget | null>;
}

/** 组织维度主体：从可信 actor 解析出的当前组织与用户。 */
interface SiteSubject {
  readonly actor: ActorContext;
  readonly organizationId: string;
  readonly userId: string;
}

/** 站点标识既可以是 RCS UUID，也可以是远端 app id；两种形状的查询条件不同。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AgentSiteAppFacade extends AuthorizedResourceFacade implements AgentSiteAppFacadeApi {
  constructor(
    private readonly service: AgentSiteAppService,
    options: AuthorizedResourceFacadeOptions,
  ) {
    super(options);
  }

  async list(actor: ActorContext | null): Promise<AgentSiteAppView[]> {
    const subject = this.requireSubject(actor);
    const rows = await this.service.listVisible({
      access: await this.listConstraint(subject.actor, "read"),
      userId: subject.userId,
    });
    return this.toViews(rows);
  }

  async getById(actor: ActorContext | null, id: string): Promise<AgentSiteAppView> {
    const subject = this.requireSubject(actor);
    const row = await this.findVisible(subject, { resourceId: id });
    return this.toView(row, await this.resolveCreatorName(row));
  }

  async getByRemoteAppId(actor: ActorContext | null, remoteAppId: string): Promise<AgentSiteAppView> {
    const subject = this.requireSubject(actor);
    const row = await this.findVisible(subject, { remoteAppId });
    return this.toView(row, await this.resolveCreatorName(row));
  }

  /** 创建：见类注释第 3 条——远端 app 与 token 先创建，再写本地行（归属与发布范围一次写入）。 */
  async create(actor: ActorContext | null, input: SiteAppCreateInput): Promise<AgentSiteAppView> {
    const subject = this.requireSubject(actor);
    const remote = await createRemoteApp(input.name, input.type);
    // custom 类型其实用不到 token（没有 PocketBase），但保留以维持主表列完整；后续迁回 pocketbase 也无缝。
    const token = await issuePlatformToken(remote.id);
    const row = await this.service.create({
      organizationId: subject.organizationId,
      userId: subject.userId,
      remoteAppId: remote.id,
      name: remote.name,
      ...(input.description === undefined ? {} : { description: input.description }),
      platformToken: token.token,
      platformTokenId: token.token_id,
      ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
      ...(input.type === undefined ? {} : { appType: input.type }),
      createdByAgentConfigId: input.agentConfigId ?? null,
    });
    return this.toView(row, await this.resolveCreatorName(row));
  }

  async update(actor: ActorContext | null, id: string, input: SiteAppUpdateInput): Promise<AgentSiteAppView> {
    const row = await this.requireManagedRow(actor, id, "update");
    const updated = await this.service.update(row.id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
    });
    if (!updated) throw new SiteAppActionError("site_not_found");
    // 发布范围变化后立即使代理缓存失效，避免旧范围继续生效最多 60 秒。
    if (input.visibility !== undefined) invalidatePublishTarget(updated.remoteAppId);
    return this.toView(updated, await this.resolveCreatorName(updated));
  }

  async remove(actor: ActorContext | null, id: string): Promise<void> {
    const row = await this.requireManagedRow(actor, id, "delete");
    // 先删远端 app，再删本地行：远端失败时本地记录保留，不会留下无主站点。
    await deleteRemoteApp(row.remoteAppId);
    await this.service.remove(row.id);
  }

  async rotateToken(actor: ActorContext | null, id: string): Promise<void> {
    const row = await this.requireManagedRow(actor, id, "update");
    try {
      await revokePlatformToken(row.platformTokenId);
    } catch (error) {
      // 旧 token 已不存在（或上游已吊销）不该挡住重签：如实记录后继续申请新 token。
      console.warn(`[agent-sites] 吊销旧 token 失败 tokenId=${row.platformTokenId}，继续申请新 token`, error);
    }
    const token = await issuePlatformToken(row.remoteAppId);
    await this.service.update(row.id, { platformToken: token.token, platformTokenId: token.token_id });
  }

  async uploadFile(
    actor: ActorContext | null,
    id: string,
    path: string,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<unknown> {
    const row = await this.requireManagedRow(actor, id, "update");
    const result = await uploadRemoteFile(row.remoteAppId, path, body);
    return result.data;
  }

  async uploadBundle(
    actor: ActorContext | null,
    id: string,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<unknown> {
    const row = await this.requireManagedRow(actor, id, "update");
    const result = await uploadRemoteBundle(row.remoteAppId, body);
    return result.data;
  }

  async deploy(
    actor: ActorContext | null,
    id: string,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<SiteAppDeployResult> {
    const row = await this.requireManagedRow(actor, id, "update");
    // 只有 custom 类型支持部署：pocketbase 由平台托管，没有用户代码可部署。
    if (row.appType !== "custom") {
      throw new SiteAppActionError("not_custom", { remoteAppId: row.remoteAppId, appType: row.appType });
    }
    const remote = await deployCustomApp(row.remoteAppId, body);
    const deployedAt = new Date();
    // 平台返回的槽位只有 "a" / "b" 两种取值；DB 列与响应 schema 都要求该字面量类型。
    const slot = remote.data.slot as "a" | "b";
    await this.service.update(row.id, { entryFile: remote.data.entry_file, activeSlot: slot, deployedAt });
    return {
      files: remote.data.files,
      totalBytes: remote.data.total_bytes,
      entryFile: remote.data.entry_file,
      slot,
      deployedAt,
    };
  }

  async getPocketBaseProxyTarget(actor: ActorContext | null, id: string): Promise<PocketBaseProxyTarget> {
    const row = await this.requireOrganizationRow(actor, id);
    if (row.appType === "custom") {
      // 明确拒绝，而不是把上游 404 当成"站点不存在"回给调用方。
      throw new SiteAppActionError("pocketbase_unsupported", { remoteAppId: row.remoteAppId, appType: row.appType });
    }
    return { remoteAppId: row.remoteAppId, platformToken: row.platformToken };
  }

  async listBoundApps(actor: ActorContext | null, agentConfigId: string): Promise<AgentSiteAppView[]> {
    const subject = this.requireSubject(actor);
    const ids = await listAgentSiteAppIds(agentConfigId);
    if (ids.length === 0) return [];
    const rows = await this.service.listVisibleByIds({
      access: await this.listConstraint(subject.actor, "read"),
      userId: subject.userId,
      ids,
    });
    return this.toViews(rows);
  }

  async bind(actor: ActorContext | null, agentConfigId: string, siteAppId: string): Promise<void> {
    const row = await this.resolveForBinding(actor, agentConfigId, siteAppId);
    // 永远用本地 UUID 写绑定表：绑定展开按 UUID 匹配。
    await addAgentSiteApp(agentConfigId, row.id);
  }

  async unbind(actor: ActorContext | null, agentConfigId: string, siteAppId: string): Promise<void> {
    const row = await this.resolveForBinding(actor, agentConfigId, siteAppId);
    await removeAgentSiteApp(agentConfigId, row.id);
  }

  async findPublishTarget(remoteAppId: string): Promise<SitePublishTarget | null> {
    return loadPublishTarget(remoteAppId, () => this.service.findPublishTargetByRemoteAppId(remoteAppId));
  }

  /**
   * 解析可定位组织资源的主体。
   *
   * 没有 active organization、或该组织不在成员关系里时抛 `no_organization`（协议层映射为 401）：这种
   * 主体无法定位组织资源，而不是"看得见零行"。判定只看**成员关系是否存在**，不看角色取值——角色规则
   * 一律由授权模块产出。
   */
  private requireSubject(actor: ActorContext | null): SiteSubject {
    const organizationId = actor?.activeOrganizationId;
    if (actor === null || organizationId === undefined) throw new SiteAppActionError("no_organization");
    if (!actor.memberships.some((membership) => membership.organizationId === organizationId)) {
      throw new SiteAppActionError("no_organization");
    }
    return { actor, organizationId, userId: actor.userId };
  }

  /** 管理面读：同组织 + 站点发布范围；未命中与不可见一律 `site_not_found`（不泄漏存在性）。 */
  private async findVisible(
    subject: SiteSubject,
    locator: { readonly resourceId?: string; readonly remoteAppId?: string },
  ): Promise<AgentSiteAppRow> {
    const row = await this.service.findVisible({
      access: await this.listConstraint(subject.actor, "read"),
      userId: subject.userId,
      ...locator,
    });
    if (!row) throw new SiteAppActionError("site_not_found");
    return row;
  }

  /**
   * 组织范围定位（不做发布范围过滤）：写路径先取行再判写权限。
   *
   * 与读路径口径不同是刻意的：管理员能删除他人的 private 站点却读不到它（既有契约），因此写路径只要
   * "这行属于当前组织"；跨组织行在这里取不到，协议层按 404 处理。
   */
  private async requireOrganizationRow(actor: ActorContext | null, id: string): Promise<AgentSiteAppRow> {
    const subject = this.requireSubject(actor);
    const row = await this.service.findInOrganization({
      access: await this.listConstraint(subject.actor, "read"),
      resourceId: id,
    });
    if (!row) throw new SiteAppActionError("site_not_found");
    return row;
  }

  /** 写路径入口：定位行 + 写权限判定，任一不成立即抛出对应失败语义。 */
  private async requireManagedRow(
    actor: ActorContext | null,
    id: string,
    action: "update" | "delete",
  ): Promise<AgentSiteAppRow> {
    const row = await this.requireOrganizationRow(actor, id);
    // `requireOrganizationRow` 已解析出主体；这里重新解析只是为了让类型收窄到非空 actor。
    const subject = this.requireSubject(actor);
    await this.assertCanManage(subject.actor, row, action);
    return row;
  }

  /**
   * 写权限：归属者本人，或当前组织的 `owner` / `admin`（见类注释第 2 条）。
   *
   * 角色那一半来自授权模块（`resolveAccess` 的动作集合已按组织角色推导）；归属者那一半在这里叠加——
   * 归属者对本行的管理权与其组织角色无关。
   */
  private async assertCanManage(actor: ActorContext, row: AgentSiteAppRow, action: "update" | "delete"): Promise<void> {
    if (row.userId === actor.userId) return;
    const access = await this.options.accessControl.resolveAccess({
      actor,
      resource: this.options.resource,
      resourceId: row.id,
    });
    if (!access.actions.includes(action)) throw new SiteAppActionError("forbidden");
  }

  /** 绑定编排的公共前置：Agent 属于当前组织、站点也属于当前组织（既有的双重组织校验）。 */
  private async resolveForBinding(
    actor: ActorContext | null,
    agentConfigId: string,
    siteAppId: string,
  ): Promise<AgentSiteAppRow> {
    const subject = this.requireSubject(actor);
    const agentConfig = await getAgentConfigById(agentConfigId, subject.organizationId);
    if (!agentConfig) throw new SiteAppActionError("agent_not_found");
    const locator = UUID_RE.test(siteAppId) ? { resourceId: siteAppId } : { remoteAppId: siteAppId };
    const row = await this.service.findInOrganization({
      access: await this.listConstraint(subject.actor, "read"),
      ...locator,
    });
    if (!row) throw new SiteAppActionError("site_not_found");
    return row;
  }

  /** 批量补齐创建者配置名（列表与绑定展开各一次查询，不做逐行 N+1）。 */
  private async toViews(rows: readonly AgentSiteAppRow[]): Promise<AgentSiteAppView[]> {
    const ids = [...new Set(rows.map((row) => row.createdByAgentConfigId).filter((id): id is string => id !== null))];
    const names = await findAgentConfigNamesByIds(ids);
    return rows.map((row) =>
      this.toView(row, row.createdByAgentConfigId ? (names.get(row.createdByAgentConfigId) ?? null) : null),
    );
  }

  /** 单行视图的创建者名解析；创建者被删除时为 null。 */
  private async resolveCreatorName(row: AgentSiteAppRow): Promise<string | null> {
    if (!row.createdByAgentConfigId) return null;
    const names = await findAgentConfigNamesByIds([row.createdByAgentConfigId]);
    return names.get(row.createdByAgentConfigId) ?? null;
  }

  private toView(row: AgentSiteAppRow, createdByAgentConfigName: string | null): AgentSiteAppView {
    return { ...row, createdByAgentConfigName };
  }
}
