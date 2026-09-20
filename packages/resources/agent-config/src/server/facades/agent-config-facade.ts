import {
  type ActorContext,
  type AuthorizedResource,
  AuthorizedResourceFacade,
  type AuthorizedResourceFacadeOptions,
  ForbiddenError,
  NotFoundError,
  ResourceAccessDeniedError,
  type ResourceAction,
} from "@fenix/platform-sdk";
import type { AgentConfigWriteData, ScopedAgentConfigRow } from "../repositories/agent-config-resource";
import { AGENT_CONFIG_LIST_ORDER } from "../repositories/agent-config-resource";
import type { AgentConfigService } from "../services/agent-config-service";

/**
 * AgentConfig 的资源应用 Facade：授权编排 + 跨资源（Environment / 运行实例）编排。
 *
 * 它是 AgentConfig 资源的唯一应用入口（`route → Facade → Domain Service → Repository`）：route 只做
 * 协议接入与响应映射，领域服务不认识 actor。所有授权判断都经 `AccessControlModule`（继承基类的
 * `resolveInitialScope` / `listConstraint` / `authorizeAction` / `withAccess*` / `setVisibility`），
 * 本文件不复制任何组织、角色或 `visibility` 规则。
 *
 * 资源行之外的副作用（停止运行实例、清理绑定 Environment、重启实例）留在这一层：它们是"以某个主体
 * 的身份对资源执行的操作"，属于应用编排而不是领域规则；授权已经在此完成，领域服务只按 ID 干活。
 *
 * 平台抛出的 {@link ResourceAccessDeniedError} 在这里映射为对外 403，其余错误原样上抛：存储或装配
 * 故障不得被伪装成权限问题。
 */

/** 带当前主体有效动作的资源行；`access.actions` 是 `/web` 视图与 `/api` 视图的共同来源。 */
export type AuthorizedAgentConfig = AuthorizedResource<ScopedAgentConfigRow>;

/** 创建输入；`publicReadable` 在创建期即写入 `visibility`（成员无权创建，因此没有放权风险）。 */
export interface AgentConfigCreateInput {
  readonly name: string;
  readonly data: AgentConfigWriteData;
  readonly publicReadable?: boolean;
}

/** 更新输入；`publicReadable` 不传表示"只改配置，不动公开受众"。 */
export interface AgentConfigUpdateOptions {
  readonly publicReadable?: boolean;
}

/** 重启结果：绑定该 Agent 的 Environment 与已完成 runtime 重启的持久 Instance。 */
export interface AgentConfigRestartResult {
  readonly environmentIds: string[];
  readonly restartedInstanceIds: string[];
}

/**
 * AgentConfig 资源的应用接口（Facade 的契约面）。
 *
 * 路由与其它调用方只依赖本接口，不依赖 `AgentConfigFacade` 的继承结构或私有依赖；测试可以提供实现
 * 而不构造真类（见 `@fenix/agent-config/server/testing`）。
 *
 * 名称 / 资源键与资源 ID 两组入口并存是协议需要：`/web` 用名称或资源键定位（用户看到的是名称），
 * 已发布的 `/api/agents/:id` 用资源 ID 定位；两者的授权与可见性判定完全一致。
 */
