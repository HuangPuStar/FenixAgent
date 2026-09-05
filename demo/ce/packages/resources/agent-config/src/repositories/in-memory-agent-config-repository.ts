import type { ResourceQueryConstraint, ResourceScope, ScopedResourceRepository } from "@fenix-ce/platform-sdk";
import type { AgentConfig, AgentConfigListQuery, AgentConfigPage, AgentConfigProperties } from "../domain/agent-config";

interface ResourceRow {
  readonly id: string;
  readonly type: "agent-config";
  readonly ownershipScope: ResourceScope;
}

/**
 * demo 专用 repository。
 *
 * 它刻意将 resources 基表与 agent_config_properties 属性表分 Map 存放；生产实现以 JOIN 和事务实现同一语义。
 */
export class InMemoryAgentConfigRepository implements ScopedResourceRepository<AgentConfig, AgentConfigListQuery> {
  private readonly resources = new Map<string, ResourceRow>();
  private readonly properties = new Map<string, AgentConfigProperties>();
  private nextId = 1;

  create(record: Omit<AgentConfig, "id">): AgentConfig {
    const id = `resource-agent-config-${this.nextId++}`;
    this.resources.set(id, { id, type: "agent-config", ownershipScope: record.ownershipScope });
    this.properties.set(id, { resourceId: id, name: record.name, engine: record.engine });
    return this.toAgentConfig(id);
  }

  findById(id: string, queryConstraint: ResourceQueryConstraint): AgentConfig | undefined {
    const resource = this.resources.get(id);
    return resource && queryConstraint.matches(resource.ownershipScope) ? this.toAgentConfig(id) : undefined;
  }

  list(input: { queryConstraint: ResourceQueryConstraint; query: AgentConfigListQuery }): AgentConfigPage {
    const keyword = input.query.keyword?.trim().toLowerCase();
    return {
      items: [...this.resources.values()]
        .filter((resource) => input.queryConstraint.matches(resource.ownershipScope))
        .map((resource) => this.toAgentConfig(resource.id))
        .filter((config) => !keyword || config.name.toLowerCase().includes(keyword))
        .slice(0, Math.min(input.query.limit, 100)),
    };
  }

  replace(config: AgentConfig): AgentConfig {
    this.properties.set(config.id, { resourceId: config.id, name: config.name, engine: config.engine });
    return this.toAgentConfig(config.id);
  }

  delete(id: string): void {
    this.properties.delete(id);
    this.resources.delete(id);
  }

  private toAgentConfig(id: string): AgentConfig {
    const resource = this.resources.get(id);
    const properties = this.properties.get(id);
    if (!resource || !properties) throw new Error("AgentConfig 资源基表与属性表不一致");
    return { id, ownershipScope: resource.ownershipScope, name: properties.name, engine: properties.engine };
  }
}
