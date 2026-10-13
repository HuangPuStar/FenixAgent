/**
 * `/web/knowledgeBases*` 控制台路由工厂（知识库 CRUD、导入、表单选项、嵌入模型管理），并组合资源与检索/图谱
 * 子路由（`knowledge-resource-routes` / `knowledge-runtime-routes`）。
 *
 * 端点条数不在注释里重复计数（曾漂移为「20 条」，实测 23）：计数以 README 的实测值为单一来源。
 *
 * 守卫由宿主注入（`deps.authGuardPlugin`）：Elysia 的 macro / state 是实例作用域的，父实例无法向已构造
 * 的子实例回填，本包不得 import `@server/plugins/auth`（否则离开宿主即无法构造与测试）。
 *
 * 端点一律声明 `sessionAuth: true` 并在处理函数开头取 `store.authContext`：组织隔离由门面完成——协议层
 * 只把会话主体投影（`{ organizationId, userId }`）交给 Facade，不再拆成字段传给领域服务，也不接受请求体
 * 或查询串里的组织标识（见 `../../facades/knowledge-base-facade` 的文件头）。
 */

import { WebErrSchema, WebOkSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import * as z from "zod/v4";
import { knowledgeBaseFacade } from "../../facades/knowledge-base-facade";
import { knowledgeModelFacade } from "../../facades/knowledge-model-facade";
import {
  CreateKnowledgeBaseRequestSchema,
  KnowledgeBaseDetailResponseSchema,
  KnowledgeBaseInfoSchema,
  KnowledgeBaseListResponseSchema,
  KnowledgeFormOptionsResponseSchema,
  KnowledgeFormOptionsSchema,
  RerankModelsResponseSchema,
  UpdateKnowledgeBaseRequestSchema,
} from "../../schemas/knowledge.schema";
import type { KnowledgeRouteDependencies, SessionAuthContext } from "../dependencies";
import { createWebKnowledgeResourceRoutes } from "./knowledge-resource-routes";
import { createWebKnowledgeRuntimeRoutes } from "./knowledge-runtime-routes";
import { respondToWeb } from "./knowledge-web-response";

/** `/web/knowledgeBases*` 控制台路由工厂。 */
export function createWebKnowledgeBaseRoutes(deps: KnowledgeRouteDependencies) {
  const app = new Elysia({ name: "web-knowledge-bases" }).use(deps.authGuardPlugin).model({
    "knowledge-base-info": KnowledgeBaseInfoSchema,
    "knowledge-base-detail": KnowledgeBaseDetailResponseSchema,
    "knowledge-base-list": KnowledgeBaseListResponseSchema,
    "create-knowledge-base-request": CreateKnowledgeBaseRequestSchema,
    "update-knowledge-base-request": UpdateKnowledgeBaseRequestSchema,
    "knowledge-form-options": KnowledgeFormOptionsSchema,
    "knowledge-form-options-response": KnowledgeFormOptionsResponseSchema,
    "rerank-models-response": RerankModelsResponseSchema,
    "delete-knowledge-base-response": WebOkSchema(z.null()).describe("删除知识库后的成功响应。"),
  });

  app.get(
    "/knowledgeBases",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
    async ({ store }: any) => {
      const authCtx = store.authContext as SessionAuthContext;
      // 可见范围（仅本组织）与远端状态回填都在门面内，协议层不定义范围。
      return { success: true as const, data: await knowledgeBaseFacade.listForConsole(authCtx) };
    },
    {
      sessionAuth: true,
      response: "knowledge-base-list",
      detail: {
        tags: ["Knowledge"],
        summary: "获取知识库列表",
        description: "返回知识库列表及资源统计信息。",
      },
    },
  );

  app.post(
    "/knowledgeBases",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + body model
    async ({ store, body, error }: any) => {
      const actor = store.authContext as SessionAuthContext;
      const payload = body as {
        action?: string;
        name?: string;
        slug?: string;
        description?: string;
        embeddingModel?: string | null;
        parseMethod?: "builtin" | "pipeline" | null;
        pipelineId?: string | null;
        chunkMethod?: string | null;
        remoteId?: string;
      };

      // 处理非创建类 action
      if (payload.action === "list-unassociated") {
        return respondToWeb(await knowledgeBaseFacade.listUnassociatedRemote(actor), error);
      }

      if (payload.action === "import") {
        if (!payload.name || !payload.remoteId) {
          return error(400, {
            success: false,
            error: { code: "VALIDATION_ERROR", message: "name and remoteId are required" },
          });
        }
        return respondToWeb(
          await knowledgeBaseFacade.importRemote(actor, { name: payload.name, remoteId: payload.remoteId }),
          error,
        );
      }

      // 默认：创建知识库
      if (!payload.name) {
        return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "name is required" } });
      }
      return respondToWeb(
        await knowledgeBaseFacade.create(actor, {
          name: payload.name,
          slug: payload.slug,
          description: payload.description,
          embeddingModel: payload.embeddingModel,
          parseMethod: payload.parseMethod,
          pipelineId: payload.pipelineId,
          chunkMethod: payload.chunkMethod,
        }),
        error,
      );
    },
    {
      sessionAuth: true,
      body: "create-knowledge-base-request",
      detail: {
        tags: ["Knowledge"],
        summary: "创建知识库",
        description: "创建一个新的知识库记录，并初始化远端知识库信息。可指定嵌入模型、解析方法与内置分块方法。",
      },
    },
  );

  app.get(
    "/knowledgeBases/form-options",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + query
    async ({ store }: any) => {
      const actor = store.authContext as SessionAuthContext;
      return { success: true as const, data: await knowledgeModelFacade.formOptions(actor) };
    },
    {
      sessionAuth: true,
      response: "knowledge-form-options-response",
      detail: {
        tags: ["Knowledge"],
        summary: "获取知识库创建表单可选项",
        description:
          "返回创建知识库表单所需的嵌入模型、内置分块方法与可选 pipeline 列表。嵌入模型与 pipeline 动态拉取自 RagFlow，上游不可用时对应字段返回空数组。",
      },
    },
  );

  app.get(
    "/knowledgeBases/rerank-models",
    async () => {
      // rerank 模型是 RagFlow 租户级配置，与组织无关；仅需登录态访问
      return { success: true as const, data: await knowledgeModelFacade.rerankModels() };
    },
    {
      sessionAuth: true,
      response: "rerank-models-response",
      detail: {
        tags: ["Knowledge"],
        summary: "获取检索测试可用的 rerank 模型列表",
        description:
          "返回当前 RagFlow 租户下已配置的 rerank 重排序模型，供知识库检索测试选择重排序模型。上游不可用时返回空数组。",
      },
    },
  );

  app.get(
    "/knowledgeBases/:id",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
    async ({ store, params, error }: any) => {
      const actor = store.authContext as SessionAuthContext;
      return respondToWeb(await knowledgeBaseFacade.getDetail(actor, params.id), error);
    },
    {
      sessionAuth: true,
      response: {
        200: "knowledge-base-detail",
        404: WebErrSchema,
      },
      detail: {
        tags: ["Knowledge"],
        summary: "获取知识库详情",
        description: "根据知识库 ID 返回知识库详情及最近的资源列表。",
      },
    },
  );

  app.patch(
    "/knowledgeBases/:id",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + body model
    async ({ store, params, body, error }: any) => {
      const actor = store.authContext as SessionAuthContext;
      const payload = body as { name?: string; slug?: string; description?: string };
      return respondToWeb(
        await knowledgeBaseFacade.update(actor, params.id, {
          name: payload.name,
          slug: payload.slug,
          description: payload.description,
        }),
        error,
      );
    },
    {
      sessionAuth: true,
      body: "update-knowledge-base-request",
      response: {
        200: WebOkSchema(KnowledgeBaseInfoSchema),
        400: WebErrSchema,
        404: WebErrSchema,
      },
      detail: {
        tags: ["Knowledge"],
        summary: "更新知识库",
        description: "更新知识库名称、slug 或描述信息。",
      },
    },
  );

  app.delete(
    "/knowledgeBases/:id",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
    async ({ store, params, error }: any) => {
      const actor = store.authContext as SessionAuthContext;
      return respondToWeb(await knowledgeBaseFacade.remove(actor, params.id), error);
    },
    {
      sessionAuth: true,
      response: {
        200: "delete-knowledge-base-response",
        400: WebErrSchema,
        404: WebErrSchema,
      },
      detail: {
        tags: ["Knowledge"],
        summary: "删除知识库",
        description: "删除指定知识库及其关联资源绑定。",
      },
    },
  );

  // ===== Embedding 模型管理路由 =====
  // 统一入口 POST /knowledgeBases/models，body 含 action 字段分发。
  app.post(
    "/knowledgeBases/models",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + body
    async ({ store, body, error }: any) => {
      const actor = store.authContext as SessionAuthContext;
      const payload = body as {
        action:
          | "list"
          | "list-factories"
          | "verify"
          | "list-provider-models"
          | "list-instance-models"
          | "add"
          | "delete"
          | "set-model-status";
        provider?: string;
        providerApiKey?: string;
        baseUrl?: string | null;
        instanceName?: string;
        modelName?: string;
        status?: "active" | "inactive";
      };

      switch (payload.action) {
        case "list": {
          return respondToWeb(await knowledgeModelFacade.listConfiguredProviders(actor), error);
        }
        case "list-factories": {
          return respondToWeb(await knowledgeModelFacade.listFactories(actor), error);
        }
        case "verify": {
          if (!payload.provider || !payload.providerApiKey) {
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "provider 和 providerApiKey 必填" },
            });
          }
          return respondToWeb(
            await knowledgeModelFacade.verifyProvider(actor, {
              provider: payload.provider,
              providerApiKey: payload.providerApiKey,
              baseUrl: payload.baseUrl,
            }),
            error,
          );
        }
        case "list-provider-models": {
          if (!payload.provider || !payload.providerApiKey) {
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "provider 和 providerApiKey 必填" },
            });
          }
          return respondToWeb(
            await knowledgeModelFacade.listProviderModels(actor, {
              provider: payload.provider,
              providerApiKey: payload.providerApiKey,
              baseUrl: payload.baseUrl,
            }),
            error,
          );
        }
        case "list-instance-models": {
          if (!payload.provider || !payload.instanceName) {
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "provider 和 instanceName 必填" },
            });
          }
          return respondToWeb(
            await knowledgeModelFacade.listInstanceModels(actor, {
              provider: payload.provider,
              instanceName: payload.instanceName,
            }),
            error,
          );
        }
        case "set-model-status": {
          if (!payload.provider || !payload.instanceName || !payload.modelName || !payload.status) {
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "provider/instanceName/modelName/status 必填" },
            });
          }
          return respondToWeb(
            await knowledgeModelFacade.setModelStatus(actor, {
              provider: payload.provider,
              instanceName: payload.instanceName,
              modelName: payload.modelName,
              status: payload.status,
            }),
            error,
          );
        }
        case "add": {
          if (!payload.provider || !payload.instanceName || !payload.providerApiKey) {
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "provider/instanceName/providerApiKey 必填" },
            });
          }
          return respondToWeb(
            await knowledgeModelFacade.addProvider(actor, {
              provider: payload.provider,
              instanceName: payload.instanceName,
              providerApiKey: payload.providerApiKey,
              baseUrl: payload.baseUrl,
            }),
            error,
          );
        }
        case "delete": {
          if (!payload.provider || !payload.instanceName) {
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "provider 和 instanceName 必填" },
            });
          }
          return respondToWeb(
            await knowledgeModelFacade.removeProvider(actor, {
              provider: payload.provider,
              instanceName: payload.instanceName,
            }),
            error,
          );
        }
        default:
          return error(400, {
            success: false,
            error: { code: "VALIDATION_ERROR", message: `unknown action: ${payload.action}` },
          });
      }
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Knowledge"],
        summary: "Embedding 模型管理（action 分发）",
        description:
          "统一管理 embedding 模型。action 取值：list / list-factories / verify / list-provider-models / list-instance-models / add / delete / set-model-status。",
      },
    },
  );

  // 资源端点与检索/图谱端点各自成文件：三者都只做协议映射，归属与凭据在门面内完成。
  return app.use(createWebKnowledgeResourceRoutes(deps)).use(createWebKnowledgeRuntimeRoutes(deps));
}
