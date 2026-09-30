/**
 * 知识库端点的授权与归属解析（Facade 层公共契约）。
 *
 * 立这一层之前，「这条知识库属于当前组织吗」「调远端用哪个身份取凭据」写在领域服务里
 * （`services/knowledge-base-access`、`services/knowledge-upload` 的 `resolveKb`、`services/knowledge-runtime`
 * 的 `resolveKbWithApiKey` 各写一份），协议层则把 `authCtx.organizationId` / `authCtx.userId` 按位置传给
 * 领域服务。授权因此分散在服务层、同一条规则有三处实现，改错一处不会有人发现。现在收敛成一件本层可测的
 * 事：**actor → 已授权的知识库行（+ 绑定了身份的凭据）**，服务只按这份上下文访问远端。
 *
 * 组织边界：知识库不在五张受控资源主表之列（无 `visibility` 列），本包不接 `@fenix/access-control`，
 * 租户边界就是「会话守卫已认证的 active organization」。**跨组织的知识库与不存在的知识库返回同一个
 * `undefined`**：区分两者会让知识库 ID 成为跨组织探测面，与 `/web/knowledgeBases/:id` 详情的 404 口径一致。
 *
 * 检索、图谱和原文件预览都必须先校验知识库组织归属。旧实现按 ID 直接访问远端，
 * 会把其它组织的分块、图谱和文件暴露给已认证用户。
 *
 * 凭据：解析动作（`resolveRagflowApiKey`）本身不在这里，这里只固定「**用谁的身份**去解析」——控制台端点
 * 用调用者，远端原文件下载用知识库属主（RAGFlow 中 dataset 属于属主）。收成 {@link KnowledgeBaseCredential}
 * （取值动作）而不是解析好的字符串，是因为**什么时候取**属于领域服务的分支语义：删除未同步的知识库、
 * 刷新远端失败退回本地缓存这两条路径在迁移前根本不解析凭据，门面若提前解析会把它们变成失败。
 */

import type { KnowledgeBaseRow, KnowledgeResourceRow } from "../repositories/knowledge-base";
import { knowledgeBaseRepo, knowledgeResourceRepo } from "../repositories/knowledge-base";
import type { KnowledgeBaseCredential } from "../services/knowledge-credential";
import { resolveRagflowApiKey } from "../services/ragflow-key";

/**
 * 本层接受的最小主体投影。
 *
 * 只取用到的两个字段，不 import 宿主 `AuthContext`（那是 `apps/server` 协议层的类型，包一旦依赖它
 * 就无法独立构建）：组织是租户边界，用户是远端凭据的解析身份。宿主的 `AuthContext` 是它的结构超集，
 * 调用点无需转换；`role` / `memberships` 不进入本层判断——本资源的可见范围只由组织归属决定。
 */
export interface KnowledgeBaseActor {
  readonly organizationId: string;
  readonly userId: string;
}

/** 领域服务侧的远端凭据端口（定义在服务层，这里转出给路由与其他门面）。 */
export type { KnowledgeBaseCredential };

/** 凭据供应者：把身份换成一次取远端凭据的动作；测试可注入替身以断言用的是哪个身份。 */
export type KnowledgeCredentialProvider = (identity: KnowledgeBaseActor) => KnowledgeBaseCredential;

/**
 * 生产凭据：模块配置里的全局 RAGFlow key。
 *
 * 入参仍是既有调用面（历史支持按 scope / 用户解析，当前实现只读全局 key）——本模块固定的是解析身份，
 * 换实现时不需要动任何调用点。
 */
export const ragflowCredentialProvider: KnowledgeCredentialProvider = (identity) => () =>
  resolveRagflowApiKey("global", identity.userId, identity.organizationId);

/** 知识库上下文：行 + 已绑定身份的凭据。是否做过组织判定由产出它的方法说明。 */
export interface KnowledgeBaseContext {
  readonly kb: KnowledgeBaseRow;
  readonly credential: KnowledgeBaseCredential;
}

