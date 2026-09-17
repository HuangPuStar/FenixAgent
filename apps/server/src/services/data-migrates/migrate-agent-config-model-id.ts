import { log } from "@fenix/logger";
import { and, eq, or } from "drizzle-orm";
import { db } from "../../db";
import { agentConfig, model, provider } from "../../db/schema";

export interface AgentConfigModelMigrationRow {
  id: string;
  organizationId: string;
  modelId: string | null;
  model: string | null;
}

interface ProviderLookupRow {
  id: string;
  organizationId: string;
  name: string;
  displayName: string | null;
}

interface ModelLookupRow {
  id: string;
}

function parseStableModelRef(modelRef: string) {
  const parts = modelRef.split("/");
  if (parts.length < 3) return null;
  return {
    organizationId: parts[0] ?? "",
    providerId: parts[1] ?? "",
    modelName: parts.slice(2).join("/"),
  };
}

function parseLegacyModelRef(modelRef: string) {
  const slashIndex = modelRef.indexOf("/");
  if (slashIndex <= 0 || slashIndex === modelRef.length - 1) return null;
  return {
    providerName: modelRef.slice(0, slashIndex),
    modelName: modelRef.slice(slashIndex + 1),
  };
}

export const _deps = {
  listPendingRows: async (): Promise<AgentConfigModelMigrationRow[]> =>
    db
      .select({
        id: agentConfig.id,
        organizationId: agentConfig.organizationId,
        modelId: agentConfig.modelId,
        model: agentConfig.model,
      })
      .from(agentConfig),
  findStableProvider: async (organizationId: string, providerId: string): Promise<ProviderLookupRow | null> => {
    const rows = await db
      .select({
        id: provider.id,
        organizationId: provider.organizationId,
        name: provider.name,
        displayName: provider.displayName,
      })
      .from(provider)
      .where(and(eq(provider.organizationId, organizationId), eq(provider.id, providerId)))
      .limit(1);
    return rows[0] ?? null;
  },
  findLegacyProviders: async (organizationId: string, providerName: string): Promise<ProviderLookupRow[]> =>
    db
      .select({
        id: provider.id,
        organizationId: provider.organizationId,
        name: provider.name,
        displayName: provider.displayName,
      })
      .from(provider)
      .where(
        and(
          eq(provider.organizationId, organizationId),
          or(eq(provider.name, providerName), eq(provider.displayName, providerName)),
        ),
      )
      .limit(5),
  findModelRow: async (
    organizationId: string,
    providerId: string,
    modelName: string,
  ): Promise<ModelLookupRow | null> => {
    const rows = await db
      .select({ id: model.id })
      .from(model)
      .where(
        and(eq(model.organizationId, organizationId), eq(model.providerId, providerId), eq(model.modelId, modelName)),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  updateAgentConfigModel: async (agentConfigId: string, nextModelId: string): Promise<void> => {
    await db
      .update(agentConfig)
      .set({
        modelId: nextModelId,
        model: null,
        updatedAt: new Date(),
      })
      .where(eq(agentConfig.id, agentConfigId));
  },
  log,
};

export function _resetDeps() {
  _deps.listPendingRows = async () =>
    db
      .select({
        id: agentConfig.id,
        organizationId: agentConfig.organizationId,
        modelId: agentConfig.modelId,
        model: agentConfig.model,
      })
      .from(agentConfig);
  _deps.findStableProvider = async (organizationId: string, providerId: string) => {
    const rows = await db
      .select({
        id: provider.id,
        organizationId: provider.organizationId,
        name: provider.name,
        displayName: provider.displayName,
      })
      .from(provider)
      .where(and(eq(provider.organizationId, organizationId), eq(provider.id, providerId)))
      .limit(1);
    return rows[0] ?? null;
  };
  _deps.findLegacyProviders = async (organizationId: string, providerName: string) =>
    db
      .select({
        id: provider.id,
        organizationId: provider.organizationId,
        name: provider.name,
        displayName: provider.displayName,
      })
      .from(provider)
      .where(
        and(
          eq(provider.organizationId, organizationId),
          or(eq(provider.name, providerName), eq(provider.displayName, providerName)),
        ),
      )
      .limit(5);
  _deps.findModelRow = async (organizationId: string, providerId: string, modelName: string) => {
    const rows = await db
      .select({ id: model.id })
      .from(model)
      .where(
        and(eq(model.organizationId, organizationId), eq(model.providerId, providerId), eq(model.modelId, modelName)),
      )
      .limit(1);
    return rows[0] ?? null;
  };
  _deps.updateAgentConfigModel = async (agentConfigId: string, nextModelId: string) => {
    await db
      .update(agentConfig)
      .set({
        modelId: nextModelId,
        model: null,
        updatedAt: new Date(),
      })
      .where(eq(agentConfig.id, agentConfigId));
  };
  _deps.log = log;
}

async function resolveTargetModelId(row: AgentConfigModelMigrationRow): Promise<string | null> {
  const legacyModelRef = row.model?.trim();
  if (!legacyModelRef) {
    return null;
  }

  const stableRef = parseStableModelRef(legacyModelRef);
  if (stableRef) {
    const providerRow = await _deps.findStableProvider(stableRef.organizationId, stableRef.providerId);
    if (!providerRow) {
      throw new Error(
        `[data-migrate] missing provider '${stableRef.organizationId}/${stableRef.providerId}' for agentConfig='${row.id}'`,
      );
    }
    const modelRow = await _deps.findModelRow(providerRow.organizationId, providerRow.id, stableRef.modelName);
    if (!modelRow) {
      throw new Error(
        `[data-migrate] missing model '${stableRef.modelName}' for agentConfig='${row.id}' under provider='${providerRow.organizationId}/${providerRow.id}'`,
      );
    }
    return modelRow.id;
  }

  const legacyRef = parseLegacyModelRef(legacyModelRef);
  if (!legacyRef) {
    throw new Error(`[data-migrate] invalid legacy model ref '${legacyModelRef}' for agentConfig='${row.id}'`);
  }

  const providerCandidates = await _deps.findLegacyProviders(row.organizationId, legacyRef.providerName);
  const providerRow =
    providerCandidates.find((candidate) => candidate.name === legacyRef.providerName) ??
    providerCandidates.find((candidate) => candidate.displayName === legacyRef.providerName) ??
    providerCandidates[0] ??
    null;
  if (!providerRow) {
    throw new Error(
      `[data-migrate] missing legacy provider '${legacyRef.providerName}' for agentConfig='${row.id}' in org='${row.organizationId}'`,
    );
  }

  const modelRow = await _deps.findModelRow(providerRow.organizationId, providerRow.id, legacyRef.modelName);
  if (!modelRow) {
    throw new Error(
      `[data-migrate] missing legacy model '${legacyRef.modelName}' for agentConfig='${row.id}' under provider='${providerRow.organizationId}/${providerRow.id}'`,
    );
  }
  return modelRow.id;
}

/** 启动迁移：把 agent_config.model 的历史字符串引用迁移到正式的 modelId 外键列。 */
export const migrateAgentConfigModelId = {
  name: "migrate-agent-config-model-id",
  async run(): Promise<void> {
    const rows = await _deps.listPendingRows();
    for (const row of rows) {
      if (row.modelId || !row.model?.trim()) {
        continue;
      }

      const nextModelId = await resolveTargetModelId(row);
      if (!nextModelId) {
        continue;
      }

      await _deps.updateAgentConfigModel(row.id, nextModelId);
      _deps.log(`[data-migrate] migrated agentConfig model id='${row.id}'`);
    }
  },
};
