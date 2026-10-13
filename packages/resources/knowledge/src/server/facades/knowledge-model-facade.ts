/**
 * 知识库表单选项与嵌入模型管理的应用 Facade。
 *
 * 这组端点的共同点是「只回答上游（RAGFlow）当前的配置」，不接触知识库行，也没有归属判定；但它们的调用
 * 需要调用者身份——嵌入模型是 RAGFlow **租户级**配置，服务按 `(userId, organizationId)` 解析租户凭据。
 * 迁移前这条路在协议层完成（路由把 `authCtx.userId` / `authCtx.organizationId` 直接交给服务），现在由本层
 * 把 actor 换成显式身份：协议层不再出现组织与用户字段，组织范围也不可能随请求体变化。
 *
 * 为什么这里仍把身份传给服务、而不是像知识库端点那样先解析出凭据：服务侧的 `_keySource, userId, orgId`
 * 三参是既有调用面的占位（`services/ragflow-key` 的实现只读模块配置里的全局 key），删除它们属于接口
 * 收敛、有既定裁定的独立切片，本次不做（见本包回报）。
 *
 * 失败语义：
 * - 嵌入模型的 8 个动作整段收敛为 {@link KnowledgeResult}（迁移前协议层对整段 `catch` → 502 `KNOWLEDGE_PROVIDER_ERROR`）；
 * - {@link KnowledgeModelFacade.formOptions} 与 {@link KnowledgeModelFacade.rerankModels} **不收敛失败**：内部已逐项
 *   降级（上游不可用时对应目录返回空数组），未预期异常与迁移前一样上抛。
 */

import {
  addEmbeddingProvider,
  type ConfiguredProviderNode,
  deleteEmbeddingInstance,
  listConfiguredProviderTree,
  listEmbeddingFactories,
  listInstanceEmbeddingModels,
  listKnowledgeFormOptions,
  listProviderEmbeddingModels,
  setEmbeddingModelStatus,
  verifyEmbeddingProvider,
} from "../services/knowledge-base";
import type {
  FactoryOption,
  InstanceModelOption,
  KnowledgeFormOptions,
  ProviderModelOption,
  RerankModelOption,
} from "../services/knowledge-provider/types";
import { listRerankModelsForOrg } from "../services/knowledge-runtime";
import { type KnowledgeAccess, type KnowledgeBaseActor, knowledgeAccess } from "./knowledge-access";
import { type KnowledgeResult, knowledgeOk, knowledgeUpstream } from "./knowledge-result";

/** 服务的既有调用面占位：`_keySource, userId, orgId`（实现只读全局 key，见文件头）。 */
const KEY_SOURCE = "global";

/** 创建知识库表单的可选项。 */
export interface KnowledgeModelFacade {
  /** 创建表单可选项（嵌入模型、内置分块方法、pipeline）；上游不可用时对应字段为空数组。 */
  formOptions(actor: KnowledgeBaseActor): Promise<KnowledgeFormOptions>;
  /** 检索测试可用的重排序模型；上游不可用时为空数组。 */
  rerankModels(): Promise<RerankModelOption[]>;
  /** 已配置的 provider → instance → model 树。 */
  listConfiguredProviders(actor: KnowledgeBaseActor): Promise<KnowledgeResult<ConfiguredProviderNode[]>>;
  /** 可添加的嵌入模型厂商目录。 */
  listFactories(actor: KnowledgeBaseActor): Promise<KnowledgeResult<FactoryOption[]>>;
  /** 验证厂商连接（临时凭据，不落库）。 */
  verifyProvider(
    actor: KnowledgeBaseActor,
    input: { provider: string; providerApiKey: string; baseUrl?: string | null },
  ): Promise<KnowledgeResult<{ success: boolean; message?: string }>>;
  /** 厂商模型库（仅 embedding 类型）。 */
  listProviderModels(
    actor: KnowledgeBaseActor,
    input: { provider: string; providerApiKey: string; baseUrl?: string | null },
  ): Promise<KnowledgeResult<ProviderModelOption[]>>;
  /** 某实例下的模型（含 active/inactive 状态）。 */
  listInstanceModels(
    actor: KnowledgeBaseActor,
    input: { provider: string; instanceName: string },
  ): Promise<KnowledgeResult<InstanceModelOption[]>>;
  /** 添加厂商实例（含 api_key）；实例已存在时幂等成功。 */
  addProvider(
    actor: KnowledgeBaseActor,
    input: { provider: string; instanceName: string; providerApiKey: string; baseUrl?: string | null },
  ): Promise<KnowledgeResult<{ instanceName: string }>>;
  /** 删除厂商实例及其下的模型配置。 */
  removeProvider(
    actor: KnowledgeBaseActor,
    input: { provider: string; instanceName: string },
  ): Promise<KnowledgeResult<{ ok: true }>>;
  /** 屏蔽/取消屏蔽实例下的单个模型。 */
  setModelStatus(
    actor: KnowledgeBaseActor,
    input: { provider: string; instanceName: string; modelName: string; status: "active" | "inactive" },
  ): Promise<KnowledgeResult<{ ok: true }>>;
}