export interface AgentConfigFacadeApi {
  list(
    actor: ActorContext,
    options?: { limit?: number; offset?: number },
  ): Promise<{ items: AuthorizedAgentConfig[]; total: number }>;
  get(actor: ActorContext, nameOrKey: string): Promise<AuthorizedAgentConfig | undefined>;
  getById(actor: ActorContext, resourceId: string): Promise<AuthorizedAgentConfig | undefined>;
  /**
   * 创建期同名冲突判定：名称在**归属组织内**是否已存在。
   *
   * 与 `get` 的差别是口径而不是精度：`get` 走授权可见集合（含其他组织的公开同名资源），拿它做创建
   * 预检会把"另一个组织公开了同名 Agent"误判成本组织冲突，让合法创建返回 409；而 `create` 的 upsert
   * 冲突目标只有 `(organization_id, name)`，两者必须同口径。
   *
   * 判定不经过授权条件：唯一性是主表约束（`idx_agent_config_org_name`）而非授权事实，挂在授权上会随
   * `memberDefaultActions` / `ownershipMode` 的变化悄悄变宽或变窄，upsert 的冲突目标却不会跟着变。
   */
  existsInOrganization(actor: ActorContext, name: string): Promise<boolean>;
  create(actor: ActorContext, input: AgentConfigCreateInput): Promise<AuthorizedAgentConfig>;
  update(
    actor: ActorContext,
    nameOrKey: string,
    data: AgentConfigWriteData,
    options?: AgentConfigUpdateOptions,
  ): Promise<AuthorizedAgentConfig>;
  remove(actor: ActorContext, nameOrKey: string): Promise<void>;
  /** 重启绑定 Environment 下的持久 Instance runtime；需要 `use` 动作（成员默认具备）。 */
  restartInstances(actor: ActorContext, nameOrKey: string): Promise<AgentConfigRestartResult>;
}

export class AgentConfigFacade extends AuthorizedResourceFacade implements AgentConfigFacadeApi {
  constructor(
    private readonly service: AgentConfigService,
    options: AuthorizedResourceFacadeOptions,
  ) {
    super(options);
  }

