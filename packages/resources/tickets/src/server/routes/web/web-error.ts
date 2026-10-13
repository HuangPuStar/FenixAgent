/**
 * `/web/tickets*` 的协议层公共设施：错误信封、幂等键前置校验与 handler 工厂（backend contract §9）。
 *
 * 错误映射表是合同 §9 的**唯一实现处**：`NotFoundError` / `GitError.NOT_FOUND` → 404；
 * `ForbiddenError` / `GitError.FORBIDDEN` → 403；`ConflictError` / `IdempotencyConflictError` /
 * `VersionConflictError` / `RepositoryConflictError` → 409；`ValidationError` → 400；
 * `TicketsPausedError` / `GitUnavailableError` → 503。映射按「错误自带的 `statusCode` 是否在已声明的
 * 状态码集合内」判，而不是逐类 `instanceof`：每个类都把状态钉死了（`AppError.statusCode` 的语义），
 * 逐类列举反而漏掉 `RepositoryOwnerMismatchError`（400，决策 D1 的 owner 回读不一致）与
 * `OperationNotFoundError`（404，决策 D5）这类同表错误。`GitError.WRITE_UNCERTAIN` 刻意不映射：
 * 它是「结果未定」，由 Facade 转成 202 分支（§8.3），在这里映射等于把一次可能已生效的写压成失败。
 *
 * 未命中映射表的错误一律**原样上抛**，交宿主的全局 error-handler 兜底 500
 * （`apps/server/src/plugins/error-handler.ts`）：存储故障、装配错误与编程错误不得被伪装成协议错误。
 * 文案边界（§9）：`message` 只透传稳定文案，不回显 token、上游响应体或用户正文。
 *
 * 为什么显式收窄 Elysia 上下文：守卫经 `AnyElysia` 注入，跨包边界上 Elysia 把上下文类型退化成
 * `{ [x: string]: any }`，仓内既有写法要在每处 handler 上写 `: any` + `biome-ignore`。这里让 handler 收
 * `Record<string, unknown>`（对该上下文类型可赋值，不需要 `any`），再用 {@link TicketRouteContext} 把本包
 * 真正用到的字段声明一次——「route 只用 store / status / params / query / body / headers / request」这条边界
 * 因此可见，收窄点也只剩一处。
 */

import { type GitError, isGitError } from "@fenix/git/server";
import { type ActorContext, AppError, type WebErr } from "@fenix/platform-sdk";
import * as z from "zod/v4";
import { IdempotencyKeyHeaderSchema } from "../../../schemas/ticket.schema";

/** Elysia 交给 handler 的上下文形状（字段类型跨包边界退化成索引签名，见文件头）。 */
export type TicketRawContext = Record<string, unknown>;

/** Elysia `status(code, body)` 在本包用到的形状：写入状态码并原样返回该 body。 */
export type TicketStatusWriter = <TData>(code: number, body: TData) => TData;

/** 请求头最窄形状：键名小写（HTTP 头名不区分大小写，Elysia 的 `headers` 模型按小写键取值）。 */
export interface TicketRequestHeaders {
  readonly "idempotency-key"?: string | undefined;
}

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
  /** 原始请求：只有附件上传要读它（multipart 必须交给 `formData()`，见附件路由的文件头）。 */
  readonly request: TicketUploadRequest;
};

/**
 * 上传表单的读取面，取自 `Request.formData()`。
 *
 * 不直接写全局 `FormData`：运行环境里 DOM lib 与 undici 各声明了一份同名结构，用全局名会把运行时拿到
 * 的那一份判成不可赋值（与 `skill-upload-form.ts` 同口径）。本包只用到 `get`，因此只声明它。
 */
export type TicketUploadFormData = Awaited<ReturnType<Request["formData"]>>;

/** 路由用到的请求面：附件上传需要 `formData()`，其余方法一律不出现（边界可见）。 */
export interface TicketUploadRequest {
  readonly formData: () => Promise<TicketUploadFormData>;
}

/** 成功载荷：写路径的 201/202 显式给出状态码，其余默认 200。 */
export interface TicketSuccess {
  readonly status?: number;
  /** 响应体载荷；形状由 Elysia 按路由声明的 `response` schema 校验，这里不再重复建模。 */
  readonly data: unknown;
}

