import { createLogger } from "@fenix/logger";
import {
  type ActorContext,
  type AuthorizedResource,
  AuthorizedResourceFacade,
  type AuthorizedResourceFacadeOptions,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ResourceAccessDeniedError,
  type ResourceAction,
  ValidationError,
} from "@fenix/platform-sdk";
import type { McpToolRow, ScopedMcpServerRow } from "../repositories/mcp-server";
import { isValidMcpName, type McpServerConfig, validateMcpConfig } from "../services/config/mcp-config";
import type { McpServerService } from "../services/mcp-server-service";

/**
 * MCP Server 的资源应用 Facade：授权编排 + 状态校验 + 跨资源（tool 缓存）编排。
 *
 * 它是 MCP 资源的唯一应用入口（`route → Facade → Domain Service → Repository`）：route 只做协议
 * 接入与响应映射，领域服务不认识 actor。所有授权判断都经 `AccessControlModule`（继承基类的
 * `resolveInitialScope` / `listConstraint` / `authorizeAction` / `withAccess*`），本文件不复制任何
 * 组织、角色或 `visibility` 规则。
 *
 * 名称与配置结构的领域校验也收口在这里（`assertCreatable` / `assertValidConfig`）而不是各协议 route：
 * `/web` 与 `/api` 是同一资源的两个入口，校验写在 route 层时新增入口必然漏检——`/api/mcp` 历史上就
 * 因此绕过了 `validateMcpConfig`，写入过 `/web` 拒收的配置。
 *
 * 平台抛出的 {@link ResourceAccessDeniedError} 在这里映射为对外 403，其余错误原样上抛：存储或装配
 * 故障不得被伪装成权限问题。
 */

const log = createLogger("mcp-server");

/** 带当前主体有效动作的资源行；`access.actions` 是 `/web` 视图与 `/api` 视图的共同来源。 */
export type AuthorizedMcpServer = AuthorizedResource<ScopedMcpServerRow>;

/** 列表项；`toolsCount` 是缓存展示信息，不参与授权。 */
export type McpServerListItem = AuthorizedMcpServer & { readonly toolsCount: number };

export interface McpServerCreateInput {
  readonly name: string;
  readonly type: string;
  readonly config: McpServerConfig;
  /** 创建时即写入 `visibility`：公开受众由创建者决定，成员无权创建因此没有放权风险。 */
  readonly publicReadable?: boolean;
}

/** 检测到的 tool（缓存投影），与 `mcp_tool` 列一一对应。 */
export interface InspectedTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface McpServerUpdateOptions {
  /** 显式传入时才改动 `visibility`；不传表示"只改连接配置"。 */
  readonly publicReadable?: boolean;
}

/**
 * MCP 资源的应用接口（Facade 的契约面）。
 *
 * 路由与其它调用方只依赖本接口，不依赖 `McpServerFacade` 的继承结构或私有依赖；测试因此可以提供
 * 实现而不构造真类（见 `@fenix/resource-mcp/server/testing`）。
 *
 * 名称 / 资源键与资源 ID 两组入口并存是协议需要：`/web` 用名称或资源键定位（用户看到的是名称），
 * 已发布的 `/api/mcp/:id` 用资源 ID 定位；两者的授权与可见性判定完全一致。
 */