/**
 * 归属与凭据解析。
 *
 * 除 {@link KnowledgeAccess.credentialFor} 外都**不抛错**：解析不到就是 `undefined`，由各门面决定映射成
 * 哪种对外失败。
 */
export interface KnowledgeAccess {
  /**
   * 本组织的知识库行；跨组织与不存在同形（`undefined`）。
   *
   * 用于不需要访问远端的动作（详情、更新）：这些路径在迁移前完全不解析凭据，这里也不解析。
   */
  resolveOwnedBase(actor: KnowledgeBaseActor, knowledgeBaseId: string): Promise<KnowledgeBaseRow | undefined>;
  /**
   * 本组织的知识库行 + **调用者身份**的凭据；跨组织与不存在同形（`undefined`）。
   *
   * 控制台上传、导入、列表刷新、资源删除、切片与图谱等需要访问远端的动作使用。
   */
  resolveOwnedRemoteBase(actor: KnowledgeBaseActor, knowledgeBaseId: string): Promise<KnowledgeBaseContext | undefined>;
  /**
   * 本组织的资源原文件远端下载解析；凭据绑定**知识库属主**。
   *
   * 身份是属主而不是调用者，与其余端点相反且是有意的：RAGFlow 中 dataset 属于属主，下载原文件要用属主的
   * 凭据。知识库未同步远端（无 `remoteId`）与不存在返回同一个 `undefined`——两种情况都没有可下载的远端文件。
   */
  resolveRemoteFileBase(actor: KnowledgeBaseActor, knowledgeBaseId: string): Promise<KnowledgeBaseContext | undefined>;
  /**
   * 资源必须属于该知识库，否则 `undefined`。
   *
   * 路径里的 `:id` 与 `:resourceId` 必须指向同一条记录，否则一个知识库的 URL 就能取到另一个知识库的资源。
   */
  findResourceInBase(knowledgeBaseId: string, resourceId: string): Promise<KnowledgeResourceRow | undefined>;
  /** 按身份构造凭据供应；需要先行解析（如创建知识库时把凭据缺失映射成输入错误）的动作直接调用它。 */
  credentialFor(identity: KnowledgeBaseActor): KnowledgeBaseCredential;
}

/**
 * 构造解析器。
 *
 * `credential` 是可注入的端口，默认读模块配置里的全局 key；注入点存在的理由是「用谁的身份解析凭据」必须
 * 可断言——否则把它换成知识库属主或常量都不会有任何测试变红。
 */
export function createKnowledgeAccess(
  credential: KnowledgeCredentialProvider = ragflowCredentialProvider,
): KnowledgeAccess {
  const readBase = async (knowledgeBaseId: string): Promise<KnowledgeBaseRow | null> =>
    knowledgeBaseRepo.getById(knowledgeBaseId);

  return {
    resolveOwnedBase: async (actor, knowledgeBaseId) => {
      const kb = await readBase(knowledgeBaseId);
      if (!kb) return;
      if (kb.organizationId !== actor.organizationId) return;
      return kb;
    },

    resolveOwnedRemoteBase: async (actor, knowledgeBaseId) => {
      const kb = await readBase(knowledgeBaseId);
      if (!kb) return;
      if (kb.organizationId !== actor.organizationId) return;
      return { kb, credential: credential(actor) };
    },

    resolveRemoteFileBase: async (actor, knowledgeBaseId) => {
      const kb = await readBase(knowledgeBaseId);
      if (!kb?.remoteId || kb.organizationId !== actor.organizationId) return;
      return { kb, credential: credential({ organizationId: actor.organizationId, userId: kb.userId }) };
    },

    findResourceInBase: async (knowledgeBaseId, resourceId) => {
      const resource = await knowledgeResourceRepo.getById(resourceId);
      if (resource?.knowledgeBaseId !== knowledgeBaseId) return;
      return resource;
    },

    credentialFor: (identity) => credential(identity),
  };
}

/** 进程级无状态实现：解析器不持有连接、缓存或 actor，每次调用只用入参推导范围。 */
export const knowledgeAccess: KnowledgeAccess = createKnowledgeAccess();
