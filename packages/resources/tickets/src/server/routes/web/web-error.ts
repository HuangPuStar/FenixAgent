/**
 * `/web/tickets*` 的协议层公共设施：`/web` 错误信封与 handler 工厂（backend contract §9）。
 *
 * 错误的**分类**（哪个错误给哪个状态码、对外用哪个稳定码）在 `../ticket-error-mapping.ts`，本文件只把它
 * 包进 `/web` 的信封：`NotFoundError` / `GitError.NOT_FOUND` → 404；`ForbiddenError` / `GitError.FORBIDDEN`
 * → 403；`ConflictError` / `IdempotencyConflictError` / `VersionConflictError` / `RepositoryConflictError`
 * → 409；`ValidationError` → 400；`TicketsPausedError` / `GitUnavailableError` → 503。管理面
 * （`routes/api/system-error.ts`）用同一份分类、换一个信封（`{ error: { code, message } }`），两处不得
 * 各写一份映射表。
 *
 * 未命中映射表的错误一律**原样上抛**，交宿主的全局 error-handler 兜底 500
 * （`apps/server/src/plugins/error-handler.ts`）：存储故障、装配错误与编程错误不得被伪装成协议错误。
 * 文案边界（§9）：`message` 只透传稳定文案，不回显 token、上游响应体或用户正文。
 *
 * 上下文形状与请求面（含幂等键的前置校验）在 `../ticket-request-protocol.ts`：两个面必须逐字同形，
 * 这里不再重复声明。
 */

import type { ActorContext, WebErr } from "@fenix/platform-sdk";
import { classifyTicketError } from "../ticket-error-mapping";
import type { TicketRawContext, TicketRequestHeaders, TicketUploadRequest } from "../ticket-request-protocol";

/** Elysia `status(code, body)` 在本包用到的形状：写入状态码并原样返回该 body。 */
export type TicketStatusWriter = <TData>(code: number, body: TData) => TData;

/**
 * 路由 handler 用到的上下文面；泛型参数由各路由按自己声明的 schema 实例化。
 *
 * 写成类型别名而不是接口：`as` 断言要求两侧至少一侧可赋值，接口没有隐式索引签名（assignable 到
 * `Record<string, unknown>` 会失败），别名有。
 */
export type TicketRouteContext<TParams = unknown, TQuery = unknown, TBody = unknown> = {
  readonly store: { readonly actor?: unknown };
  readonly params: TParams;
  readonly query: TQuery;
  readonly body: TBody;
  readonly headers: TicketRequestHeaders;
  readonly status: TicketStatusWriter;
  /** 原始请求：只有附件上传要读它（multipart 必须交给 `formData()`，见附件协议文件的文件头）。 */
  readonly request: TicketUploadRequest;
};

/** 成功载荷：写路径的 201/202 显式给出状态码，其余默认 200。 */
export interface TicketSuccess {
  readonly status?: number;
  /** 响应体载荷；形状由 Elysia 按路由声明的 `response` schema 校验，这里不再重复建模。 */
  readonly data: unknown;
}

/** 构造 `/web` 错误信封；只允许稳定错误码与稳定文案。 */
export function buildTicketErrorBody(code: string, message: string): WebErr {
  return { success: false, error: { code, message } };
}

/**
 * 把领域错误映射为 `/web` 错误信封；未列入映射表的错误原样上抛（交宿主兜底 500）。
 *
 * 分类（状态码 + 稳定码 + 文案）在 {@link classifyTicketError}，本文件只负责 `/web` 的信封形状——管理面
 * 用同一个分类、换一个信封（`routes/api/system-error.ts`），两处不得各写一份映射表。
 *
 * 签名与合同 §9 的差异只有一处：参数是 Elysia 的 `status`（返回框架自有的状态标记），不是官方的
 * `error(status, body)`，返回类型也随之是信封本身而不是 `Response`——`status()` 的返回值并非
 * `Response` 实例，按 `Response` 声明会逼出一次无意义的断言。§9.3 的「判别联合 → 状态码与信封」
 * 语义不变。
 */
export function mapTicketError(error: unknown, elysiaStatus: TicketStatusWriter): WebErr {
  const classified = classifyTicketError(error);
  if (classified === undefined) throw error;
  return elysiaStatus(classified.status, buildTicketErrorBody(classified.code, classified.message));
}

/**
 * 构造一条工单路由的 handler：收窄上下文 → 取主体 → 执行 → 映射状态码与错误。
 *
 * 七条路由的「取主体 / 成功信封 / 错误映射」完全同形，逐条复制 try/catch 会让映射表出现七个调用点；
 * 这里压到一处，路由只描述「成功时给出什么载荷、写路径用哪个状态码」。
 *
 * 主体取自 `store.actor`（宿主守卫写入的 `ActorContext`）。已认证但缺组织上下文时（例如未绑定组织的
 * 凭据）直接 401：组织范围是工单项目可见性的唯一来源，没有它任何授权判定都无意义，交给 Facade 只会得到
 * 一个来源不明的领域错误。契约 §9.3 要求路由不做业务判断——本工厂只做协议映射，组织、角色与项目状态
 * 判定全在 Facade。
 */
export function ticketHandler<TParams = unknown, TQuery = unknown, TBody = unknown>(
  run: (route: TicketRouteContext<TParams, TQuery, TBody>, actor: ActorContext) => Promise<TicketSuccess>,
): (context: TicketRawContext) => Promise<unknown> {
  return async (context) => {
    const route = context as TicketRouteContext<TParams, TQuery, TBody>;
    const actor = route.store.actor as ActorContext | null;
    if (actor === null) {
      return route.status(401, buildTicketErrorBody("UNAUTHORIZED", "请求缺少组织上下文"));
    }
    try {
      const result = await run(route, actor);
      return route.status(result.status ?? 200, { success: true as const, data: result.data });
    } catch (error) {
      return mapTicketError(error, route.status);
    }
  };
}

/**
 * 构造一条**流式**工单路由的 handler：与 {@link ticketHandler} 只差成功分支——返回 `Response` 本身而不是
 * `/web` 信封。
 *
 * 只服务附件下载（唯一会返回字节流的端点）：把二进制内容塞进 `{ success, data }` 会让浏览器拿到一段 JSON
 * 而文件名与长度都得另开一趟请求。两者的收窄与错误映射必须共用同一实现——各写一份时，下载路径会先长出
 * 自己的 401 文案，接着长出自己的一套错误映射表，最终「同一个上游故障在列表与下载上得到不同状态码」。
 */
export function ticketStreamHandler<TParams = unknown, TQuery = unknown>(
  run: (route: TicketRouteContext<TParams, TQuery, unknown>, actor: ActorContext) => Promise<Response>,
): (context: TicketRawContext) => Promise<unknown> {
  return async (context) => {
    const route = context as TicketRouteContext<TParams, TQuery, unknown>;
    const actor = route.store.actor as ActorContext | null;
    if (actor === null) {
      return route.status(401, buildTicketErrorBody("UNAUTHORIZED", "请求缺少组织上下文"));
    }
    try {
      return await run(route, actor);
    } catch (error) {
      return mapTicketError(error, route.status);
    }
  };
}
