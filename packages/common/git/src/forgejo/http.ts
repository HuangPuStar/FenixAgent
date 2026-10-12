/**
 * Forgejo HTTP 传输层：本包**唯一**发出外部请求的地方。
 *
 * 安全与可靠性约束集中在这一层，因为它们是整个适配器共同的底线：
 * - origin 由构造参数固定，调用方永远不能提供 URL（否则本层会变成可被诱导去读内网的代理）；
 * - 只跟同源重定向，凭据头不会随上游的 `Location` 被带到别的域；
 * - 响应体有硬上限，超限即断开——敌意或失控的上游不能用超大响应把进程内存吃满；
 * - 在途请求有并发闸，`AbortSignal.timeout` 只覆盖已发出的请求；
 * - 错误码集中映射（{@link statusToGitError}），消息只带本地方法名与路径，绝不回显上游文本。
 *
 * 刻意**不做**的两件事：
 * - 写请求不自动重试。远端是否已经落库未知时重放会造出第二份对象，这类失败走 `WRITE_UNCERTAIN`
 *   与恢复核对（方案 §9）；读请求则在本层自动重试（上限 2 次、只针对可重放的失败，见
 *   {@link ForgejoHttpClient.getJsonWithHeaders}）——GET 可安全重放，把重试留给每个调用方只会写漏；
 * - 不自动跟随重定向。`fetch` 的 follow 会把 `Authorization` 交给重定向目标，且无法限制跳数。
 *
 * 写语义：`postJson` / `patchJson` / `putJson` 把 `UNAVAILABLE` 与 `INVALID_RESPONSE` 提升为
 * `WRITE_UNCERTAIN`（见 `contracts/errors.ts` 的说明）；读方法保持原码，重试耗尽后原样抛出。
 */

import { createLogger } from "@fenix/logger";
import { GitError, isGitError, toWriteUncertain } from "../contracts/errors";

/** 可注入的 fetch；测试用本地 stub 替换，生产走全局 `fetch`。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * 请求的关联字段（日志与错误共用）。
 *
 * 只允许放非敏感坐标：`operationId` 供运维把用户可见错误与请求日志串起来；`connectionId` 与
 * `repositoryRef` 是本包能给出的最小定位信息。token 与正文永远不出现在这里。
 */
export interface ForgejoRequestContext {
  readonly operationId?: string;
  /** 连接 ID；`createRepository` 这类不感知连接的调用不提供。 */
  readonly connectionId?: string;
  /** `owner/name` 形式的仓库坐标。 */
  readonly repositoryRef?: string;
}

export interface ForgejoHttpClientOptions {
  /** 固定 origin（来自连接配置）：请求 URL 只由它与内部路径拼成。 */
  readonly baseUrl: string;
  /** Forgejo 访问凭据：只写在请求头里，不进日志、不进错误。 */
  readonly token: string;
  /** 请求超时；默认 15 s。绝不读 env——配置由调用方注入。 */
  readonly requestTimeoutMs?: number;
  /** 并发闸上限；默认 16。 */
  readonly maxConcurrentRequests?: number;
  /** 读重试的退避基数（毫秒）；默认 200，测试注入 0 以消除等待。 */
  readonly readRetryDelayMs?: number;
  readonly fetchImpl?: FetchLike;
}

/** 读结果：分页需要读 `Link` 响应头，所以读入口把响应头一并交给调用方。 */
export interface ForgejoJsonResponse {
  /** 解析后的 JSON 值；204 或空体为 null。 */
  readonly body: unknown;
  readonly headers: Headers;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 16;
/** 响应体上限 1 MiB：分页与正文场景足够，同时挡住失控响应。 */
const MAX_RESPONSE_BYTES = 1024 * 1024;
/** 同源重定向最多 2 跳：Forgejo 的 /api/v1 不会重定向，这里只兜反向代理的路径改写。 */
const MAX_REDIRECTS = 2;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** 读请求的最大自动重试次数（方案 §5）：首次之外的 2 次。 */
const MAX_READ_RETRIES = 2;
/** 读重试退避基数（毫秒）；实际等待按尝试次数线性放大。 */
const DEFAULT_READ_RETRY_DELAY_MS = 200;

/**
 * 可安全重放的读失败：远端明确限流或暂时不可用。
 *
 * `NOT_FOUND` / `FORBIDDEN` / `CONFLICT` / `INVALID_RESPONSE` 都是确定性结果，重试只会把同一个答案
 * 再问一遍并拖长响应时间。
 */
function isRetryableRead(error: GitError): boolean {
  return error.code === "UNAVAILABLE" || error.code === "RATE_LIMITED";
}

/** 退避等待；`setTimeout` 而非忙等，且不引入随机抖动（重试次数可被测试精确断言）。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const logger = createLogger("git");

type HttpMethod = "GET" | "POST" | "PATCH" | "PUT";

/**
 * 最简信号量（FIFO）。
 *
 * 不引第三方库：这里只需要「计数 + 唤醒队首」，通用并发库会把本包拖进额外的供应链面。
 * 释放时把名额**直接移交**给队首等待者，而不是先归还再唤醒——先归还的微任务窗口会让新请求插队，
 * 实际并发超过上限。
 */
class RequestGate {
  #available: number;
  readonly #waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.#available = limit;
  }

