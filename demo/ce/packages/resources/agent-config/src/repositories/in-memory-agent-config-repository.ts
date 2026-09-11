import type { ResourceScope, ResourceScopeStore, ScopedResourceRepository } from "@fenix-ce/platform-sdk";
import type { AgentConfig, AgentConfigListQuery, AgentConfigPage } from "../domain/agent-config";

/** 模拟 agent_configs 主表：业务字段与固定归属列由同一资源行承载。 */
interface AgentConfigRow {
  readonly id: string;
  readonly organizationId?: string;
  readonly userId?: string;
  readonly visibility?: ResourceScope["visibility"];
  readonly name: string;
  readonly engine: string;
}

/**
 * demo 专用 repository。
 *
 * 它以单个 Map 模拟 agent_configs 主表；生产实现将授权查询与业务条件编译到同一条 SQL。
 */
export class InMemoryAgentConfigRepository
  implements ScopedResourceRepository<AgentConfig, AgentConfigListQuery>, ResourceScopeStore
{
  private readonly rows = new Map<string, AgentConfigRow>();
  private nextId = 1;

  async create(record: Omit<AgentConfig, "id" | "scope" | "access">): Promise<AgentConfig> {
    const id = `resource-agent-config-${this.nextId++}`;
    this.rows.set(id, {
      id,
      visibility: "private",
      name: record.name,
      engine: record.engine,
    });
    return { id, scope: { visibility: "private" }, access: { actions: [] }, name: record.name, engine: record.engine };
  }

  async findById(id: string): Promise<AgentConfig | undefined> {
    return this.rows.has(id) ? this.toAgentConfig(id) : undefined;
  }

  async list(query: AgentConfigListQuery): Promise<AgentConfigPage> {
    const keyword = query.keyword?.trim().toLowerCase();
    return {
      items: [...this.rows.values()]
        .map((row) => this.toAgentConfig(row.id))
        .filter((config) => !keyword || config.name.toLowerCase().includes(keyword)),
    };
  }

  async replace(config: AgentConfig): Promise<AgentConfig> {
    const row = this.rows.get(config.id);
    if (!row) throw new Error("AgentConfig 资源不存在");
    // 业务属性更新不能顺带回写范围；范围只能由 ResourceScopeStore.update() 修改。
    this.rows.set(config.id, { ...row, name: config.name, engine: config.engine });
    return this.toAgentConfig(config.id);
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }

  async initialize(input: { resourceType: string; resourceId: string; scope: ResourceScope }): Promise<void> {
    this.writeScope(input);
  }

  async getMany(input: { resourceType: string; resourceIds: readonly string[] }): Promise<Map<string, ResourceScope>> {
    this.requireResourceType(input.resourceType);
    const scopes = new Map<string, ResourceScope>();
    for (const resourceId of input.resourceIds) {
      const row = this.rows.get(resourceId);
      if (row) scopes.set(resourceId, this.toScope(row));
    }
    return scopes;
  }

  async update(input: { resourceType: string; resourceId: string; scope: ResourceScope }): Promise<void> {
    this.writeScope(input);
  }

  async remove(input: { resourceType: string; resourceId: string }): Promise<void> {
    this.requireResourceType(input.resourceType);
    this.rows.delete(input.resourceId);
  }

  private toAgentConfig(id: string): AgentConfig {
    const row = this.rows.get(id);
    if (!row) throw new Error("AgentConfig 资源不存在");
    return { id, scope: this.toScope(row), access: { actions: [] }, name: row.name, engine: row.engine };
  }

  /** 模拟 ColumnResourceScopeStore：只通过资源主表固定列构造范围对象。 */
  private toScope(row: AgentConfigRow): ResourceScope {
    if (!row.visibility) throw new Error("AgentConfig 资源尚未初始化归属范围");
    return {
      organizationId: row.organizationId,
      ownerUserId: row.userId,
      visibility: row.visibility,
    };
  }

  private writeScope(input: { resourceType: string; resourceId: string; scope: ResourceScope }): void {
    this.requireResourceType(input.resourceType);
    const row = this.rows.get(input.resourceId);
    if (!row) throw new Error("AgentConfig 资源不存在");
    this.rows.set(input.resourceId, {
      ...row,
      organizationId: input.scope.organizationId,
      userId: input.scope.ownerUserId,
      visibility: input.scope.visibility,
    });
  }

  private requireResourceType(resourceType: string): void {
    if (resourceType !== "agent-config") throw new Error(`不支持的资源类型: ${resourceType}`);
  }
}
