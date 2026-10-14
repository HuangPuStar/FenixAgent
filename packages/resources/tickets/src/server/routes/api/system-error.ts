/**
 * `/api/system/tickets` 的协议层公共设施：`/api/system/*` 错误信封与 handler 工厂。
 *
 * 与 `/web` 面的 `web-error.ts` 是同一件事的两份信封：**错误的分类共用**
 * （`../ticket-error-mapping.ts`），只有成功/失败的信封与主体来源不同。
 *
 * - 成功：`{ success: true, data }`（与 `/web` 同形，行/详情等视图类型也逐字复用 `/web` 的 schema）；
 * - 失败：`{ error: { code, message } }`（`ApiSystemErrorResponseSchema`，**不带** `success` 字段——这是
 *   `/api/system/*` 的既有合同，不是 `/web` 的 `{ success: false, error }`）；
 * - 主体：**没有**。宿主 `systemApiAuthPlugin` 刻意不恢复用户 / 组织上下文，判据就是「手里有系统 key」，
 *   因此这里没有 `store.actor` 可取，路由也不做任何业务判断。
 *
 * 为什么不用宿主全局 error-handler 兜底领域错误：那一层产出的是 `{ error: { type, message } }`（`type` 而
 * 不是 `code`），与 `/api/system/*` 的合同不一致；而且它不认 `GitError`（本模块的上游失败面）。因此本面与
 * `/web` 面一样在路由内完成映射，未命中映射表的错误仍**原样上抛**交宿主兜底 500（存储与装配故障不得被伪装
 * 成协议错误）。
 *
 * 未声明 `500` 响应：本面只在路由内映射领域错误，其余异常由宿主兜底，形状不属于本模块的合同
 * （与 plugin-market 的系统面同口径）。
 */

import { classifyTicketError } from "../ticket-error-mapping";
import type { TicketRawContext, TicketRequestHeaders, TicketUploadRequest } from "../ticket-request-protocol";

/** Elysia `status(code, body)` 在本面用到的形状：写入状态码并原样返回该 body。 */
export type SystemTicketStatusWriter = <TData>(code: number, body: TData) => TData;

/**
 * 路由 handler 用到的上下文面；泛型参数由各路由按自己声明的 schema 实例化。
 *
 * 写成类型别名而不是接口：`as` 断言要求两侧至少一侧可赋值，接口没有隐式索引签名（assignable 到
 * `Record<string, unknown>` 会失败），别名有（与 `/web` 面同口径）。
 */
export type SystemTicketRouteContext<TParams = unknown, TQuery = unknown, TBody = unknown> = {
  readonly params: TParams;
  readonly query: TQuery;
  readonly body: TBody;
  readonly headers: TicketRequestHeaders;
  /** 原始请求：只有附件上传要读它（multipart 必须交给 `formData()`，见附件协议文件的文件头）。 */
  readonly request: TicketUploadRequest;
  readonly status: SystemTicketStatusWriter;
};

/** 成功载荷：写路径的 201/202 显式给出状态码，其余默认 200。 */
export interface SystemTicketSuccess {
  readonly status?: number;
  /** 响应体载荷；形状由 Elysia 按路由声明的 `response` schema 校验，这里不再重复建模。 */
  readonly data: unknown;
}

/** 构造 `/api/system/*` 的错误体；只允许稳定错误码与稳定文案。 */
export function buildSystemErrorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

/**
 * 构造一条管理面路由的 handler：收窄上下文 → 执行 → 映射状态码与错误。
 *
 * 与 `/web` 面的 `ticketHandler` 只差两点：不取主体（这一面没有主体），失败信封换成 `{ error }`。两面的
 * 「成功时给出什么载荷、写路径用哪个状态码」因此仍然逐条可对照。
 */
export function systemTicketHandler<TParams = unknown, TQuery = unknown, TBody = unknown>(
  run: (route: SystemTicketRouteContext<TParams, TQuery, TBody>) => Promise<SystemTicketSuccess>,
): (context: TicketRawContext) => Promise<unknown> {
  return async (context) => {
    const route = context as SystemTicketRouteContext<TParams, TQuery, TBody>;
    try {
      const result = await run(route);
      return route.status(result.status ?? 200, { success: true as const, data: result.data });
    } catch (error) {
      return mapSystemTicketError(error, route.status);
    }
  };
}

/**
 * 构造一条**流式**管理面路由的 handler：与 {@link systemTicketHandler} 只差成功分支——返回 `Response` 本身
 * 而不是信封。
 *
 * 只服务附件下载（唯一会返回字节流的端点）：把二进制内容塞进 `{ success, data }` 会让浏览器拿到一段 JSON
 * 而文件名与长度都得另开一趟请求。两者的收窄与错误映射必须共用同一实现，与 `/web` 面的
 * `ticketStreamHandler` 同一条理由。
 */
export function systemTicketStreamHandler<TParams = unknown, TQuery = unknown>(
  run: (route: SystemTicketRouteContext<TParams, TQuery, unknown>) => Promise<Response>,
): (context: TicketRawContext) => Promise<unknown> {
  return async (context) => {
    const route = context as SystemTicketRouteContext<TParams, TQuery, unknown>;
    try {
      return await run(route);
    } catch (error) {
      return mapSystemTicketError(error, route.status);
    }
  };
}

/** 把领域错误映射为 `/api/system/*` 错误体；未命中映射表的错误原样上抛（交宿主兜底 500）。 */
function mapSystemTicketError(error: unknown, elysiaStatus: SystemTicketStatusWriter): unknown {
  const classified = classifyTicketError(error);
  if (classified === undefined) throw error;
  return elysiaStatus(classified.status, buildSystemErrorBody(classified.code, classified.message));
}