  async acquire(): Promise<void> {
    if (this.#available > 0) {
      this.#available -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.#waiters.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.#available += 1;
  }
}

/**
 * HTTP 状态 → 对外错误码（唯一映射点）。
 *
 * 401 与 403 同归 `FORBIDDEN`：凭据被拒绝是**确定**的失败，而 `UNAVAILABLE` 会把写请求提升成
 * `WRITE_UNCERTAIN`，让恢复流程去核对一次从未发生的写入。合同未列出的 4xx（400/405/422…）落到
 * `UNAVAILABLE`，这是合同口径的默认分支，T02 若发现业务校验类错误污染恢复流程，需要连同合同一起修订码表。
 */
export function statusToGitError(status: number, message: string): GitError {
  if (status === 401 || status === 403) return new GitError("FORBIDDEN", message, { status });
  if (status === 404) return new GitError("NOT_FOUND", message, { status });
  if (status === 409) return new GitError("CONFLICT", message, { status });
  if (status === 429) return new GitError("RATE_LIMITED", message, { status });
  return new GitError("UNAVAILABLE", message, { status });
}

/** 把 operationId 补进错误：用户可见错误与运维日志靠它对应。已是 GitError 的码与状态不变。 */
function withOperationId(error: GitError, operationId: string | undefined): GitError {
  if (operationId === undefined || error.operationId !== undefined) return error;
  return new GitError(error.code, error.message, {
    cause: error,
    operationId,
    status: error.status,
  });
}

/** 网络层失败归一为 `UNAVAILABLE`；只带错误类名，不回显 fetch 的错误文本（可能含请求细节）。 */
function toNetworkError(error: unknown, label: string): GitError {
  const name = error instanceof Error ? error.name : typeof error;
  const timedOut = name === "TimeoutError" || name === "AbortError";
  return new GitError(
    "UNAVAILABLE",
    timedOut ? `Forgejo 请求超时（${label}）` : `Forgejo 请求失败：${name}（${label}）`,
    { cause: error },
  );
}

/** 日志/错误用的非敏感字段；缺省字段不写入，避免日志里出现一串 undefined。 */
function contextFields(context: ForgejoRequestContext | undefined): Record<string, string> {
  const fields: Record<string, string> = {};
  if (context?.operationId !== undefined) fields.operationId = context.operationId;
  if (context?.connectionId !== undefined) fields.connectionId = context.connectionId;
  if (context?.repositoryRef !== undefined) fields.repositoryRef = context.repositoryRef;
  return fields;
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new GitError("INVALID_RESPONSE", `Forgejo 响应体不是合法 JSON（${label}）`, { cause: error });
  }
}

/**
 * 通过构造参数固定 origin 的 Forgejo JSON 客户端。
 *
 * 实例本身无状态（除并发闸），因此可以按连接或按绑定复用；并发闸是按实例计的，实例越多对同一
 * Forgejo 的总并发越高——配额的含义与放置位置由组合根决定（见 `contracts/client.ts` 的装配说明）。
 */
export class ForgejoHttpClient {
  /** 已经带 `/api/v1` 前缀的基址；请求路径只允许是它的后半段。 */
  readonly #baseUrl: string;
  readonly #origin: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #readRetryDelayMs: number;
  readonly #gate: RequestGate;
  readonly #fetch: FetchLike;

