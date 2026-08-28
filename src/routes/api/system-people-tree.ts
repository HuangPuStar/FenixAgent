// 系统级人员管理查询面：组织 → 成员 → 智能体配置，只读且由 system key 保护。

import { error as logError } from "@fenix/logger";
import Elysia from "elysia";
import { systemApiAuthPlugin } from "../../plugins/system-api-auth";
import { ApiSystemErrorResponseSchema } from "../../schemas/api-system.schema";
import { SystemPeopleTreeResponseSchema } from "../../schemas/api-system-people-tree.schema";
import { type SystemPeopleTreeService, systemPeopleTreeService } from "../../services/system-people-tree-service";

let service: SystemPeopleTreeService = systemPeopleTreeService;

/** 仅供路由测试替换人员树数据源；传 null 恢复默认服务。 */
export function setSystemPeopleTreeServiceForTests(override: SystemPeopleTreeService | null): void {
  service = override ?? systemPeopleTreeService;
}

const app = new Elysia({ name: "api-system-people-tree", prefix: "/api/system/people-tree" }).use(systemApiAuthPlugin);

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

export default app;
