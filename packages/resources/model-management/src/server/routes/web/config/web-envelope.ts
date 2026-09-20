import type { ActorContext } from "@fenix/platform-sdk";
import { AppError } from "@fenix/platform-sdk";
import { configError } from "@server/services/config-utils";

/**
 * `/web/config/*` 的响应信封适配：主体注入 → handler → `{success,data}` / `{success:false,error}` + 状态码。
 *
 * 这一层只管协议，不含任何授权或领域判断，两个路由文件（providers / models）共用一份，避免同一套
 * 信封规则出现第二份实现。
 */

/** handler 的失败态判据；`configError` 的产物恒有 `success === false`。 */
function isWebFailure(result: unknown): result is { readonly error: { readonly code?: string } } {
  return (
    typeof result === "object" &&
    result !== null &&
    "success" in result &&
    (result as { success?: unknown }).success === false
  );
}

/** 错误码 → HTTP 状态码；与迁移前逐字一致，未列出的码落 500。 */
export function configErrorStatus(code: string | undefined): 400 | 403 | 404 | 409 | 500 {
  switch (code) {
    case "VALIDATION_ERROR":
      return 400;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "ALREADY_EXISTS":
      return 409;
    default:
      return 500;
  }
}

/** `safeWebHandler` 的可选行为。 */
export interface SafeWebHandlerOptions {
  /**
   * 非 `AppError` 异常的错误码；不提供时该异常原样上抛，由全局错误处理落 500。
   *
   * 两种行为都是既有协议：providers 路由让未知异常冒泡，models 路由把它包装成
   * `CONFIG_READ_ERROR` / `CONFIG_WRITE_ERROR`。这里用选项表达差异，而不是写两个信封。
   */
  readonly fallbackCode?: string;
}

/**
 * 包裹 `/web` handler：注入当前主体、给失败信封补状态码、把 `AppError` 转成错误信封。
 *
 * 主体缺失只可能是装配错误（`sessionAuth: true` 之后必然存在），因此返回 401 而不是兜底构造匿名主体。
 */
export function safeWebHandler(
  // biome-ignore lint/suspicious/noExplicitAny: wrapper needs to match Elysia InlineHandler type
  handler: (ctx: any, actor: ActorContext) => Promise<any>,
  options: SafeWebHandlerOptions = {},
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 的 InlineHandler 要求返回可赋给任意响应类型的值
): (ctx: any) => Promise<any> {
  // biome-ignore lint/suspicious/noExplicitAny: wrapper needs to match Elysia InlineHandler type
  return async (ctx: any) => {
    const status = ctx.status as (code: number, body: unknown) => Response;
    const actor = (ctx.store as { actor?: ActorContext | null } | undefined)?.actor;
    if (!actor) {
      return status(401, configError("UNAUTHORIZED", "Authentication required"));
    }

    try {
      const result: unknown = await handler(ctx, actor);
      return isWebFailure(result) ? status(configErrorStatus(result.error.code), result) : result;
    } catch (error: unknown) {
      if (error instanceof AppError) {
        return status(error.statusCode, configError(error.code, error.message));
      }
      if (options.fallbackCode === undefined) throw error;
      const message = error instanceof Error ? error.message : "Unknown error";
      return status(500, configError(options.fallbackCode, message));
    }
  };
}
