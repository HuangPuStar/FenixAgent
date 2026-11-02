import type * as z from "zod/v4";
import { invalidResponseError } from "./cloud-drive-error";

/**
 * CloudDrive client 的传输原语：超时合并、错误体截断、上游形状校验、TUS 头解析。
 *
 * 抽出来的理由是「一处实现、多处复用」：JSON 请求、内容流、TUS HEAD/PATCH 的超时与错误体读取语义
 * 必须完全一致，任何一处各自实现都会让某一类请求在超时或大错误体下表现不同。
 */

/** `X-On-Behalf-Of` 的合法形状（与 CloudDrive `validOnBehalfOf` 逐字一致）。 */
export const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

/** 错误响应体最多读取的字节数：解析错误码只需要开头，避免被异常大响应拖住。 */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** 校验上游成功响应；形状漂移按 502 处理，而不是把 undefined 透传给前端。 */
export function parseWire<TSchema extends z.ZodType>(schema: TSchema, payload: unknown): z.output<TSchema> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw invalidResponseError(parsed.error);
  return parsed.data;
}

/** 解析 JSON 文本；空串或非法 JSON 返回 undefined（由调用方决定是错误还是「无 body」）。 */
export function parseJsonText(text: string): unknown {
  if (!text) return;
  try {
    return JSON.parse(text);
  } catch {
    return;
  }
}

/** TUS HEAD/PATCH 的权威进度都在响应头里；缺失或非数值视为上游协议漂移。 */
export function readTusHeaders(response: Response): { offset: number; length: number } {
  const rawOffset = response.headers.get("upload-offset");
  const rawLength = response.headers.get("upload-length");
  // 不能直接 Number(null)：缺失的头会静默变成 0，前端会从「从头开始」重传。
  if (rawOffset === null || rawLength === null || !/^\d+$/.test(rawOffset) || !/^\d+$/.test(rawLength)) {
    throw invalidResponseError();
  }
  return { offset: Number(rawOffset), length: Number(rawLength) };
}

/** 读取最多 64KiB 的响应文本；错误响应只需要 code。 */
export async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(Math.min(total, MAX_ERROR_BODY_BYTES));
  let written = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, merged.byteLength - written);
    if (take <= 0) break;
    merged.set(chunk.subarray(0, take), written);
    written += take;
  }
  return new TextDecoder().decode(merged);
}

export interface TimeoutSignal {
  readonly signal: AbortSignal;
  /** 请求已结束：清计时器并解绑外部监听。 */
  clear(): void;
  /** 只清计时器：长传输仍在进行，客户端断开仍需中止上游连接。 */
  clearTimeout(): void;
  didTimeout(): boolean;
}

/** 外部取消与超时合并：任一触发都中止请求，只有计时器触发时 `didTimeout()` 为真。 */
export function createTimeoutSignal(external: AbortSignal | undefined, timeoutMs: number): TimeoutSignal {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onAbort, { once: true });
  }
  const clearTimeoutOnly = () => clearTimeout(timer);
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeoutOnly();
      external?.removeEventListener("abort", onAbort);
    },
    clearTimeout: clearTimeoutOnly,
    didTimeout: () => timedOut,
  };
}