/**
 * 已映射的 `/web` 错误状态码集合，与各路由 `response` 声明保持一致。
 *
 * 集合外的错误（含 `statusCode` 缺省的 `AppError` 与全部非 `AppError` 异常）原样上抛：给未声明的状态码
 * 返回信封会让响应校验与 OpenAPI 文档同时失真。
 */
const MAPPED_ERROR_STATUSES: ReadonlySet<number> = new Set([400, 403, 404, 409, 503]);

/** Git 错误码 → `/web` 状态码；`WRITE_UNCERTAIN` 刻意缺席（见文件头）。 */
const GIT_ERROR_STATUS: Partial<Record<GitError["code"], number>> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  CONFLICT: 409,
  // 上游**确定拒绝**本次请求（附件上传的 413/422：超出上游大小上限、扩展名不在白名单）。
  // 它不是「结果未定」：映射成 400 让用户改文件名/换小文件重试，而不是去核对一个从未发生的写入。
  INVALID_REQUEST: 400,
  RATE_LIMITED: 503,
  UNAVAILABLE: 503,
  INVALID_RESPONSE: 503,
};

/**
 * 写路由的宽松幂等键头模型。
 *
 * 只声明「可能是个字符串」：缺失与格式由 {@link requireTicketIdempotencyKey} 判成
 * `IDEMPOTENCY_KEY_REQUIRED` / `IDEMPOTENCY_KEY_INVALID`。若在这里就用严格 schema 校验，Elysia 会在进入
 * handler 之前以参数校验失败拒绝请求，宿主 error-handler 随后统一改写成 `VALIDATION_ERROR`
 * （`apps/server/src/plugins/error-handler.ts`），前端拿不到这两个稳定码，也就无法区分「没带键」与
 * 「键写错」——而合同 §9.2 与 §10 的用例都要求这两个码。
 */
export const TicketIdempotencyHeadersSchema = z.object({ "idempotency-key": z.string().optional() });

/** 路由层的前置条件失败（幂等键缺失/非法）：只在本文件与路由之间流转，不进入 Facade。 */
class TicketRequestError extends AppError {
  constructor(code: "IDEMPOTENCY_KEY_REQUIRED" | "IDEMPOTENCY_KEY_INVALID", message: string) {
    super(message, code, 400);
    this.name = "TicketRequestError";
  }
}

/** 构造 `/web` 错误信封；只允许稳定错误码与稳定文案。 */
export function buildTicketErrorBody(code: string, message: string): WebErr {
  return { success: false, error: { code, message } };
}

/**
 * 取写路由的幂等键；缺失与格式不合法分别报两个稳定错误码。
 *
 * 格式判定复用 `IdempotencyKeyHeaderSchema`：正则的真相只在 schema 层，本包不出现第二份；服务层还会再
 * 复检一次（挡住不经路由的调用方），这里的前置校验是为了给出可区分的错误码而不是重复把关。
 */
export function requireTicketIdempotencyKey(headers: TicketRequestHeaders): string {
  const value = headers["idempotency-key"];
  if (value === undefined || value.length === 0) {
    throw new TicketRequestError("IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key 请求头");
  }
  const parsed = IdempotencyKeyHeaderSchema.safeParse({ "idempotency-key": value });
  if (!parsed.success) {
    throw new TicketRequestError("IDEMPOTENCY_KEY_INVALID", "Idempotency-Key 需为 8–128 位字母、数字、下划线或短横线");
  }
  return parsed.data["idempotency-key"];
}

/**
 * 把领域错误映射为 `/web` 错误信封；未列入映射表的错误原样上抛（交宿主兜底 500）。
 *
 * 签名与合同 §9 的差异只有一处：参数是 Elysia 的 `status`（返回框架自有的状态标记），不是官方的
 * `error(status, body)`，返回类型也随之是信封本身而不是 `Response`——`status()` 的返回值并非
 * `Response` 实例，按 `Response` 声明会逼出一次无意义的断言。§9.3 的「判别联合 → 状态码与信封」
 * 语义不变。
 */
export function mapTicketError(error: unknown, elysiaStatus: TicketStatusWriter): WebErr {
  if (isGitError(error)) {
    const status = GIT_ERROR_STATUS[error.code];
    if (status === undefined) throw error;
    return elysiaStatus(status, buildTicketErrorBody(error.code, error.message));
  }
  if (error instanceof AppError && MAPPED_ERROR_STATUSES.has(error.statusCode)) {
    return elysiaStatus(error.statusCode, buildTicketErrorBody(error.code, error.message));
  }
  throw error;
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
