import type { ActorContext } from "@fenix/platform-sdk";
import { AppError, ValidationError } from "@fenix/platform-sdk";
import { InvalidKnowledgeBindingError, validateAgentKnowledgeBindings } from "@fenix/resource-knowledge/server";
import { getMcpServerModule } from "@fenix/resource-mcp/server";
import { getSkillServerModule } from "@fenix/resource-skill/server/runtime";
import { getModelLookupPort } from "../ports/model-lookup";
import type { AgentBindingRequest } from "../services/agent-bindings";

/** Resolve resource-owner authorization before saving any Agent configuration. */
export async function authorizeAgentBindings(
  actor: ActorContext,
  organizationId: string,
  request: AgentBindingRequest,
  modelId?: string | null,
): Promise<void> {
  if (modelId != null) await getModelLookupPort().requireModelForBinding(actor, modelId);
  for (const id of request.skillIds ?? []) {
    const skill = await getSkillServerModule().facade.getById(actor, id);
    if (!skill?.access.actions.includes("use")) throw new ValidationError("Skill不存在或不可访问");
  }
  for (const id of request.mcpIds ?? []) {
    const mcp = await getMcpServerModule().facade.getById(actor, id);
    if (!mcp?.access.actions.includes("use")) throw new ValidationError("MCP不存在或不可访问");
  }
  if (request.knowledge !== undefined) {
    try {
      await validateAgentKnowledgeBindings(organizationId, request.knowledge);
    } catch (error) {
      if (error instanceof InvalidKnowledgeBindingError)
        throw new AppError("知识库不存在或不可访问", "INVALID_KNOWLEDGE_BINDINGS", 400);
      throw error;
    }
  }
}
