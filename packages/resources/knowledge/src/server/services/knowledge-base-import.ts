/**
 * 远端（RAGFlow）知识库的导入编排。
 *
 * 控制台的"导入未关联知识库"是两步：先列出远端已有、当前组织尚未导入的知识库；再把用户选中的那一个
 * 落到本地，并把远端的配置与资源清单同步进来。两步都以组织为单位，且都要回答"这一条是否已经在当前
 * 范围里"，因此放在同一模块，而不是散在路由分支里。
 *
 * 凭据按 {@link KnowledgeBaseCredential} 传入：解析身份由门面固定为调用者，本模块不接触 actor，也不决定
 * 归属——`organizationId` / `userId` 在这里是**写入范围与归属**（显式参数），不是权限判定。
 */

import { knowledgeBaseRepo, knowledgeResourceRepo } from "../repositories/knowledge-base";
import {
  generateKnowledgeBaseSlug,
  getKnowledgeBaseDetail,
  type KnowledgeBaseListItem,
  upsertKnowledgeBaseStatusFromResources,
} from "./knowledge-base";
import type { KnowledgeBaseCredential } from "./knowledge-credential";
import { mergeKnowledgeBaseMetadata } from "./knowledge-metadata";
import { getKnowledgeProvider } from "./knowledge-provider/registry";

/** 远端可用但当前组织尚未关联的知识库。 */
export interface UnassociatedRemoteKnowledgeBase {
  readonly id: string;
  readonly name: string;
}

/**
 * 列出远端未关联的知识库。
 *
 * 以"本组织已关联的远端 id"做差集：同一远端 dataset 在其他组织下已被导入不算冲突，各组织各自持有
 * 自己的本地记录。上游不可用时异常原样上抛，由协议层映射为 provider 错误（502），不降级成空列表——
 * 空列表会让用户以为远端没有可导入的知识库。
 */
export async function listUnassociatedRemoteKnowledgeBases(
  organizationId: string,
  credential: KnowledgeBaseCredential,
): Promise<UnassociatedRemoteKnowledgeBase[]> {
  const apiKey = await credential();
  const datasets = await getKnowledgeProvider().listDatasets({ apiKey });
  const rows = await knowledgeBaseRepo.listByOrganizationId(organizationId);
  const localRemoteIds = new Set(rows.map((row) => row.remoteId).filter((id): id is string => Boolean(id)));
  return datasets.filter((dataset) => !localRemoteIds.has(dataset.id));
}

/** 导入请求。 */
export interface ImportRemoteKnowledgeBaseInput {
  readonly organizationId: string;
  /** 本地记录归属人；同时作为远端租户身份（RAGFlow 中 dataset 属于导入者）。 */
  readonly userId: string;
  /** 远端 dataset id。 */
  readonly remoteId: string;
  readonly name: string;
  readonly credential: KnowledgeBaseCredential;
}

/**
 * 导入结果：`conflict` 表示该远端知识库已在当前组织关联（协议层映射为 409），`imported` 携带落库后的
 * 详情 DTO。
 */
export type ImportRemoteKnowledgeBaseResult =
  | { readonly status: "imported"; readonly detail: KnowledgeBaseListItem }
  | { readonly status: "conflict" };

/**
 * 把远端知识库导入当前组织。
 *
 * 冲突判定在写入前：同一远端 dataset 已在当前组织关联时返回 `conflict`，不再建第二条指向同一 dataset
 * 的本地记录（重复记录会让资源清单、绑定与状态各自漂移）。
 *
 * 落库之后的远端同步（配置回填 + 资源清单）失败只记录日志、不上抛：本地记录已经存在，把整个导入判为
 * 失败会把用户挡在"列表里能看到、却永远导入不了"的状态里；后续刷新资源列表会重新拉取远端状态。
 */
export async function importRemoteKnowledgeBase(
  input: ImportRemoteKnowledgeBaseInput,
): Promise<ImportRemoteKnowledgeBaseResult> {
  const orgRows = await knowledgeBaseRepo.listByOrganizationId(input.organizationId);
  const existingIds = new Set(orgRows.map((row) => row.remoteId).filter((id): id is string => Boolean(id)));
  if (existingIds.has(input.remoteId)) {
    return { status: "conflict" };
  }

  const now = new Date();
  const row = await knowledgeBaseRepo.create({
    userId: input.userId,
    organizationId: input.organizationId,
    name: input.name.trim(),
    slug: generateKnowledgeBaseSlug(input.name),
    provider: "ragflow",
    remoteId: input.remoteId,
    remoteAccountId: input.userId,
    remoteUserId: input.userId,
    status: "empty",
    createdAt: now,
    updatedAt: now,
  });

  await syncRemoteKnowledgeBase(input, row.id, now);
  return { status: "imported", detail: await getKnowledgeBaseDetail(row) };
}

/**
 * 回填远端配置并同步资源清单；失败只记录诊断上下文（见 {@link importRemoteKnowledgeBase}）。
 *
 * 资源行与知识库行共用同一个导入时刻，保持"一次导入的产物时间一致"这一可观测口径。
 */
async function syncRemoteKnowledgeBase(
  input: ImportRemoteKnowledgeBaseInput,
  knowledgeBaseId: string,
  importedAt: Date,
): Promise<void> {
  try {
    const apiKey = await input.credential();
    const provider = getKnowledgeProvider();
    if (provider.getDataset) {
      const dataset = await provider.getDataset({ datasetId: input.remoteId, apiKey });
      if (dataset) {
        await knowledgeBaseRepo.update(knowledgeBaseId, {
          updatedAt: new Date(),
          metadata: mergeKnowledgeBaseMetadata(null, {
            embeddingModel: dataset.embeddingModel ?? null,
            parseMethod: dataset.parseMethod ?? null,
            chunkMethod: dataset.chunkMethod ?? null,
          }),
        });
      }
    }

    const remoteResources = await provider.listResources({
      knowledgeBaseRemoteId: input.remoteId,
      remoteAccountId: input.userId,
      remoteUserId: input.userId,
      apiKey,
    });
    if (remoteResources.length === 0) return;

    for (const resource of remoteResources) {
      await knowledgeResourceRepo.create({
        knowledgeBaseId,
        sourceType: resource.sourceType,
        sourceName: resource.sourceName,
        sourcePath: resource.source ?? null,
        remoteId: resource.remoteId,
        status: resource.status,
        lastError: resource.lastError ?? null,
        createdAt: importedAt,
        updatedAt: importedAt,
      });
    }
    await upsertKnowledgeBaseStatusFromResources(knowledgeBaseId);
  } catch (error) {
    console.error("[knowledge] import resource sync failed:", error);
  }
}
