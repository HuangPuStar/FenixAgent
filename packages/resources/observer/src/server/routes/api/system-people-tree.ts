// 系统级人员管理查询面：组织 → 成员 → 智能体配置，只读且由 system key 保护。

import { error as logError } from "@fenix/logger";
import { ApiSystemErrorResponseSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import { SystemPeopleTreeResponseSchema } from "../../schemas/api-system-people-tree.schema";
import { type SystemPeopleTreeService, systemPeopleTreeService } from "../../services/system-people-tree-service";
import type { SystemApiObserverRouteDependencies } from "../dependencies";

let service: SystemPeopleTreeService = systemPeopleTreeService;

/** 仅供路由测试替换人员树数据源；传 null 恢复默认服务。 */
export function setSystemPeopleTreeServiceForTests(override: SystemPeopleTreeService | null): void {
  service = override ?? systemPeopleTreeService;
}

/**
 * `/api/system/people-tree` 路由工厂（宿主注入系统 key 守卫，理由见 `../dependencies`）。
 *
 * 插件名与守卫名不同：Elysia 按 plugin `name` 去重，同名会让先构造的一方静默生效。
 */
export function createApiSystemPeopleTreeRoutes(deps: SystemApiObserverRouteDependencies) {
  const app = new Elysia({ name: "api-system-people-tree", prefix: "/api/system/people-tree" }).use(
    deps.systemApiGuardPlugin,
  );

  app.get(
    "/",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia macro 与 response schema 的组合推断不稳定
    async ({ error }: any) => {
      try {
        return { success: true as const, data: { organizations: await service.listTree() } };
      } catch (err) {
        logError("[System-People-Tree] list failed", err);
        return error(500, { error: { code: "INTERNAL_ERROR", message: "People tree could not be listed" } });
      }
    },
    {
      systemApiKeyAuth: true,
      response: {
        200: SystemPeopleTreeResponseSchema,
        401: ApiSystemErrorResponseSchema,
        500: ApiSystemErrorResponseSchema,
      },
      detail: {
        tags: ["System People"],
        summary: "获取组织人员智能体层级",
        description: "系统级只读接口，返回组织、组织成员及其归属智能体配置。",
      },
    },
  );

  return app;
}
