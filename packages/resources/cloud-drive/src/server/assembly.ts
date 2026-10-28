import { createLogger } from "@fenix/logger";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import type { AnyElysia } from "elysia";
import { CloudDriveClient, resolveCloudDriveClientConfig } from "./client/cloud-drive-client";
import { getCloudDriveConfig } from "./config";
import { createCloudDriveFacade } from "./facades/cloud-drive-facade";
import type { CloudDriveRouteDependencies } from "./routes/dependencies";
import { createWebCloudDriveRoutes } from "./routes/web/cloud-drive";

/**
 * CloudDrive 的路由贡献装配面：把宿主协议面收窄为本包路由的注入依赖。
 *
 * `ServerRouteHost` 的字段全是 `unknown`（platform-sdk 不依赖 elysia），收窄只能在包内做一次——
 * 本包只需要会话守卫，`route-host.ts` 是唯一实现。这里不做校验：端口是否可用由宿主在装配处保证。
 *
 * 网关（client）按请求构造，因为它读的是模块配置：部署配置未就绪时不应在装配期抛错，否则一个可选
 * 外部依赖会把整个进程卡在启动阶段。配置缺失由 Facade 转成 503。
 *
 * 诊断只记录「哪个操作、哪个主体、上游状态与业务 code、耗时」——没有 headers、body、master key
 * 或带签名的下载票据。
 */
const logger = createLogger("cloud-drive");

/** 把宿主协议面收窄为本包路由的依赖。 */
function routeDependencies(host: ServerRouteHost): CloudDriveRouteDependencies {
  const facade = createCloudDriveFacade({
    resolveGateway: () => {
      const config = getCloudDriveConfig();
      return new CloudDriveClient({
        config: resolveCloudDriveClientConfig(config),
        onDiagnostic: (event) => {
          if (event.outcome !== "error") return;
          logger.error("CloudDrive 调用失败", {
            operation: event.operation,
            subject: event.subject,
            status: event.status,
            code: event.code,
            durationMs: event.durationMs,
          });
        },
      });
    },
    onUnexpectedError: (error, context) => {
      logger.error("CloudDrive Facade 未预期异常", { operation: context.operation }, error);
    },
  });

  return {
    authGuardPlugin: host.authGuardPlugin as AnyElysia,
    facade,
  };
}

/** `/web/cloud-drive/*` 个人云盘代理（挂宿主 `web` 聚合槽）。 */
export function createCloudDriveWebRoutes(host: ServerRouteHost) {
  return createWebCloudDriveRoutes(routeDependencies(host));
}
