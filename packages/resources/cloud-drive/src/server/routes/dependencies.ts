import type { AnyElysia } from "elysia";
import type { CloudDriveActor, CloudDriveFacade } from "../facades/cloud-drive-facade";

/**
 * CloudDrive 路由的宿主注入依赖。
 *
 * 单独成文件而不是放在包入口：路由工厂需要声明自己的依赖类型，若类型定义在 `../server.ts`，会出现
 * 「入口 → 工厂 → 入口」的循环导入。这里只放类型，运行时不产生任何依赖。
 *
 * 为什么守卫是注入而不是本包自建：Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造
 * 的子实例回填。守卫必须与宿主的认证解析（session cookie / Environment Secret / API Key、active
 * organization 解析）是同一份实例，否则同一进程会出现两套互不可见的认证状态。
 */
export interface CloudDriveRouteDependencies {
  /** 会话认证守卫；路由靠它取得 `store.authContext`。 */
  readonly authGuardPlugin: AnyElysia;
  /**
   * Facade 实例；测试注入替身。
   *
   * `CloudDriveActor` 只从守卫写入的 `store.authContext.userId` 投影，路由参数 / 请求体 / 查询串
   * 都不参与；client 的 `X-On-Behalf-Of` 因此永远是当前登录用户。
   */
  readonly facade: CloudDriveFacade;
}

/** 守卫写入 `store.authContext` 的会话上下文；只声明本包实际消费的字段。 */
export interface SessionAuthContext {
  readonly userId: string;
  readonly organizationId: string;
}

/** 从 Elysia `store` 投影出 actor；缺失或形状不符时返回 null（协议层回 401）。 */
export function actorFromStore(store: unknown): CloudDriveActor | null {
  if (typeof store !== "object" || store === null) return null;
  const authContext = (store as { readonly authContext?: unknown }).authContext;
  if (typeof authContext !== "object" || authContext === null) return null;
  const userId = (authContext as { readonly userId?: unknown }).userId;
  if (typeof userId !== "string" || userId.trim() === "") return null;
  return { userId };
}