export interface McpServerFacadeApi {
  list(
    actor: ActorContext,
    options?: { limit?: number; offset?: number },
  ): Promise<{ items: McpServerListItem[]; total: number }>;
  get(actor: ActorContext, nameOrKey: string): Promise<AuthorizedMcpServer | undefined>;
  getById(actor: ActorContext, resourceId: string): Promise<AuthorizedMcpServer | undefined>;
  getWritable(actor: ActorContext, nameOrKey: string): Promise<AuthorizedMcpServer>;
  getWritableById(actor: ActorContext, resourceId: string): Promise<AuthorizedMcpServer>;
  create(actor: ActorContext, input: McpServerCreateInput): Promise<string>;
  update(
    actor: ActorContext,
    nameOrKey: string,
    config: McpServerConfig,
    options?: McpServerUpdateOptions,
  ): Promise<string>;
  updateById(
    actor: ActorContext,
    resourceId: string,
    config: McpServerConfig,
    options?: McpServerUpdateOptions,
  ): Promise<string>;
  remove(actor: ActorContext, nameOrKey: string): Promise<void>;
  removeById(actor: ActorContext, resourceId: string): Promise<void>;
  setEnabled(actor: ActorContext, nameOrKey: string, enabled: boolean): Promise<string>;
  listTools(actor: ActorContext, nameOrKey: string): Promise<{ name: string; tools: McpToolRow[] }>;
  saveInspectedTools(actor: ActorContext, nameOrKey: string, tools: readonly InspectedTool[]): Promise<string>;
}

export class McpServerFacade extends AuthorizedResourceFacade implements McpServerFacadeApi {
  constructor(
    private readonly service: McpServerService,
    options: AuthorizedResourceFacadeOptions,
  ) {
    super(options);
  }

