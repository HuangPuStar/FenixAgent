// src/routes/api/system-observer.ts
// 系统级 Observer 查询面（docs/arch/21-observability-observer-service.md §4）。
// 首版固定 kind=acp-link，路由不做 /:kind 动态扩展（D10）；受 systemApiKeyAuth 保护，
// 系统级视角，不恢复用户/组织上下文。响应 { success, data } 骨架，错误不泄内部细节。

import { error as logError } from "@fenix/logger";
import Elysia from "elysia";
import { systemApiAuthPlugin } from "../../plugins/system-api-auth";
import { ApiSystemErrorResponseSchema } from "../../schemas/api-system.schema";
import { ApiSystemObserverAcpLinkResponseSchema } from "../../schemas/api-system-observer.schema";
import { ObserverKindNotFoundError, observerService } from "../../services/observer";

const app = new Elysia({ name: "api-system-observer", prefix: "/api/system/observer" }).use(systemApiAuthPlugin).model({
  "api-system-observer-acp-link-response": ApiSystemObserverAcpLinkResponseSchema,
});

app.get(
  "/acp-link",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia response schema + custom macro 下类型推断不稳定
  async ({ error }: any) => {
    try {
      const view = await observerService.tree("acp-link");
      return {
        success: true,
        data: {
          generatedAt: view.generatedAt,
          kind: view.kind,
          total: view.total,
          // 内部 RelationTreeView 顶层持有 byOrg/byEntity；对外形状按文档 §4 包 trees 骨架
          trees: { byEntity: view.byEntity, byOrg: view.byOrg },
          integrity: view.integrity,
          names: view.names,
        },
      };
    } catch (err) {
      // 未注册的 kind → 404；其余一律 500。响应不泄内部细节，但服务端保留诊断上下文
      if (err instanceof ObserverKindNotFoundError) {
        return error(404, { error: { code: "NOT_FOUND", message: err.message } });
      }
      logError("[System-Observer] collect failed", err);
      return error(500, { error: { code: "INTERNAL_ERROR", message: "Observer collection failed" } });
    }
  },
  {
    systemApiKeyAuth: true,
    response: {
      200: "api-system-observer-acp-link-response",
      401: ApiSystemErrorResponseSchema,
      404: ApiSystemErrorResponseSchema,
      500: ApiSystemErrorResponseSchema,
    },
    detail: {
      tags: ["System Observer"],
      summary: "获取 ACP 活跃链接观察视图",
      description: "系统级接口，返回 acp-link 的归属树、machine 树与一致性汇总（请求驱动、纯只读、即用即弃）。",
    },
  },
);

export default app;
