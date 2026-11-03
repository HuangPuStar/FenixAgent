/** Knowledge application authorization and lifecycle; external lists stay organization-scoped. */
import { checkApiKnowledgeStatus } from "../services/api-v1-knowledge";
import {
  createKnowledgeBaseRecord,
  deleteKnowledgeBase,
  getKnowledgeBaseDetail,
  type KnowledgeBaseListItem,
  updateKnowledgeBase,
} from "../services/knowledge-base";
import {
  importRemoteKnowledgeBase,
  listUnassociatedRemoteKnowledgeBases,
  type UnassociatedRemoteKnowledgeBase,
} from "../services/knowledge-base-import";
import {
  type KnowledgeBaseVisibility,
  listVisibleKnowledgeBases,
  syncRemoteState,
} from "../services/knowledge-base-list";
import { type KnowledgeAccess, type KnowledgeBaseActor, knowledgeAccess } from "./knowledge-access";
import {
  type KnowledgeResult,
  knowledgeFail,
  knowledgeNotFound,
  knowledgeOk,
  knowledgeUpstream,
} from "./knowledge-result";

// 主体投影与结果信封定义在 `./knowledge-access` / `./knowledge-result`，这里转出以保持门面入口的完整性。
export type { KnowledgeBaseActor, KnowledgeBaseCredential } from "./knowledge-access";
export type { KnowledgeResult } from "./knowledge-result";

