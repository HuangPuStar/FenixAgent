import { log } from "@fenix/logger";
import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "../../db";
import { agentConfigSkill, mcpServer, provider, skill } from "../../db/schema";
import type { AuthContext } from "../../plugins/auth";
import { decorateResourceAccess } from "../resource-permission";
import { getReadableAgentConfigById } from "./agent-config";
import { listMcpServers } from "./mcp-server";
import { listReadableProviders } from "./provider";
import type { AgentConfigDetailWithAccess, ResourceAccess } from "./types";

// ────────────────────────────────────────────
// 批量配置读取（spawn 时一次性获取 Agent 完整配置）
// ────────────────────────────────────────────

export interface AgentFullConfig {
  agentConfig: AgentConfigDetailWithAccess | null;
  providers: (typeof provider.$inferSelect & { resourceAccess?: ResourceAccess })[];
  skills: (typeof skill.$inferSelect & { resourceAccess?: ResourceAccess })[];
  mcpServers: (typeof mcpServer.$inferSelect)[];
}

function parseModelProviderRef(modelRef: string | null | undefined) {
  if (!modelRef) return null;
  const parts = modelRef.split("/");
  if (parts.length < 3) return null;
  return {
    organizationId: parts[0],
    providerId: parts[1],
  };
}

function parseLegacyModelProviderName(modelRef: string | null | undefined) {
  if (!modelRef) return null;
  const parts = modelRef.split("/");
  if (parts.length !== 2) return null;
  return {
    providerName: parts[0],
  };
}

async function loadProviderRowsForAgentModel(agentOrganizationId: string, modelRef: string | null | undefined) {
  const sharedRef = parseModelProviderRef(modelRef);
  if (sharedRef) {
    const rows = await db.select().from(provider).where(eq(provider.id, sharedRef.providerId)).limit(1);
    const matched = rows[0] ?? null;
    if (!matched || matched.organizationId !== sharedRef.organizationId) {
      log(
        `[config.aggregate] getAgentFullConfig: shared provider '${sharedRef.organizationId}/${sharedRef.providerId}' not found for model='${modelRef ?? ""}'`,
      );
      return [];
    }
    return [matched];
  }

  const legacyRef = parseLegacyModelProviderName(modelRef);
  if (!legacyRef) return [];

  const rows = await db
    .select()
    .from(provider)
    .where(
      and(
        eq(provider.organizationId, agentOrganizationId),
        or(eq(provider.name, legacyRef.providerName), eq(provider.displayName, legacyRef.providerName)),
      ),
    )
    .limit(2);
  log(
    `[config.aggregate] getAgentFullConfig: legacy provider lookup model='${modelRef ?? ""}' matched=${rows.map((row) => `${row.organizationId}/${row.id}:${row.name}`).join(",")}`,
  );
  return rows;
}

function summarizeConfigRows(
  providers: AgentFullConfig["providers"],
  skills: AgentFullConfig["skills"],
  mcpServers: AgentFullConfig["mcpServers"],
) {
  return {
    providers: providers.map((provider) => ({
      id: provider.id,
      org: provider.organizationId,
      name: provider.name,
      displayName: provider.displayName ?? null,
      resourceKey: provider.resourceAccess?.resourceKey ?? null,
      ownership: provider.resourceAccess?.ownership ?? null,
      hasApiKey: Boolean(provider.apiKey),
    })),
    skills: skills.map((skill) => ({
      id: skill.id,
      org: skill.organizationId,
      name: skill.name,
      resourceKey: skill.resourceAccess?.resourceKey ?? null,
      ownership: skill.resourceAccess?.ownership ?? null,
    })),
    mcpServers: mcpServers.map((server) => ({
      id: server.id,
      org: server.organizationId,
      name: server.name,
      enabled: server.enabled,
    })),
  };
}

export async function getAgentFullConfig(ctx: AuthContext, agentConfigId: string | null): Promise<AgentFullConfig> {
  log(
    `[config.aggregate] getAgentFullConfig: start org='${ctx.organizationId}', user='${ctx.userId}', agentConfigId='${agentConfigId ?? ""}'`,
  );
  if (!agentConfigId) {
    const [providers, mcpServerRows] = await Promise.all([listReadableProviders(ctx), listMcpServers(ctx)]);
    const skills: (typeof skill.$inferSelect & { resourceAccess?: ResourceAccess })[] = [];
    const mcpServers = mcpServerRows.filter((row) => row.enabled === true);
    log(
      `[config.aggregate] getAgentFullConfig: no agentConfigId, summary=${JSON.stringify(summarizeConfigRows(providers, skills, mcpServers))}`,
    );
    return { agentConfig: null, providers, skills, mcpServers };
  }

  const resolvedAgent = await getReadableAgentConfigById(ctx, agentConfigId);
  if (!resolvedAgent) {
    log(`[config.aggregate] getAgentFullConfig: readable agentConfig '${agentConfigId}' not found`);
    return { agentConfig: null, providers: [], skills: [], mcpServers: [] };
  }

  log(
    `[config.aggregate] getAgentFullConfig: resolved agentConfig id='${resolvedAgent.id}', org='${resolvedAgent.organizationId}', model='${resolvedAgent.model ?? ""}'`,
  );

  const sourceCtx: AuthContext = {
    ...ctx,
    organizationId: resolvedAgent.organizationId,
    userId: resolvedAgent.userId,
  };
  const [providerRows, mcpServerRows, skillBindings] = await Promise.all([
    loadProviderRowsForAgentModel(resolvedAgent.organizationId, resolvedAgent.model),
    db.select().from(mcpServer).where(eq(mcpServer.organizationId, sourceCtx.organizationId)),
    db
      .select({ skillId: agentConfigSkill.skillId })
      .from(agentConfigSkill)
      .where(eq(agentConfigSkill.agentConfigId, agentConfigId)),
  ]);
  log(
    `[config.aggregate] getAgentFullConfig: source providerRows=${providerRows.length}, mcpServerRows=${mcpServerRows.length}, skillBindings=${JSON.stringify(skillBindings)}`,
  );
  const providers = await decorateResourceAccess(sourceCtx, "provider", providerRows);

  let skills: (typeof skill.$inferSelect & { resourceAccess?: ResourceAccess })[] = [];
  if (skillBindings.length > 0) {
    const skillIds = skillBindings.map((binding) => binding.skillId);
    const skillRows = await db.select().from(skill).where(inArray(skill.id, skillIds));
    log(
      `[config.aggregate] getAgentFullConfig: fetched skillRows=${JSON.stringify(
        skillRows.map((row) => ({ id: row.id, org: row.organizationId, name: row.name, contentPath: row.contentPath })),
      )}`,
    );
    skills = await decorateResourceAccess(sourceCtx, "skill", skillRows);
  }

  const mcpServers = mcpServerRows.filter((row) => row.enabled === true);
  log(
    `[config.aggregate] getAgentFullConfig: resolved summary=${JSON.stringify(summarizeConfigRows(providers, skills, mcpServers))}`,
  );

  return {
    agentConfig: resolvedAgent,
    providers,
    skills,
    mcpServers,
  };
}
