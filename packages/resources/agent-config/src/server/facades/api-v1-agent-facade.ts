import { type ActorContext, AppError, ForbiddenError, NotFoundError, ValidationError } from "@fenix/platform-sdk";
import { InvalidKnowledgeBindingError } from "@fenix/resource-knowledge/server";
import type { AgentConfigServerModule } from "../module";
import { getAgentConfigModule } from "../runtime";
import type { ApiAgentListQuery, ApiAgentUpdateBody, ApiAgentUpsertBody } from "../schemas/api-agent.schema";
import { type AgentConfigSaveCommand, saveAgentConfig } from "../services/agent-config-write";
import {
  isBuiltInAgent,
  isValidAgentName,
  resolveAgentNode,
  toAgentConfigWriteData,
  validateAgentData,
} from "../services/config/agent-config";
import { authorizeAgentBindings } from "./agent-binding-authorization";
import type { AuthorizedAgentConfig } from "./agent-config-facade";

/** Version-owned Agent application entry point, independent of console DTOs and defaults. */
export class ApiV1AgentFacade {
  constructor(private readonly module: AgentConfigServerModule = getAgentConfigModule()) {}

  private async require(actor: ActorContext, id: string) {
    const row = await this.module.facade.getById(actor, id);
    if (!row) throw new NotFoundError("Agent not found");
    return row;
  }

  private summary(row: AuthorizedAgentConfig) {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      modelId: row.modelId ?? null,
      agentNode: resolveAgentNode(row) ?? {},
      scope: row.scope,
      access: row.access,
    };
  }

  private async detail(row: AuthorizedAgentConfig) {
    const { associations } = this.module;
    const [knowledge, skillIds, mcpIds, enableMemory] = await Promise.all([
      associations.getKnowledge(row.id),
      associations.listSkillIds(row.id),
      associations.listMcpIds(row.id),
      associations.isMemoryEnabled(row.id),
    ]);
    return {
      ...this.summary(row),
      builtIn: isBuiltInAgent(row.name),
      prompt: row.prompt ?? null,
      extra: row.extra ?? null,
      knowledge,
      skillIds,
      mcpIds,
      enableMemory,
      publicReadable: row.scope.visibility === "public",
    };
  }

  /** Read authorized current values, including the actual memory switch. */
  async get(actor: ActorContext, id: string) {
    return this.detail(await this.require(actor, id));
  }

  /** Query only the authorized page and use the same count predicate. */
  async list(actor: ActorContext, query: ApiAgentListQuery) {
    const { page, pageSize } = query;
    const result = await this.module.facade.list(actor, { limit: pageSize, offset: (page - 1) * pageSize });
    const items = await Promise.all(
      result.items.map(async (row) => ({
        ...this.summary(row),
        knowledgeBaseCount: (await this.module.associations.listKnowledgeBindings(row.id)).length,
      })),
    );
    return { items, total: result.total, page, pageSize };
  }

  private async validate(actor: ActorContext, organizationId: string, input: ApiAgentUpdateBody) {
    const error = validateAgentData(input);
    if (error) throw new ValidationError(error);
    try {
      await authorizeAgentBindings(actor, organizationId, input, input.modelId);
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 404) throw new ValidationError("绑定资源不存在或不可访问");
      throw error;
    }
  }

  private async save(command: AgentConfigSaveCommand<AuthorizedAgentConfig>) {
    try {
      return await saveAgentConfig(command);
    } catch (error) {
      // The KB can disappear after authorization; preserve the v1 error after transaction rollback.
      if (error instanceof InvalidKnowledgeBindingError)
        throw new AppError("知识库不存在或不可访问", "INVALID_KNOWLEDGE_BINDINGS", 400);
      throw error;
    }
  }

  /** Strict insert and all explicit bindings commit together. */
  async create(actor: ActorContext, input: ApiAgentUpsertBody) {
    if (!isValidAgentName(input.name)) throw new ValidationError("Invalid agent name");
    const organizationId = actor.activeOrganizationId;
    if (!organizationId) throw new AppError("Organization context required", "UNAUTHORIZED", 401);
    await this.validate(actor, organizationId, input);
    const row = await this.save({
      organizationId,
      write: () =>
        this.module.facade.create(actor, {
          name: input.name,
          data: toAgentConfigWriteData(input),
          rejectConflict: true,
          publicReadable: input.publicReadable,
        }),
      bindings: input,
      enableMemory: input.enableMemory,
      associations: this.module.associations,
    });
    return this.detail(row);
  }

  /** Serialize replacements without injecting defaults or touching absent associations. */
  async patch(actor: ActorContext, id: string, input: ApiAgentUpdateBody) {
    const current = await this.require(actor, id);
    if (!current.access.actions.includes("update")) throw new ForbiddenError("Agent is read-only");
    const organizationId = current.scope.organizationId;
    if (!organizationId) throw new Error("Agent organization missing");
    await this.validate(actor, organizationId, input);
    const row = await this.save({
      organizationId,
      resourceId: id,
      write: () =>
        this.module.facade.updateById(actor, id, toAgentConfigWriteData(input), {
          publicReadable: input.publicReadable,
        }),
      bindings: input,
      enableMemory: input.enableMemory,
      associations: this.module.associations,
    });
    return this.detail(row);
  }

  /** Reuse strict runtime shutdown and built-in protection before deleting. */
  async remove(actor: ActorContext, id: string) {
    await this.module.facade.removeById(actor, id);
    return null;
  }
}
