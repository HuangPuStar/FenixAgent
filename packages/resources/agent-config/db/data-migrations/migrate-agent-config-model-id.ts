/**
 * agent_config 的历史 `model` 文本引用回填成正式的 `modelId` 外键列（§6.3 数据迁移按模块归属维护）。
 *
 * 为什么归 agent-config：本迁移收敛的正是本包 owner 的 `agent_config` 表的历史形态，按 §6.3
 * 「迁移代码归发起变更的模块」随 schema 一起搬进本包。放在 `db/data-migrations/` 而不是 `src/**`：
 * 迁移要直读 `provider` / `model` 两张别包 owner 的表来解析引用（§6.3「迁移使用受限的
 * repository/SQL adapter，不得调用运行中的 service」——运行中的 service 行为可能已不兼容历史数据），
 * 而 §6.1 的组装期例外只对 `packages/**` 的 `db/**` 开跨包读表的口子，留在 `src/**` 就是调用期违规。
 *
 * 库句柄经本包 `getAgentConfigDatabase()` 取：宿主在装配期注册句柄，部署期入口
 * `db/data-migration-runner.ts` 也在执行任何迁移前完成同一初始化，因此包侧取值与宿主直连是同一个
 * 连接池。每次调用重新取、不在模块作用域缓存——模块加载期宿主的
 * `initializeApplicationInfrastructure()` 可能尚未执行。
 */
import { agentConfig } from "@fenix/agent-config/db";
import { model, provider } from "@fenix/model-management/db";
import type { DataMigration } from "@fenix/platform-sdk";
import { and, eq, or } from "drizzle-orm";
import { getAgentConfigDatabase } from "../../src/server/db";

/** 待迁移行的投影：历史 `model` 文本与已就位的 `modelId` 并存，用于判定该行是否仍需解析。 */
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
  listPendingRows: async (): Promise<AgentConfigModelMigrationRow[]> => {
    const db = getAgentConfigDatabase();
    return db
      .select({
        id: agentConfig.id,
        organizationId: agentConfig.organizationId,
        modelId: agentConfig.modelId,
        model: agentConfig.model,
      })
      .from(agentConfig);
  },
  findStableProvider: async (organizationId: string, providerId: string): Promise<ProviderLookupRow | null> => {
    const db = getAgentConfigDatabase();
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
  findLegacyProviders: async (organizationId: string, providerName: string): Promise<ProviderLookupRow[]> => {
    const db = getAgentConfigDatabase();
    return db
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
  },
  findModelRow: async (
    organizationId: string,
    providerId: string,
    modelName: string,
  ): Promise<ModelLookupRow | null> => {
    const db = getAgentConfigDatabase();
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
    const db = getAgentConfigDatabase();
    await db
      .update(agentConfig)
      .set({
        modelId: nextModelId,
        model: null,
        updatedAt: new Date(),
      })
      .where(eq(agentConfig.id, agentConfigId));
  },
};

export function _resetDeps() {
  _deps.listPendingRows = async () => {
    const db = getAgentConfigDatabase();
    return db
      .select({
        id: agentConfig.id,
        organizationId: agentConfig.organizationId,
        modelId: agentConfig.modelId,
        model: agentConfig.model,
      })
      .from(agentConfig);
  };
  _deps.findStableProvider = async (organizationId: string, providerId: string) => {
    const db = getAgentConfigDatabase();
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
  _deps.findLegacyProviders = async (organizationId: string, providerName: string) => {
    const db = getAgentConfigDatabase();
    return db
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
  };
  _deps.findModelRow = async (organizationId: string, providerId: string, modelName: string) => {
    const db = getAgentConfigDatabase();
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
    const db = getAgentConfigDatabase();
    await db
      .update(agentConfig)
      .set({
        modelId: nextModelId,
        model: null,
        updatedAt: new Date(),
      })
      .where(eq(agentConfig.id, agentConfigId));
  };
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

/** 仍是历史形态、等待迁移的行：有旧 `model` 引用但还没有正式 `modelId`。 */
function hasPendingLegacyModelRef(row: AgentConfigModelMigrationRow): boolean {
  return !row.modelId && Boolean(row.model?.trim());
}

/** 启动迁移：把 agent_config.model 的历史字符串引用迁移到正式的 modelId 外键列。 */
export const migrateAgentConfigModelId: DataMigration = {
  name: "migrate-agent-config-model-id",
  // 只读 provider / model 的当前状态来解析引用，不依赖任何其他数据迁移的写入结果。
  dependsOn: [],
  metadata: {
    expectedRows:
      "与历史 agent_config 总数同阶；实际写入的是「model 非空且 modelId 为空」的子集，全新库与已完成迁移的库为 0 行",
    // 逐行 UPDATE 且每条语句独立提交，行锁只作用于被写行、写毕即释放；不包长事务，中断后已写入的行是完成态。
    lockRisk: "row-level",
    observableFields: ["agentConfigId", "modelId"],
  },
  async run(context) {
    const rows = await _deps.listPendingRows();
    for (const row of rows) {
      if (!hasPendingLegacyModelRef(row)) {
        continue;
      }

      const nextModelId = await resolveTargetModelId(row);
      if (!nextModelId) {
        continue;
      }

      await _deps.updateAgentConfigModel(row.id, nextModelId);
      context.log(`[data-migrate] migrated agentConfig model id='${row.id}'`);
    }
  },
  async verify() {
    const rows = await _deps.listPendingRows();
    const pending = rows.filter(hasPendingLegacyModelRef);
    if (pending.length > 0) {
      // 判据与 run 的跳过条件同源：run 正常返回后这里必然为 0，非 0 说明写入未覆盖或字段被并发改回。
      throw new Error(
        `[data-migrate] 仍有 ${pending.length} 个 agentConfig 的历史 model 引用未迁移到 modelId（如 '${pending[0]?.id}'）`,
      );
    }
  },
  compensation: {
    kind: "none",
    // run 把旧 `model` 字符串解析成 `modelId` 后清空原文，原文不落任何副本，补偿无法重建旧值。
    // 失败时已写入的行处于「新栈可读」的完成态，重跑会按 hasPendingLegacyModelRef 跳过并继续处理余下行。
    reason: "旧 model 原文被清空且不保留副本，撤销只会让该行彻底失去模型配置；靠幂等重跑收敛",
  },
};
