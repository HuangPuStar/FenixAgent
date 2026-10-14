/**
 * `/api/system/tickets` 协议层（**平台管理面**）的路由工厂：列表、详情、写路径、标签与成员目录、待确认账本，
 * 清单见 `docs/arch/29-tickets.md` §12.1；本文件只注册列表端点，其余五组由各自的注册函数挂到同一实例。
 *
 * 与 `/web/tickets/:projectId` 的关系是「同一份数据、两类凭据」：那个面按组织过滤且跨组织与不存在同形 404
 * （可见性由受控查询表达），本面跨组织、判据是系统 API Key（`systemApiKeyAuth: true`，守卫由宿主注入）。
 * 宿主守卫刻意不恢复用户 / 组织上下文，因此这里没有 actor 可传，Facade 的管理面方法也不吃 actor。
 *
 * 只做三件事：参数形状校验、把请求（查询或写入）交给 Facade、把结果映射成协议视图与 `/api/system/*` 信封
 * （成功 `{ success: true, data }`、失败 `{ error: { code, message } }`）。授权与组织范围不在这里判断——
 * 本面根本没有范围收敛；组织内的可见性规则由 `/web` 面继续唯一表达，两者不共用谓词。
 *
 * 列表错误只映射 500：这是一条只读查询，唯一的应用错误来源是存储与装配故障，把它伪装成 4xx 会让运维以为
 * 调用方写错了参数。`message` 只给稳定文案，不回显组织 ID、SQL 或上游内容。**本条以外**的路由（详情与写
 * 路径）在 `system-error.ts` 的 handler 工厂里映射领域错误（400/404/409/503），未映射的错误同样上抛。
 *
 * 本工厂是管理面的**唯一 Elysia 实例**：详情、写路径、目录与账本各由一个注册函数挂到同一个实例上（与
 * `/web` 面的 `routes/web/index.ts` 同形）。宿主 `app-route` 贡献只能返回单个实例，实例前缀只能在构造时
 * 给定，因此管理面的全部路径都在 `/api/system/tickets` 之下——这也是账本挂在 `/operations` 静态段下、而不是
 * 另起 `/api/system/ticket-operations` 的原因（见 `system-ticket-operations.ts` 的文件头）。
 */

import { error as logError } from "@fenix/logger";
import { ApiSystemErrorResponseSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import type * as z from "zod/v4";
import { SystemTicketListQuerySchema, SystemTicketListResponseSchema } from "../../../schemas/system-ticket.schema";
import { getTicketsServerModule } from "../../runtime";
import type { SystemApiTicketRouteDependencies } from "../dependencies";
import { registerSystemTicketAttachmentRoutes } from "./system-ticket-attachments";
import { registerSystemTicketCatalogRoutes } from "./system-ticket-catalog";
import { registerSystemTicketCommentRoutes } from "./system-ticket-comments";
import { registerSystemTicketRoutes } from "./system-ticket-detail";
import { registerSystemTicketOperationRoutes } from "./system-ticket-operations";

/**
 * 本路由用到的上下文面。
 *
 * 写成类型别名而不是接口（同 `web-error.ts` 的 `TicketRouteContext`）：守卫经 `AnyElysia` 注入后，跨包边界上
 * Elysia 把上下文退化成索引签名，别名可赋值而接口不可，于是不必写 `any` + `biome-ignore`。
 * `query` 必须与路由声明的 schema 同源（`z.infer`），否则「schema 里有的字段在 handler 里读不到」只会在
 * 运行期显形。
 */
type SystemTicketRouteContext = {
  readonly query: z.infer<typeof SystemTicketListQuerySchema>;
  /** 守卫的 `error` 装饰器：写入状态码并返回响应体。 */
  readonly error: (code: number, body: unknown) => Response;
};

/** Elysia 交给 handler 的上下文（跨包边界上退化成索引签名，同 `web-error.ts` 的 `TicketRawContext`）。 */
type SystemTicketRawContext = Record<string, unknown>;

/**
 * `/api/system/tickets` 路由工厂（宿主注入系统 key 守卫，理由见 `../dependencies`）。
 *
 * 插件名与守卫名不同：Elysia 按 plugin `name` 去重，同名会让先构造的一方静默生效。
 */
export function createApiSystemTicketsRoutes(deps: SystemApiTicketRouteDependencies) {
  const app = new Elysia({ name: "api-system-tickets", prefix: "/api/system/tickets" }).use(deps.systemApiGuardPlugin);

  app.get(
    "/",
    // 收窄写在这里而不是签名上：Elysia 的 handler 参数是索引签名类型，直接声明窄类型会被判不可赋值。
    async (raw: SystemTicketRawContext) => {
      const context = raw as SystemTicketRouteContext;
      const { page, pageSize, q, state, organizationId, projectId } = context.query;
      try {
        const result = await getTicketsServerModule().platform.list({
          // 页码 → 偏移的换算只在这里做一次：仓储只认 limit / offset，接口对外只暴露页码。
          limit: pageSize,
          offset: (page - 1) * pageSize,
          ...(q === undefined ? {} : { q }),
          ...(state === undefined ? {} : { state }),
          ...(organizationId === undefined ? {} : { organizationId }),
          ...(projectId === undefined ? {} : { projectId }),
        });
        return {
          success: true as const,
          data: { items: result.items, total: result.total, page, pageSize },
        };
      } catch (err) {
        logError("[System-Tickets] list failed", err);
        return context.error(500, {
          error: { code: "INTERNAL_ERROR", message: "平台工单列表读取失败" },
        });
      }
    },
    {
      systemApiKeyAuth: true,
      query: SystemTicketListQuerySchema,
      response: {
        200: SystemTicketListResponseSchema,
        401: ApiSystemErrorResponseSchema,
        500: ApiSystemErrorResponseSchema,
      },
      detail: {
        tags: ["System Tickets"],
        summary: "获取全部组织的工单列表",
        description:
          "系统级只读接口，跨组织返回工单索引行（按最后同步时间倒序，含归属组织与项目坐标），支持按状态、标题关键词、组织与项目筛选。此面不受组织可见性谓词约束，凭据即判据；组织内的可见性规则仍只由 `/web/tickets/:projectId` 表达。分页为页码语义（跨项目时工单号不构成全局序），与 `/web` 面的游标分页不同。",
      },
    },
  );

  // 详情与写路径、目录读取、账本查询：同一个实例（前缀与守卫只有一处，见文件头）。
  registerSystemTicketRoutes(app);
  registerSystemTicketCommentRoutes(app);
  registerSystemTicketAttachmentRoutes(app);
  registerSystemTicketCatalogRoutes(app);
  registerSystemTicketOperationRoutes(app);

  return app;
}
