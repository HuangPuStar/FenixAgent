/**
 * 工单路由的**请求面公共设施**（`/web` 与 `/api/system/tickets` 两个面共用）。
 *
 * 为什么单独成文件：这四件事在两个面上必须逐字同形，任何一个面自己实现第二份都会立刻分叉。
 *
 * 1. **上下文形状**：守卫经 `AnyElysia` 注入后，跨包边界上 Elysia 把上下文类型退化成
 *    `{ [x: string]: any }`，仓内既有写法要在每处 handler 上写 `: any` + `biome-ignore`。这里让 handler 收
 *    `Record<string, unknown>`（对该上下文类型可赋值，不需要 `any`），再把真正用到的字段声明成别名——「route
 *    只读 params / query / body / headers / request」这条边界因此可见，收窄点也只剩一处。
 * 2. **上传请求面**：附件上传是 multipart，必须把 `request.formData()` 交给路由（见附件协议文件的文件头）。
 * 3. **幂等键的宽松模型与前置校验**：缺失与格式非法必须给出**两个**稳定错误码（`IDEMPOTENCY_KEY_REQUIRED` /
 *    `IDEMPOTENCY_KEY_INVALID`），而不是宿主 error-handler 的通用 `VALIDATION_ERROR`。
 */

import { AppError } from "@fenix/platform-sdk";
import * as z from "zod/v4";
import { IdempotencyKeyHeaderSchema } from "../../schemas/ticket.schema";

/** Elysia 交给 handler 的上下文形状（字段类型跨包边界退化成索引签名，见文件头）。 */
export type TicketRawContext = Record<string, unknown>;

/** 请求头最窄形状：键名小写（HTTP 头名不区分大小写，Elysia 的 `headers` 模型按小写键取值）。 */
export interface TicketRequestHeaders {
  readonly "idempotency-key"?: string | undefined;
}

/**
 * 上传表单的读取面，取自 `Request.formData()`。
 *
 * 不直接写全局 `FormData`：运行环境里 DOM lib 与 undici 各声明了一份同名结构，用全局名会把运行时拿到
 * 的那一份判成不可赋值（与 `skill-upload-form.ts` 同口径）。本模块只用到 `getAll` 与 `get`。
 */
export type TicketUploadFormData = Awaited<ReturnType<Request["formData"]>>;

/** 路由用到的请求面：附件上传需要 `formData()`，其余方法一律不出现（边界可见）。 */
export interface TicketUploadRequest {
  readonly formData: () => Promise<TicketUploadFormData>;
}

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