  /** 列表：授权谓词与业务排序都下推到 SQL，列表与计数共用同一可见集合。 */
  async list(
    actor: ActorContext,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{ items: McpServerListItem[]; total: number }> {
    const access = await this.listConstraint(actor, "read");
    const { items, total } = await this.service.list({ access, ...options });
    const authorized = await this.withAccessMany(actor, items);
    const withCounts = await Promise.all(
      authorized.map(async (item) => ({ ...item, toolsCount: await this.countTools(item) })),
    );
    return { items: withCounts, total };
  }

  /**
   * 详情/读取：名称或资源键（`<organizationId>/<resourceId>`）。
   *
   * 同名资源可能同时存在于多个组织：优先当前 active organization，与迁移前"先查内部、再查外部"
   * 的顺序一致；跨组织可见资源仍然读得到，只是不会遮蔽本组织的同名资源。
   */
  async get(actor: ActorContext, nameOrKey: string): Promise<AuthorizedMcpServer | undefined> {
    const row = await this.findVisible(actor, nameOrKey);
    return row ? this.withAccess(actor, row) : undefined;
  }

  /** 详情/读取：按资源 ID（对外 `/api/mcp/:id`）。 */
  async getById(actor: ActorContext, resourceId: string): Promise<AuthorizedMcpServer | undefined> {
    const access = await this.listConstraint(actor, "read");
    const row = await this.service.findById({ access, resourceId });
    return row ? this.withAccess(actor, row) : undefined;
  }

  /**
   * 可写资源读取：需要原始配置的写路径动作（测试连接、检测工具、启停）用它。
   *
   * 不可见 → 404；可见但无 `update` 动作（例如其他组织的公开资源、当前组织的 member）→ 403。
   */
  async getWritable(actor: ActorContext, nameOrKey: string): Promise<AuthorizedMcpServer> {
    const row = await this.requireVisible(actor, nameOrKey);
    await this.requireAction(actor, "update", row.id);
    return this.withAccess(actor, row);
  }

  /** 可写资源读取：按资源 ID。 */
  async getWritableById(actor: ActorContext, resourceId: string): Promise<AuthorizedMcpServer> {
    const row = await this.requireVisibleById(actor, resourceId);
    await this.requireAction(actor, "update", row.id);
    return this.withAccess(actor, row);
  }

  /** 创建：初始归属（含 `create` 判定）与资源行同一条 INSERT 写入。 */
  async create(actor: ActorContext, input: McpServerCreateInput): Promise<string> {
    this.assertCreatable(input);
    const scope = await this.resolveCreateScope(actor);
    if (scope.organizationId === undefined) {
      throw new Error("MCP server 归属组织缺失：组织资源必须落在某个组织上");
    }
    const resourceId = await this.service.create({
      name: input.name,
      type: input.type,
      config: input.config,
      organizationId: scope.organizationId,
      ownerUserId: scope.ownerUserId ?? actor.userId,
      visibility: input.publicReadable === true ? "public" : scope.visibility,
    });
    // 同组织同名由唯一索引拦下（`insert` 返回空集）：并发创建不得静默改写既有配置。
    if (resourceId === undefined) throw new ConflictError(`MCP server '${input.name}' already exists`);
    return resourceId;
  }

  /** 更新配置与公开受众；公开受众变更要求 `update` 动作（`setVisibility` 内部再校验一次）。 */
  async update(
    actor: ActorContext,
    nameOrKey: string,
    config: McpServerConfig,
    options: McpServerUpdateOptions = {},
  ): Promise<string> {
    return this.applyUpdate(actor, await this.getWritable(actor, nameOrKey), config, options);
  }

  /** 更新配置与公开受众：按资源 ID。 */
  async updateById(
    actor: ActorContext,
    resourceId: string,
    config: McpServerConfig,
    options: McpServerUpdateOptions = {},
  ): Promise<string> {
    return this.applyUpdate(actor, await this.getWritableById(actor, resourceId), config, options);
  }

  /** 删除资源与其缓存的 tools（同一事务）。 */
  async remove(actor: ActorContext, nameOrKey: string): Promise<void> {
    const row = await this.requireVisible(actor, nameOrKey);
    await this.requireAction(actor, "delete", row.id);
    await this.deleteRow(row, nameOrKey);
  }

  /** 删除资源与其缓存的 tools：按资源 ID。 */
  async removeById(actor: ActorContext, resourceId: string): Promise<void> {
    const row = await this.requireVisibleById(actor, resourceId);
    await this.requireAction(actor, "delete", row.id);
    await this.deleteRow(row, resourceId);
  }

  /** 启用/禁用资源。 */
  async setEnabled(actor: ActorContext, nameOrKey: string, enabled: boolean): Promise<string> {
    const row = await this.getWritable(actor, nameOrKey);
    const updated = await this.service.setEnabled({ resourceId: row.id, enabled });
    if (!updated) throw new NotFoundError(`MCP server '${nameOrKey}' not found`);
    return row.name;
  }

  /** 读取缓存的 tools；只读动作即可（其他组织的公开资源也能看工具清单）。 */
  async listTools(actor: ActorContext, nameOrKey: string): Promise<{ name: string; tools: McpToolRow[] }> {
    const row = await this.requireVisible(actor, nameOrKey);
    const tools = await this.service.listTools({ organizationId: row.organizationId, serverName: row.name });
    return { name: row.name, tools };
  }

  /** 保存检测到的 tools（替换语义）；检测本身（网络/进程探测）留在 route 的编排里。 */
  async saveInspectedTools(actor: ActorContext, nameOrKey: string, tools: readonly InspectedTool[]): Promise<string> {
    const row = await this.getWritable(actor, nameOrKey);
    await this.service.replaceTools({
      organizationId: row.organizationId,
      serverName: row.name,
      tools,
    });
    return row.name;
  }

  /**
   * 创建入参的领域校验：名称格式 + 配置结构，任一不合法即抛 400。
   *
   * 放在授权之前：这两项判定不依赖任何已存资源，失败时不需要多付一次归属解析的查询，也与 `/web`
   * 迁移前"先拒非法输入、再谈权限"的行为一致。写入发生在校验之后，校验失败不产生任何副作用。
   */
  private assertCreatable(input: McpServerCreateInput): void {
    if (!isValidMcpName(input.name)) {
      throw new ValidationError("Invalid server name: must be 1-64 lowercase alphanumeric chars with single hyphens");
    }
    this.assertValidConfig(input.config);
  }

  /**
   * 配置结构的领域校验。`validateMcpConfig` 返回的是错误码（如 `INVALID_URL`），直接作为 400 的
   * message 透出：前端据此定位是地址还是命令的问题，这是迁移前 `/web` 的既有契约。
   *
   * 更新路径按**整份配置替换**校验，与 `McpServerService.update` 覆盖 `config` 列的语义一致——只校验
   * 增量字段会让"部分配置"静默覆盖掉已存的连接信息。
   */
  private assertValidConfig(config: McpServerConfig): void {
    const invalid = validateMcpConfig(config);
    if (invalid) throw new ValidationError(invalid);
  }

  /** 写入配置并（在显式传入时）更新公开受众。 */
  private async applyUpdate(
    actor: ActorContext,
    row: AuthorizedMcpServer,
    config: McpServerConfig,
    options: McpServerUpdateOptions,
  ): Promise<string> {
    this.assertValidConfig(config);
    const updated = await this.service.update({ resourceId: row.id, config });
    if (!updated) throw new NotFoundError(`MCP server '${row.name}' not found`);
    if (options.publicReadable !== undefined) {
      await this.setVisibility(actor, row.id, options.publicReadable ? "public" : "private");
    }
    return row.name;
  }

  private async deleteRow(row: ScopedMcpServerRow, label: string): Promise<void> {
    const deleted = await this.service.remove({
      resourceId: row.id,
      organizationId: row.organizationId,
      serverName: row.name,
    });
    if (!deleted) throw new NotFoundError(`MCP server '${label}' not found`);
  }

  /** 可见性解析：名称按"当前组织优先"匹配，资源键解析归属组织并校验一致。 */
  private async findVisible(actor: ActorContext, nameOrKey: string): Promise<ScopedMcpServerRow | undefined> {
    const access = await this.listConstraint(actor, "read");
    if (nameOrKey.includes("/")) {
      return this.service.findByResourceKey({ access, resourceKey: nameOrKey });
    }
    const activeOrganizationId = actor.activeOrganizationId;
    if (activeOrganizationId !== undefined) {
      const internal = await this.service.findByName({
        access,
        name: nameOrKey,
        organizationId: activeOrganizationId,
      });
      if (internal) return internal;
    }
    return this.service.findByName({ access, name: nameOrKey });
  }

  private async requireVisible(actor: ActorContext, nameOrKey: string): Promise<ScopedMcpServerRow> {
    const row = await this.findVisible(actor, nameOrKey);
    if (!row) throw new NotFoundError(`MCP server '${nameOrKey}' not found`);
    return row;
  }

  private async requireVisibleById(actor: ActorContext, resourceId: string): Promise<ScopedMcpServerRow> {
    const access = await this.listConstraint(actor, "read");
    const row = await this.service.findById({ access, resourceId });
    // 不存在与不可见返回同一个 404：区分两者会让资源 ID 成为跨组织探测面。
    if (!row) throw new NotFoundError(`MCP server '${resourceId}' not found`);
    return row;
  }

  /** 把平台的授权拒绝映射为对外 403；其它错误保持原样，避免把故障伪装成权限问题。 */
  private async requireAction(actor: ActorContext, action: ResourceAction, resourceId: string): Promise<void> {
    try {
      await this.authorizeAction(actor, action, resourceId);
    } catch (error) {
      if (error instanceof ResourceAccessDeniedError) throw new ForbiddenError(error.message);
      throw error;
    }
  }

  private async resolveCreateScope(actor: ActorContext): Promise<{
    organizationId?: string;
    ownerUserId?: string;
    visibility: "private" | "public";
  }> {
    try {
      return await this.resolveInitialScope(actor);
    } catch (error) {
      if (error instanceof ResourceAccessDeniedError) throw new ForbiddenError(error.message);
      throw error;
    }
  }

  /** tool 计数是展示信息：读取失败降级为 0，不能让整个列表失败（与迁移前行为一致）。 */
  private async countTools(row: ScopedMcpServerRow): Promise<number> {
    try {
      return await this.service.countTools({ organizationId: row.organizationId, serverName: row.name });
    } catch (error) {
      log.warn("MCP tool 计数失败，列表降级为 0", {
        resourceId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }
}