/** 对外列表的一页：`total` 与 `items` 必须描述同一个可见集合（分页与计数共用可见条件）。 */
export interface KnowledgeBasePage {
  readonly items: KnowledgeBaseListItem[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

/** 创建知识库的请求数据；组织与创建者不在其中（它们取自 actor）。 */
export interface CreateKnowledgeBasePayload {
  readonly name: string;
  readonly slug?: string;
  readonly description?: string;
  readonly embeddingModel?: string | null;
  readonly parseMethod?: "builtin" | "pipeline" | null;
  readonly pipelineId?: string | null;
  readonly chunkMethod?: string | null;
}

/** 更新知识库的请求数据。 */
export interface UpdateKnowledgeBasePayload {
  readonly name?: string;
  readonly slug?: string;
  readonly description?: string;
}

/** 导入远端知识库的请求数据。 */
export interface ImportRemoteKnowledgeBasePayload {
  readonly name: string;
  readonly remoteId: string;
}

/**
 * 控制台列表的可见范围：只有本组织的知识库。
 *
 * 取值是**业务语义**而不是实现细节，因此留在门面上（服务与仓储照它下推条件，不是各自默认）。
 */
const CONSOLE_VISIBILITY: KnowledgeBaseVisibility = "organization";

/**
 * 对外已发布列表的可见范围：仅当前组织已有知识库。
 *
 * 与控制台分开声明是刻意的：两者由不同协议面消费，改动其中一个不应带动另一个。
 */
const EXTERNAL_VISIBILITY: KnowledgeBaseVisibility = "organization";

/** 错误消息提取：非 Error 上抛时用业务文案兜底（与迁移前的兜底一致）。 */
function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * 知识库本体的应用接口（Facade 的契约面）。
 *
 * 路由只依赖这组方法；用例可以注入替身而不触达真实数据库。组织范围由实现内部推导——调用方无法通过
 * 查询串或请求体影响自己读到哪个组织的知识库。
 */
export interface KnowledgeBaseFacade {
  /**
   * 控制台列表（`/web/knowledgeBases`）：仅本组织，不分页。
   *
   * 除读取外还做一次远端状态回填（`syncRemoteState`）：远端数据集已不存在时在响应里标记，本地缺失的
   * 配置回填为远端值。回填是跨系统副作用，故由本层决定什么时候做，而不是让读取函数顺带完成。
   */
  listForConsole(actor: KnowledgeBaseActor): Promise<KnowledgeBaseListItem[]>;
  /**
   * 对外已发布列表（`/api/v1/knowledge-bases`）：仅本组织，分页在数据库完成。
   *
   * 页码与页大小由本层夹紧（与协议层给的默认值一致），偏移量与计数由领域服务下推——协议层不做内存切片。
   */
  listForExternal(
    actor: KnowledgeBaseActor,
    page: number,
    pageSize: number,
    signal?: AbortSignal,
  ): Promise<{
    items: Awaited<ReturnType<typeof checkApiKnowledgeStatus>>;
    total: number;
    page: number;
    pageSize: number;
  }>;
  /** 详情；跨组织与不存在返回同一个 `not-found`（不给出可探测的差异）。 */
  getDetail(actor: KnowledgeBaseActor, knowledgeBaseId: string): Promise<KnowledgeResult<KnowledgeBaseListItem>>;
  /**
   * 创建知识库：组织与创建者取自 actor。
   *
   * 凭据先解析：未配置 RAGFlow 时与输入非法同码（400 `VALIDATION_ERROR`），与迁移前一致——那时这条解析
   * 在协议层、且映射为同一个响应。
   */
  create(
    actor: KnowledgeBaseActor,
    payload: CreateKnowledgeBasePayload,
  ): Promise<KnowledgeResult<KnowledgeBaseListItem>>;
  /** 更新名称/slug/描述；跨组织与不存在返回同一个 `not-found`。 */
  update(
    actor: KnowledgeBaseActor,
    knowledgeBaseId: string,
    payload: UpdateKnowledgeBasePayload,
  ): Promise<KnowledgeResult<KnowledgeBaseListItem>>;
  /** 删除知识库（含远端数据集与绑定）；跨组织与不存在返回同一个 `not-found`。 */
  remove(actor: KnowledgeBaseActor, knowledgeBaseId: string): Promise<KnowledgeResult<null>>;
  /** 列出远端已有、当前组织尚未导入的知识库（远端不可用时 `upstream`）。 */
  listUnassociatedRemote(actor: KnowledgeBaseActor): Promise<KnowledgeResult<UnassociatedRemoteKnowledgeBase[]>>;
  /** 导入远端知识库；已在当前组织关联时 `conflict`（协议层映射 409）。 */
  importRemote(
    actor: KnowledgeBaseActor,
    payload: ImportRemoteKnowledgeBasePayload,
  ): Promise<KnowledgeResult<KnowledgeBaseListItem>>;
}

/**
 * 构造门面。
 *
 * `access` 是可注入的端口，默认是进程级解析器；注入点存在的理由是「用谁的身份解析凭据、以谁的组织判定
 * 归属」必须可断言（见 `./knowledge-access` 的说明）。
 */
export function createKnowledgeBaseFacade(access: KnowledgeAccess = knowledgeAccess): KnowledgeBaseFacade {
  return {
    listForConsole: async (actor) => {
      const { items } = await listVisibleKnowledgeBases({
        organizationId: actor.organizationId,
        visibility: CONSOLE_VISIBILITY,
      });
      await syncRemoteState(items);
      return items;
    },

    listForExternal: async (actor, page, pageSize, signal) => {
      const { items, total } = await listVisibleKnowledgeBases({
        organizationId: actor.organizationId,
        visibility: EXTERNAL_VISIBILITY,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      return { items: await checkApiKnowledgeStatus(items, signal), total, page, pageSize };
    },

    getDetail: async (actor, knowledgeBaseId) => {
      const kb = await access.resolveOwnedBase(actor, knowledgeBaseId);
      if (!kb) return knowledgeNotFound("知识库不存在");
      return knowledgeOk(await getKnowledgeBaseDetail(kb));
    },

    create: async (actor, payload) => {
      let apiKey: string;
      try {
        apiKey = await access.credentialFor(actor)();
      } catch (err) {
        return knowledgeFail("invalid", "VALIDATION_ERROR", messageOf(err, "RAGFlow 凭据解析失败"));
      }
      try {
        const result = await createKnowledgeBaseRecord(actor.organizationId, { ...payload, apiKey }, actor.userId);
        if (!result.success) {
          return knowledgeFail("invalid", result.error.code, result.error.message);
        }
        return knowledgeOk(result.data);
      } catch (err) {
        console.error(err);
        return knowledgeUpstream(messageOf(err, "知识库上游服务异常"));
      }
    },

    update: async (actor, knowledgeBaseId, payload) => {
      const kb = await access.resolveOwnedBase(actor, knowledgeBaseId);
      if (!kb) return knowledgeNotFound("知识库不存在");
      const result = await updateKnowledgeBase(kb, payload);
      if (!result.success) {
        const kind = result.error.code === "NOT_FOUND" ? "not-found" : "invalid";
        return knowledgeFail(kind, result.error.code, result.error.message);
      }
      return knowledgeOk(result.data);
    },

    remove: async (actor, knowledgeBaseId) => {
      const kb = await access.resolveOwnedBase(actor, knowledgeBaseId);
      if (!kb) return knowledgeNotFound("知识库不存在");
      try {
        // 凭据惰性：无远端数据集的历史记录不解析凭据（见 `../services/knowledge-credential`）。
        await deleteKnowledgeBase(kb, access.credentialFor(actor));
        return knowledgeOk(null);
      } catch (err) {
        console.error(err);
        return knowledgeFail("failed", "DELETE_FAILED", messageOf(err, "删除知识库失败"));
      }
    },

    listUnassociatedRemote: async (actor) => {
      try {
        return knowledgeOk(
          await listUnassociatedRemoteKnowledgeBases(actor.organizationId, access.credentialFor(actor)),
        );
      } catch (err) {
        return knowledgeUpstream(messageOf(err, "知识库上游服务异常"));
      }
    },

    importRemote: async (actor, payload) => {
      try {
        const result = await importRemoteKnowledgeBase({
          organizationId: actor.organizationId,
          userId: actor.userId,
          remoteId: payload.remoteId,
          name: payload.name,
          credential: access.credentialFor(actor),
        });
        if (result.status === "conflict") {
          return knowledgeFail("conflict", "VALIDATION_ERROR", "该知识库已在当前范围中关联，无需重复导入");
        }
        return knowledgeOk(result.detail);
      } catch (err) {
        return knowledgeUpstream(messageOf(err, "知识库上游服务异常"));
      }
    },
  };
}

/** 进程级无状态实现：门面不持有连接、缓存或 actor，每次调用只用入参推导范围。 */
export const knowledgeBaseFacade: KnowledgeBaseFacade = createKnowledgeBaseFacade();