  /** 列表：授权谓词、业务排序与分页都下推到 SQL。`total` 与 `items` 共用同一可见集合。 */
  async list(
    actor: ActorContext,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{ items: AuthorizedAgentConfig[]; total: number }> {
    const access = await this.listConstraint(actor, "read");
    const { items, total } = await this.service.list({ access, order: AGENT_CONFIG_LIST_ORDER, ...options });
    return { items: await this.withAccessMany(actor, items), total };
  }

  /**
   * 详情/读取：名称或资源键（`<organizationId>/<resourceId>`）。
   *
   * 同名资源可能同时存在于多个组织：优先当前 active organization，与迁移前"先查本组织、再查外部
   * 共享"的顺序一致；跨组织可见资源仍然读得到，只是不会遮蔽本组织的同名资源。
   */
  async get(actor: ActorContext, nameOrKey: string): Promise<AuthorizedAgentConfig | undefined> {
    const row = await this.findVisible(actor, nameOrKey);
    return row ? this.withAccess(actor, row) : undefined;
  }

  /** 详情/读取：按资源 ID（对外 `/api/agents/:id`）。 */
  async getById(actor: ActorContext, resourceId: string): Promise<AuthorizedAgentConfig | undefined> {
    const access = await this.listConstraint(actor, "read");
    const row = await this.service.findById({ access, resourceId });
    return row ? this.withAccess(actor, row) : undefined;
  }

  /**
   * 创建期同名冲突判定；作用域与 `create` 的冲突目标 `(organization_id, name)` 对齐（见接口注释）。
   *
   * 两点依赖关系，改动其中任何一侧都要重新审视本方法：
   *
   * 1. **检查的组织必须等于 `create` 写入的组织**。这里直接取 `actor.activeOrganizationId`，与
   *    `create` 经 `resolveInitialScope` 得到的组织同值——依赖的是本资源 `ownershipMode` 为
   *    `organization`、且协议入口不传显式 `organizationId`（`access-control/src/index.ts` 的
   *    `initialScope` 取 `input.organizationId ?? actor.activeOrganizationId`）。若将来出现"预检的
   *    组织与写入的组织不同"的实现，漏判会让本应 409 的创建在仓储里静默改写既有行。
   * 2. **无授权读取在此处安全**：`findByNameUnscoped` 不做任何授权判断，只按 `(organizationId,
   *    name)` 取一行且结果仅用于"存在与否"，不回传内容。它不会扩大信息面——认证层产出的
   *    `ActorContext` 保证 `activeOrganizationId` 必在 `memberships` 里（本组织的组织资源对成员
   *    默认可读），因此这条判定能看到的名称集合不超过 `get` 已能读到的集合。若认证层不再保证这一点，
   *    本方法就会变成跨组织私有名称的存在性预言机，必须改为先取得 `create` 授权再判定。
   */
  async existsInOrganization(actor: ActorContext, name: string): Promise<boolean> {
    const organizationId = actor.activeOrganizationId;
    // 纯防御分支：/api 入口在无组织上下文时 actor 已是 null（401），正常路径不会走到这里。
    if (organizationId === undefined) return false;
    return (await this.service.findByNameUnscoped({ name, organizationId })) !== undefined;
  }

  /**
   * 创建：初始归属（含 `create` 判定）与资源行同一条 INSERT 写入。
   *
   * 同组织同名走仓储的冲突分支（幂等 upsert）：冲突分支只更新可写列，不改归属列，因此重复提交不会
   * 让资源换主或静默改变公开受众。需要 409 的协议入口在调用前用 {@link existsInOrganization} 做
   * 同组织同名检查——口径与这里的冲突目标一致，不得改用可见性判定。
   */
  async create(actor: ActorContext, input: AgentConfigCreateInput): Promise<AuthorizedAgentConfig> {
    const scope = await this.resolveCreateScope(actor);
    if (scope.organizationId === undefined) {
      throw new Error("AgentConfig 归属组织缺失：组织资源必须落在某个组织上");
    }

    const resourceId = await this.service.create({
      name: input.name,
      data: input.data,
      organizationId: scope.organizationId,
      ownerUserId: scope.ownerUserId ?? actor.userId,
      visibility: input.publicReadable === true ? "public" : scope.visibility,
    });
    if (resourceId === undefined) {
      throw new Error("AgentConfig 创建未返回资源 ID");
    }
    return this.reload(actor, resourceId, input.name);
  }

  /** 更新配置与公开受众；公开受众变更由 {@link AuthorizedResourceFacade.setVisibility} 再校验一次。 */
  async update(
    actor: ActorContext,
    nameOrKey: string,
    data: AgentConfigWriteData,
    options: AgentConfigUpdateOptions = {},
  ): Promise<AuthorizedAgentConfig> {
    const row = await this.requireVisible(actor, nameOrKey);
    await this.requireAction(actor, "update", row.id);

    const updated = await this.service.update({ resourceId: row.id, data });
    if (!updated) throw new NotFoundError(`Agent '${nameOrKey}' not found`);

    if (options.publicReadable !== undefined) {
      await this.setVisibility(actor, row.id, options.publicReadable ? "public" : "private");
    }
    return this.reload(actor, row.id, nameOrKey);
  }

  /**
   * 删除资源行与其绑定 Environment。
   *
   * 删除前先停止绑定 Environment 上的运行实例：删除 DB 只移记录，不停止编排实例，Agent 进程 /
   * controller 活跃表 / 并发额度会残留为泄漏（见
   * `docs/issues/2026-08-19-agent-delete-instance-leak.md`）。stop 在 DB 事务外执行（实例停止不读
   * DB，避免把慢速 kill 关进 DB 长事务）；"先停后删"即使删除失败也只是实例已停、行仍在（可重新
   * spawn 恢复），比"先删后停、stop 失败 → 实例彻底孤儿"更安全。
   */
  async remove(actor: ActorContext, nameOrKey: string): Promise<void> {
    const row = await this.requireVisible(actor, nameOrKey);
    await this.requireAction(actor, "delete", row.id);

    const environmentIds = await this.service.listBoundEnvironmentIds({
      resourceId: row.id,
      organizationId: row.organizationId,
    });
    if (environmentIds.length > 0) {
      // 动态 import 保持与运行时装配的惰性边界，避免删除链在模块初始化期形成循环依赖。
      const { closeAcpConnectionsForEnvironments, stopInstancesForEnvironments } = await import(
        "@fenix/agent-runtime/server"
      );
      // 先关闭本地 ACP 连接，再停止运行实例；否则客户端仍会用已删除环境继续发消息。
      closeAcpConnectionsForEnvironments([...environmentIds]);
      await stopInstancesForEnvironments([...environmentIds], { organizationId: row.organizationId });
    }

    const deleted = await this.service.remove({ resourceId: row.id, organizationId: row.organizationId });
    if (!deleted) throw new NotFoundError(`Agent '${nameOrKey}' not found`);
  }

  /**
   * 重启绑定 Environment 下的持久 Instance runtime，Instance 记录保持不变。
   *
   * 动作选择 `use` 而不是 `update`：重启是"运行这个 Agent"的操作性动作，与改配置分属两类。迁移前
   * `assertInternalWritable` 只要求同组织，`use` 落在 `memberDefaultActions` 里，因此成员的重启能力
   * 被**保持**而不是收紧——收紧的是配置写入（见资源注册的动作收敛说明）。
   */
  async restartInstances(actor: ActorContext, nameOrKey: string): Promise<AgentConfigRestartResult> {
    const row = await this.requireVisible(actor, nameOrKey);
    await this.requireAction(actor, "use", row.id);

    const environmentIds = await this.service.listBoundEnvironmentIds({
      resourceId: row.id,
      organizationId: row.organizationId,
    });
    if (environmentIds.length === 0) return { environmentIds: [], restartedInstanceIds: [] };

    // 惰性导入避免 agent-config → agent-instance-service → orchestration-instance → config 的循环依赖。
    const { agentInstanceService } = await import("@fenix/agent-runtime/server");
    const restartedInstanceIds = await agentInstanceService.restartActiveInstancesForEnvironments([...environmentIds]);
    return { environmentIds: [...environmentIds], restartedInstanceIds };
  }

  /** 可见性解析：名称按"当前组织优先"匹配，资源键解析归属组织并由仓储校验一致。 */
  private async findVisible(actor: ActorContext, nameOrKey: string): Promise<ScopedAgentConfigRow | undefined> {
    const access = await this.listConstraint(actor, "read");
    if (nameOrKey.includes("/")) {
      return this.service.findByResourceKey({ access, resourceKey: nameOrKey });
    }
    const activeOrganizationId = actor.activeOrganizationId;
    if (activeOrganizationId !== undefined) {
      const internal = await this.service.findByName({ access, name: nameOrKey, organizationId: activeOrganizationId });
      if (internal) return internal;
    }
    return this.service.findByName({ access, name: nameOrKey });
  }

  private async requireVisible(actor: ActorContext, nameOrKey: string): Promise<ScopedAgentConfigRow> {
    const row = await this.findVisible(actor, nameOrKey);
    if (!row) throw new NotFoundError(`Agent '${nameOrKey}' not found`);
    return row;
  }

  /**
   * 写路径回读：按 ID 走受控读取，避免"按名称再查一次"命中另一个同名资源。
   *
   * 刻意不用 `findRowUnscoped` + `withAccess`：归属范围必须由授权查询产出（谓词就是从归属列推导的），
   * 绕过查询自己拼 scope 会让"行的归属"与"授权看到的归属"出现两条来源。
   */
  private async reload(actor: ActorContext, resourceId: string, label: string): Promise<AuthorizedAgentConfig> {
    const authorized = await this.getById(actor, resourceId);
    if (!authorized) throw new NotFoundError(`Agent '${label}' not found`);
    return authorized;
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
}

/** 对外 `/api` 侧把资源 ID 转成资源键：写路径借此复用同一套"同组织可见"判定。 */
export function toAgentResourceKey(organizationId: string, resourceId: string): string {
  return `${organizationId}/${resourceId}`;
}
