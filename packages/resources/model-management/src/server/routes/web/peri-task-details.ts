/**
 * Peri 任务详情路由工厂：`/web/agents/:environmentId/sessions/:sessionId/peri-tasks/:taskId/detail`
 * （任务 1.5c 从宿主 `apps/server/src/routes/web/peri-task-details.ts` 迁入）。
 *
 * 归属：任务投影的存储适配（`createPeriTaskDetailStore`）与读取逻辑（`getPeriTaskDetail`）本就在本包，宿主
 * 那份只是协议接入壳；协议 schema 也已在 1.3 归位本包（宿主侧同名副本随本片删除，两份字节相同）。迁入后
 * 协议定义、投影读取与实现同址，不再跨包分叉。
 *
 * 两项依赖由宿主注入：
 * - **守卫**：Elysia 的 `macro` / `state` 是实例作用域的，包内自建一份会让同一进程出现两套互不可见的
 *   认证状态（理由见 `../dependencies`）；
 * - **环境归属校验**：`Environment` 表的 owner 是 `@fenix/agent-runtime`，而依赖矩阵不允许资源包依赖该包，
 *   宿主是唯一同时持有两侧的装配层。
 *
 * 本片只做搬迁：路由路径、`sessionAuth` 宏、响应形状与「以 404 隐藏归属差异」的语义逐字保留，未触碰任何
 * 生命周期、幂等或并发逻辑。
 */

import { docManager } from "@fenix/chat-channel/server";
import { NotFoundError, WebErrSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import { getPeriTaskDetail } from "../../../services/peri-task-detail-service";
import { createPeriTaskDetailStore } from "../../../services/peri-task-detail-store";
import {
  PeriTaskDetailParamsSchema,
  PeriTaskDetailQuerySchema,
  PeriTaskDetailResponseSchema,
} from "../../schemas/peri-task-details";
import type { WebPeriTaskDetailsRouteDependencies } from "../dependencies";

// 投影存储只包一层 Session Doc 读取，不持有状态；模块级构造一次即可（工厂被调用多次不会分裂投影）。
const detailStore = createPeriTaskDetailStore(docManager);

/** 构造 `/web/agents/:environmentId/sessions/:sessionId/peri-tasks/:taskId/detail` 路由。 */
export function createWebPeriTaskDetailsRoutes(deps: WebPeriTaskDetailsRouteDependencies) {
  return new Elysia({ name: "web-peri-task-details" }).use(deps.authGuardPlugin).get(
    "/agents/:environmentId/sessions/:sessionId/peri-tasks/:taskId/detail",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
    async ({ store, params, query, error }: any) => {
      const authContext = store.authContext!;
      try {
        const data = await getPeriTaskDetail(
          {
            organizationId: authContext.organizationId,
            userId: store.user!.id,
            environmentId: params.environmentId,
            sessionId: params.sessionId,
            taskId: params.taskId,
          },
          query,
          {
            getOwnedEnvironment: deps.getOwnedEnvironment,
            store: detailStore,
          },
        );
        return { success: true as const, data };
      } catch (err: unknown) {
        if (err instanceof NotFoundError) {
          return error(404, { success: false, error: { code: "NOT_FOUND", message: "任务详情不存在" } });
        }
        throw err;
      }
    },
    {
      sessionAuth: true,
      params: PeriTaskDetailParamsSchema,
      query: PeriTaskDetailQuerySchema,
      response: { 200: PeriTaskDetailResponseSchema, 404: WebErrSchema },
      detail: {
        tags: ["Peri Tasks"],
        summary: "按任务类型读取 Peri Task 详情",
        description: "仅返回真实来源提供的有界摘要；不返回 locator，也不将摘要声明为完整 transcript。",
      },
    },
  );
}
