/**
 * 知识库检索测试与知识图谱的应用 Facade。
 *
 * 立这一层之前的形态是：协议层把 `authCtx.organizationId` / `authCtx.userId` 与知识库 ID 一起塞进服务入参，
 * 服务再自己读知识库行、自己解析 RAGFlow key。授权因此不在任何一个可测的门面上，协议层也无法判断
 * 「这个 ID 现在能不能被当前调用者访问」。
 *
 * 现在这五条端点先按当前组织解析知识库上下文，再调用领域服务并收敛结果。
 *
 * 知识库不存在或不属于当前组织时统一返回 404，且在访问 provider 前拒绝请求。
 */

import type {
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
  KnowledgeRetrievalDetailedResult,
  MetaDataFilter,
} from "../services/knowledge-provider/types";
import {
  deleteKnowledgeGraphForKb,
  generateKnowledgeGraphForKb,
  getKnowledgeGraphForKb,
  pollKnowledgeGraphProgressForKb,
  searchKnowledgeForTest,
} from "../services/knowledge-runtime";
import type { KnowledgeAccess, KnowledgeBaseActor } from "./knowledge-access";
import { knowledgeAccess } from "./knowledge-access";
import { type KnowledgeResult, knowledgeFail, knowledgeOk, knowledgeUpstream } from "./knowledge-result";

/** 迁移前服务在知识库缺失时抛出的文案；两个协议面的对外响应都逐字沿用它。 */
const BASE_NOT_FOUND_MESSAGE = "Knowledge base not found";

/** 图谱数据结构。 */
export interface KnowledgeGraphPayload {
  readonly graph: { nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[] };
  readonly mind_map?: unknown;
}

/** 图谱生成进度。 */
export interface KnowledgeGraphProgress {
  readonly progress: number;
  readonly progressMsg?: string;
  readonly taskId?: string;
}

/** 检索测试的请求数据（知识库与调用者不在其中）。 */
export interface KnowledgeSearchInput {
  readonly query: string;
  readonly topK: number;
  readonly similarityThreshold?: number;
  readonly vectorSimilarityWeight?: number;
  readonly rerankId?: string | null;
  readonly keyword?: boolean;
  readonly highlight?: boolean;
  readonly pageSize?: number;
  readonly page?: number;
  readonly useKg?: boolean;
  readonly crossLanguages?: string[];
  readonly metaDataFilter?: MetaDataFilter;
}

/** 检索与图谱的应用接口。 */
export interface KnowledgeRuntimeFacade {
  /** 检索测试；知识库不存在时为 `not-found`（协议层 404），其余 provider 异常为 `upstream`。 */
  search(
    actor: KnowledgeBaseActor,
    knowledgeBaseId: string,
    input: KnowledgeSearchInput,
  ): Promise<KnowledgeResult<KnowledgeRetrievalDetailedResult>>;
  /** 触发图谱生成；知识库不可见时返回 `not-found`。 */
  generateGraph(actor: KnowledgeBaseActor, knowledgeBaseId: string): Promise<KnowledgeResult<null>>;
  /** 读取图谱数据（可能为 `null`，表示远端没有图谱）。 */
  getGraph(actor: KnowledgeBaseActor, knowledgeBaseId: string): Promise<KnowledgeResult<KnowledgeGraphPayload | null>>;
  /** 删除图谱。 */
  deleteGraph(actor: KnowledgeBaseActor, knowledgeBaseId: string): Promise<KnowledgeResult<null>>;
  /** 查询图谱生成进度。 */
  pollGraphProgress(
    actor: KnowledgeBaseActor,
    knowledgeBaseId: string,
  ): Promise<KnowledgeResult<KnowledgeGraphProgress>>;
}

/** 错误消息提取：非 Error 上抛时用业务文案兜底（与迁移前的兜底一致）。 */
function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** 构造门面；`access` 是可注入的解析端口（默认进程级实现，见 `./knowledge-access`）。 */
export function createKnowledgeRuntimeFacade(access: KnowledgeAccess = knowledgeAccess): KnowledgeRuntimeFacade {
  return {
    search: async (actor, knowledgeBaseId, input) => {
      const context = await access.resolveOwnedRemoteBase(actor, knowledgeBaseId);
      if (!context) return knowledgeFail("not-found", "NOT_FOUND", BASE_NOT_FOUND_MESSAGE);
      try {
        return knowledgeOk(await searchKnowledgeForTest({ kb: context.kb, credential: context.credential, ...input }));
      } catch (err) {
        console.error("[knowledge-bases] search failed", { knowledgeBaseId, err });
        const message = messageOf(err, "知识库检索测试失败");
        // 迁移前按文案分类：`not found` 走 404，其余上游异常走 502。
        if (message.includes("not found")) {
          return knowledgeFail("not-found", "NOT_FOUND", message);
        }
        return knowledgeUpstream(message);
      }
    },

    generateGraph: async (actor, knowledgeBaseId) => {
      const context = await access.resolveOwnedRemoteBase(actor, knowledgeBaseId);
      if (!context) return knowledgeFail("not-found", "NOT_FOUND", BASE_NOT_FOUND_MESSAGE);
      try {
        await generateKnowledgeGraphForKb({ kb: context.kb, credential: context.credential });
        return knowledgeOk(null);
      } catch (err) {
        console.error("[knowledge-bases] graph generate failed", { knowledgeBaseId, err });
        return knowledgeUpstream(messageOf(err, "知识图谱生成失败"));
      }
    },

    getGraph: async (actor, knowledgeBaseId) => {
      const context = await access.resolveOwnedRemoteBase(actor, knowledgeBaseId);
      if (!context) return knowledgeFail("not-found", "NOT_FOUND", BASE_NOT_FOUND_MESSAGE);
      try {
        return knowledgeOk(await getKnowledgeGraphForKb({ kb: context.kb, credential: context.credential }));
      } catch (err) {
        console.error("[knowledge-bases] graph get failed", { knowledgeBaseId, err });
        return knowledgeUpstream(messageOf(err, "获取知识图谱失败"));
      }
    },

    deleteGraph: async (actor, knowledgeBaseId) => {
      const context = await access.resolveOwnedRemoteBase(actor, knowledgeBaseId);
      if (!context) return knowledgeFail("not-found", "NOT_FOUND", BASE_NOT_FOUND_MESSAGE);
      try {
        await deleteKnowledgeGraphForKb({ kb: context.kb, credential: context.credential });
        return knowledgeOk(null);
      } catch (err) {
        console.error("[knowledge-bases] graph delete failed", { knowledgeBaseId, err });
        return knowledgeUpstream(messageOf(err, "删除知识图谱失败"));
      }
    },

    pollGraphProgress: async (actor, knowledgeBaseId) => {
      const context = await access.resolveOwnedRemoteBase(actor, knowledgeBaseId);
      if (!context) return knowledgeFail("not-found", "NOT_FOUND", BASE_NOT_FOUND_MESSAGE);
      try {
        return knowledgeOk(await pollKnowledgeGraphProgressForKb({ kb: context.kb, credential: context.credential }));
      } catch (err) {
        console.error("[knowledge-bases] graph progress failed", { knowledgeBaseId, err });
        return knowledgeUpstream(messageOf(err, "查询图谱进度失败"));
      }
    },
  };
}

/** 进程级无状态实现。 */
export const knowledgeRuntimeFacade: KnowledgeRuntimeFacade = createKnowledgeRuntimeFacade();
