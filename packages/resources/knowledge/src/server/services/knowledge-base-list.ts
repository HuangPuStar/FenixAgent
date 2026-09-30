/**
 * 知识库「可见集合」的列表读模型。
 *
 * 两个协议入口共用本模块：
 * - `/web/knowledgeBases`（控制台列表）：仅本组织，额外做远端状态回填，没有分页参数；
 * - `/api/knowledge-bases`（对外已发布列表）：并入跨组织共享的全局知识库，分页与计数在数据库完成。
 *
 * 差别只有可见范围与是否回填远端状态；查询、计数与 DTO 组装是同一份实现，协议层不再各自合并数组，
 * 也不做内存切片。可见条件的定义在仓储（`visibleWhere` / `visibleOrder`），本模块只声明范围。
 *
 * 计数与列表共用同一份可见条件：`total` 必须描述分页所作用的那一个集合，否则翻页会翻出集合之外。
 */

import type { KnowledgeBaseRow } from "../repositories/knowledge-base";
import { knowledgeBaseRepo, knowledgeResourceRepo } from "../repositories/knowledge-base";
import { countKnowledgeBaseBindings, type KnowledgeBaseListItem, sanitizeKnowledgeBase } from "./knowledge-base";
import { mergeKnowledgeBaseMetadata, readKnowledgeBaseMetadata } from "./knowledge-metadata";
import { getKnowledgeProvider } from "./knowledge-provider/registry";
import { resolveRagflowApiKey } from "./ragflow-key";

/**
 * 可见范围。
 *
 * `organization`：仅本组织的知识库（控制台列表）。
 * `organization-and-global`：并入"全局（跨组织共享）"的知识库，即对外列表的既有语义。
 */
export type KnowledgeBaseVisibility = "organization" | "organization-and-global";

/** 可见集合的读取参数。 */
export interface ListVisibleKnowledgeBasesInput {
  readonly organizationId: string;
  readonly visibility: KnowledgeBaseVisibility;
  /** 页大小；不传表示不分页（控制台列表）。 */
  readonly limit?: number;
  /** 页偏移；不传表示从可见集合的第一行开始。 */
  readonly offset?: number;
}

/** 可见集合的一页：`items` 是当前页，`total` 是同一可见条件的总数。 */
export interface VisibleKnowledgeBasesPage {
  readonly items: KnowledgeBaseListItem[];
  readonly total: number;
}

/**
 * 分页读取可见知识库。
 *
 * 排序由仓储给出（本组织行优先，其余按更新时间倒序），与"两个来源数组拼接"的旧口径一致；可见集合是
 * 一份结果集，因此同一个知识库不会同时以"本组织"和"全局"两种身份重复出现。
 */
export async function listVisibleKnowledgeBases(
  input: ListVisibleKnowledgeBasesInput,
): Promise<VisibleKnowledgeBasesPage> {
  const scope = {
    organizationId: input.organizationId,
    includeGlobal: input.visibility === "organization-and-global",
  };
  const [rows, total] = await Promise.all([
    knowledgeBaseRepo.listVisible({
      ...scope,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.offset === undefined ? {} : { offset: input.offset }),
    }),
    knowledgeBaseRepo.countVisible(scope),
  ]);
  return { items: await withCounts(rows), total };
}

/** 逐行补齐绑定数与资源数；查询次数与当前页条数成正比，与可见集合的总数无关。 */
async function withCounts(rows: KnowledgeBaseRow[]): Promise<KnowledgeBaseListItem[]> {
  return Promise.all(
    rows.map(async (row) =>
      sanitizeKnowledgeBase(row, {
        bindingsCount: await countKnowledgeBaseBindings(row.id),
        resourcesCount: await knowledgeResourceRepo.countByKnowledgeBase(row.id),
      }),
    ),
  );
}

/**
 * 并发校验 RAGFlow 端知识库是否仍存在，并把本地缺失的配置回填进来（就地修改传入的列表项）。
 *
 * 导出给 Facade：这是跨系统的副作用（逐条问 RAGFlow 是否仍存在、按需回填本地配置），属于「什么时候做
 * 远端协作」的应用层编排——可见范围与是否回填由 Facade 决定，本模块只提供这段领域动作。
 *
 * 上游不可用（网络异常、鉴权失败）不做任何标记：抖动不等于资源被删，误标会把可用知识库显示成已失效。
 * 只有明确"远端已不存在"才置 `remoteExists = false`；配置回填只补本地为空的字段，不覆盖用户显式
 * 选择过的模型与分块方法。
 */
export async function syncRemoteState(items: KnowledgeBaseListItem[]): Promise<void> {
  const provider = getKnowledgeProvider();
  if (!provider.getDataset) return;

  const checks = items
    .filter((kb) => kb.remoteId)
    .map(async (kb) => {
      try {
        const apiKey = await resolveRagflowApiKey("global", kb.userId, kb.organizationId ?? "");
        const dataset = await provider.getDataset!({ datasetId: kb.remoteId!, apiKey });
        if (!dataset) {
          kb.remoteExists = false;
          return;
        }

        const row = await knowledgeBaseRepo.getById(kb.id);
        if (!row) return;
        const currentMetadata = readKnowledgeBaseMetadata(row.metadata);
        let mergedMetadataJson = row.metadata;
        let changed = false;
        if (!currentMetadata.embeddingModel && dataset.embeddingModel) {
          mergedMetadataJson = mergeKnowledgeBaseMetadata(mergedMetadataJson, {
            embeddingModel: dataset.embeddingModel,
          });
          changed = true;
        }
        if (!currentMetadata.parseMethod && dataset.parseMethod) {
          mergedMetadataJson = mergeKnowledgeBaseMetadata(mergedMetadataJson, { parseMethod: dataset.parseMethod });
          changed = true;
        }
        if (!currentMetadata.chunkMethod && dataset.chunkMethod) {
          mergedMetadataJson = mergeKnowledgeBaseMetadata(mergedMetadataJson, { chunkMethod: dataset.chunkMethod });
          changed = true;
        }
        if (!changed) return;

        await knowledgeBaseRepo.update(kb.id, { metadata: mergedMetadataJson, updatedAt: new Date() });
        // 同步到本次响应：回填后的配置要立即体现在返回数据里，调用方不必再读一次详情。
        const mergedMetadata = readKnowledgeBaseMetadata(mergedMetadataJson);
        kb.embeddingModel = mergedMetadata.embeddingModel;
        kb.parseMethod = mergedMetadata.parseMethod;
        kb.chunkMethod = mergedMetadata.chunkMethod;
      } catch {
        /* 上游不可用不做标记 */
      }
    });
  await Promise.allSettled(checks);
}
