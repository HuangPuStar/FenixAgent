import { error as logError } from "@fenix/logger";
import { ApiSystemErrorResponseSchema } from "@fenix/platform-sdk";
import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import Elysia from "elysia";
import { getChannelModule } from "../../runtime";
import { ChannelAdminResponseSchema } from "../../schemas/channel-admin.schema";
import { loadChannelTopology, readChannelStatus } from "../../services/langbot/channel-topology";
import type { ChannelSystemApiRouteDependencies } from "../dependencies";

/**
 * `/api/system/channels` 系统管理面。
 *
 * 一次返回管理页所需的全部数据：LangBot 连通性 + 跨组织的「组织 → 用户 → 通道 → 实例」拓扑。控制面的
 * `/web/channels/langbot/*` 带组织过滤，admin 页面（系统 master key，没有组织上下文）无法复用，因此这里
 * 是独立的一条只读接口，不与 `/web` 共用协议层。
 *
 * 只有「取数失败」才 500：LangBot 不可达、Bot 列表读不到都已在服务层降级成可达性/适配器字段的 null，因为
 * 排障页最需要它的时刻恰恰是上游坏掉的时候。
 *
 * 插件名（`api-system-channels`）与守卫的插件名不同：Elysia 按 plugin `name` 去重，同名会让先构造的一方
 * 静默生效，守卫就会变成「看起来装了、实际没装」。
 */
export function createChannelSystemApiRoutes(deps: ChannelSystemApiRouteDependencies) {
  const app = new Elysia({ name: "api-system-channels", prefix: "/api/system/channels" }).use(
    deps.systemApiGuardPlugin,
  );

  app.get(
    "/",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia macro 与 response schema 的组合推断不稳定
    async ({ error }: any) => {
      try {
        const module = getChannelModule();
        const [status, organizations] = await Promise.all([
          readChannelStatus(module.service),
          loadChannelTopology({
            service: module.service,
            identity: getIdentityDirectory(),
            client: module.client,
          }),
        ]);
        return { success: true as const, data: { status, organizations } };
      } catch (err) {
        logError("[System-Channels] snapshot failed", err);
        return error(500, { error: { code: "INTERNAL_ERROR", message: "Channel snapshot could not be read" } });
      }
    },
    {
      systemApiKeyAuth: true,
      response: {
        200: ChannelAdminResponseSchema,
        401: ApiSystemErrorResponseSchema,
        500: ApiSystemErrorResponseSchema,
      },
      detail: {
        tags: ["System Channels"],
        summary: "获取跨组织的消息通道拓扑",
        description:
          "系统级只读接口，返回 LangBot 连通性与「组织 → 用户 → 通道 → 实例」拓扑。会话键已脱敏，不返回通道凭据与 LangBot key。",
      },
    },
  );

  return app;
}