/** 错误消息提取：非 Error 上抛时用业务文案兜底（与迁移前的兜底一致）。 */
function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** 构造门面；`access` 用于推导调用者身份（见 `./knowledge-access`）。 */
export function createKnowledgeModelFacade(access: KnowledgeAccess = knowledgeAccess): KnowledgeModelFacade {
  /** 把整段 provider 调用收敛成 502：迁移前协议层对 action 分发整段 `catch`（含日志）。 */
  const upstream = async <T>(action: string, run: () => Promise<T>): Promise<KnowledgeResult<T>> => {
    try {
      return knowledgeOk(await run());
    } catch (err) {
      console.error(`[embedding-models] ${action} failed:`, err);
      return knowledgeUpstream(messageOf(err, "操作失败"));
    }
  };

  return {
    formOptions: async (actor) => {
      let apiKey: string | undefined;
      try {
        apiKey = await access.credentialFor(actor)();
      } catch {
        // key 未配置时用 undefined，让 RagFlow provider 走默认 key 作为兜底
      }
      return listKnowledgeFormOptions(apiKey);
    },

    rerankModels: async () => listRerankModelsForOrg(),

    listConfiguredProviders: (actor) =>
      upstream("list", () => listConfiguredProviderTree(KEY_SOURCE, actor.userId, actor.organizationId)),

    listFactories: (actor) =>
      upstream("list-factories", () => listEmbeddingFactories(KEY_SOURCE, actor.userId, actor.organizationId)),

    verifyProvider: (actor, input) =>
      upstream("verify", () =>
        verifyEmbeddingProvider(KEY_SOURCE, actor.userId, actor.organizationId, {
          provider: input.provider,
          providerApiKey: input.providerApiKey,
          baseUrl: input.baseUrl,
        }),
      ),

    listProviderModels: (actor, input) =>
      upstream("list-provider-models", () =>
        listProviderEmbeddingModels(KEY_SOURCE, actor.userId, actor.organizationId, {
          provider: input.provider,
          providerApiKey: input.providerApiKey,
          baseUrl: input.baseUrl,
        }),
      ),

    listInstanceModels: (actor, input) =>
      upstream("list-instance-models", () =>
        listInstanceEmbeddingModels(KEY_SOURCE, actor.userId, actor.organizationId, {
          provider: input.provider,
          instanceName: input.instanceName,
        }),
      ),

    addProvider: (actor, input) =>
      upstream("add", () =>
        addEmbeddingProvider(KEY_SOURCE, actor.userId, actor.organizationId, {
          provider: input.provider,
          instanceName: input.instanceName,
          providerApiKey: input.providerApiKey,
          baseUrl: input.baseUrl,
        }),
      ),

    removeProvider: (actor, input) =>
      upstream("delete", async () => {
        await deleteEmbeddingInstance(KEY_SOURCE, actor.userId, actor.organizationId, {
          provider: input.provider,
          instanceName: input.instanceName,
        });
        return { ok: true as const };
      }),

    setModelStatus: (actor, input) =>
      upstream("set-model-status", async () => {
        await setEmbeddingModelStatus(KEY_SOURCE, actor.userId, actor.organizationId, {
          provider: input.provider,
          instanceName: input.instanceName,
          modelName: input.modelName,
          status: input.status,
        });
        return { ok: true as const };
      }),
  };
}

/** 进程级无状态实现。 */
export const knowledgeModelFacade: KnowledgeModelFacade = createKnowledgeModelFacade();