  constructor(options: ForgejoHttpClientOptions) {
    const trimmed = options.baseUrl.replace(/\/+$/, "");
    let origin: string;
    try {
      origin = new URL(trimmed).origin;
    } catch (error) {
      throw new Error("Forgejo baseUrl 不是合法 URL", { cause: error });
    }
    this.#baseUrl = `${trimmed}/api/v1`;
    this.#origin = origin;
    this.#token = options.token;
    this.#timeoutMs = normalizePositive(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    // 退避允许为 0（测试消除等待），只拒绝负数与非整数；normalizePositive 的最小值是 1，故单列一行。
    const retryDelay = options.readRetryDelayMs ?? DEFAULT_READ_RETRY_DELAY_MS;
    this.#readRetryDelayMs = Number.isInteger(retryDelay) && retryDelay >= 0 ? retryDelay : DEFAULT_READ_RETRY_DELAY_MS;
    this.#gate = new RequestGate(normalizePositive(options.maxConcurrentRequests, DEFAULT_MAX_CONCURRENT_REQUESTS));
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** 读请求，返回解析后的响应体（204/空体为 null）。 */
  async getJson(path: string, context?: ForgejoRequestContext): Promise<unknown> {
    return (await this.getJsonWithHeaders(path, context)).body;
  }

  /**
   * 读请求，连响应头一起返回；列表分页要读 `Link` 头，故单独提供该入口。
   *
   * 这是**唯一**带自动重试的入口：GET 可安全重放，失败后最多再试 2 次（方案 §5），且只针对
   * `UNAVAILABLE` 与 `RATE_LIMITED`。写入口绝不重放——远端是否落库未知时必须走恢复核对，由
   * `WRITE_UNCERTAIN` 表达。
   */
  async getJsonWithHeaders(path: string, context?: ForgejoRequestContext): Promise<ForgejoJsonResponse> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#request("GET", path, undefined, context);
      } catch (error) {
        if (!(isGitError(error) && isRetryableRead(error)) || attempt >= MAX_READ_RETRIES) throw error;
        await delay(this.#readRetryDelayMs * (attempt + 1));
      }
    }
  }

  async postJson(path: string, body: unknown, context?: ForgejoRequestContext): Promise<unknown> {
    return this.#write("POST", path, body, context);
  }

  async patchJson(path: string, body: unknown, context?: ForgejoRequestContext): Promise<unknown> {
    return this.#write("PATCH", path, body, context);
  }

  async putJson(path: string, body: unknown, context?: ForgejoRequestContext): Promise<unknown> {
    return this.#write("PUT", path, body, context);
  }

  async #write(method: HttpMethod, path: string, body: unknown, context?: ForgejoRequestContext): Promise<unknown> {
    try {
      return (await this.#request(method, path, body, context)).body;
    } catch (error) {
      throw promoteWriteError(error);
    }
  }

  async #request(
    method: HttpMethod,
    path: string,
    body: unknown,
    context: ForgejoRequestContext | undefined,
  ): Promise<ForgejoJsonResponse> {
    const startedAt = Date.now();
    const label = `${method} ${path}`;
    // 先占名额再计时：排队等待不该消耗请求超时预算，否则高负载下所有请求会成批超时。
    await this.#gate.acquire();
    try {
      const response = await this.#dispatch(method, path, body);
      if (response.status < 200 || response.status >= 300) {
        throw statusToGitError(response.status, `Forgejo 返回 HTTP ${response.status}（${label}）`);
      }
      const text = await this.#readBody(response, label);
      const bodyValue = text.trim().length === 0 ? null : parseJson(text, label);
      logger.debug("git.forgejo.request", {
        method,
        path,
        status: response.status,
        durationMs: Date.now() - startedAt,
        ...contextFields(context),
      });
      return { body: bodyValue, headers: response.headers };
    } catch (error) {
      const normalized = isGitError(error) ? error : toNetworkError(error, label);
      const enriched = withOperationId(normalized, context?.operationId);
      logger.warn("git.forgejo.request_failed", {
        method,
        path,
        status: enriched.status,
        code: enriched.code,
        durationMs: Date.now() - startedAt,
        ...contextFields(context),
      });
      throw enriched;
    } finally {
      this.#gate.release();
    }
  }

  /** 发出请求并处理同源重定向；写请求与方法一起重放，不从 303 降级成 GET（见文件头）。 */
  async #dispatch(method: HttpMethod, path: string, body: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `token ${this.#token}`,
      accept: "application/json",
    };
    let payload: string | undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    // 一次操作一个信号：跳转期间不重置超时，整个请求的总时长有上界。
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let url = `${this.#baseUrl}${path}`;
    for (let hop = 0; ; hop += 1) {
      const response = await this.#fetch(url, { method, headers, body: payload, redirect: "manual", signal });
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      const location = response.headers.get("location");
      if (location === null) return response;
      if (hop >= MAX_REDIRECTS) {
        throw new GitError("UNAVAILABLE", `Forgejo 重定向超过 ${MAX_REDIRECTS} 跳（${method} ${path}）`);
      }
      let target: URL;
      try {
        target = new URL(location, url);
      } catch (error) {
        throw new GitError("UNAVAILABLE", `Forgejo 重定向目标非法（${method} ${path}）`, { cause: error });
      }
      if (target.origin !== this.#origin) {
        throw new GitError("UNAVAILABLE", `拒绝跨源重定向（${method} ${path}）`);
      }
      url = target.toString();
    }
  }

  /**
   * 流式有界读取。
   *
   * 不用 `response.text()` 再判长度：那时整段响应已经进了内存，敌意源可以用一个超大响应把进程打爆，
   * 长度判定来不及执行。无响应流的实现（204 空体、只实现 `text()` 的测试替身）退回一次性读取。
   */
  async #readBody(response: Response, label: string): Promise<string> {
    const stream = response.body;
    if (stream === null || stream === undefined) return this.#assertWithinLimit(await response.text(), label);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new GitError("INVALID_RESPONSE", `Forgejo 响应体超过 ${MAX_RESPONSE_BYTES} 字节上限（${label}）`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return new TextDecoder().decode(concatChunks(chunks, total));
  }

  #assertWithinLimit(text: string, label: string): string {
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new GitError("INVALID_RESPONSE", `Forgejo 响应体超过 ${MAX_RESPONSE_BYTES} 字节上限（${label}）`);
    }
    return text;
  }
}

/** 写请求的错误归一：只有「远端是否落库未知」的失败会被提升，确定失败保持原码。 */
function promoteWriteError(error: unknown): unknown {
  return isGitError(error) ? toWriteUncertain(error) : error;
}

function normalizePositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
