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
  /**
   * 附件上传/下载的超时；默认 60 s。
   *
   * 与 {@link requestTimeoutMs} 分开：附件是 MB 级流，用 15 s 会把正常传输掐断；两者都不读 env。
   */
  readonly attachmentTimeoutMs?: number;
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

/**
 * 流式读结果：响应体**不进内存**，交给调用方按块消费。
 *
 * 只有附件内容下载走这条路径（JSON 读路径的 1 MiB 上限对 MB 级附件不成立，见
 * {@link ForgejoHttpClient.getAttachmentStream}）。
 */
export interface ForgejoStreamResponse {
  /** 上游字节流；204/空体时是 null。调用方必须消费到底或取消，否则并发名额不归还。 */
  readonly stream: ReadableStream<Uint8Array> | null;
  readonly contentType: string | null;
  readonly contentLength: number | null;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_ATTACHMENT_TIMEOUT_MS = 60_000;
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
 * 附件内容的路径空间：Forgejo 把附件字节放在 **API 前缀之外**的 `/attachments/{uuid}`。
 *
 * 这是本层唯一允许访问 `/api/v1` 以外地址的入口，因此路径**不由调用方提供**：调用方只给 uuid，路径在
 * 本文件内拼出。允许调用方传路径等于把固定 origin 的约束降级成字符串拼接，凭据会被带去任意同源地址。
 */
const ATTACHMENT_PATH_PREFIX = "/attachments/";
/** uuid 形状的宽松校验：只允许 URL 路径安全字符，长度有界；换一种上游编号形态也不会误判成路径逃逸。 */
const ATTACHMENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

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
 * `WRITE_UNCERTAIN`，让恢复流程去核对一次从未发生的写入。
 *
 * 413 / 422 归 `INVALID_REQUEST`：附件上传的两个确定拒绝（超过上游大小上限、文件类型不在白名单）。它们
 * 同样不能走 `UNAVAILABLE`——一次被拒绝的上传若被标成「结果未定」，工单侧会为它保留待核对态并回源扫描
 * 一份永远不存在的附件。合同未列出的其余 4xx（400/405…）仍落到 `UNAVAILABLE` 默认分支。
 */
export function statusToGitError(status: number, message: string): GitError {
  if (status === 401 || status === 403) return new GitError("FORBIDDEN", message, { status });
  if (status === 404) return new GitError("NOT_FOUND", message, { status });
  if (status === 409) return new GitError("CONFLICT", message, { status });
  if (status === 413 || status === 422) return new GitError("INVALID_REQUEST", message, { status });
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

/** `Content-Length` 解析：缺失或非法一律 null（上游的长度头不作为有界读的依据，只作展示）。 */
function contentLengthOf(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * 把上游响应体包成「消费完/取消/出错才归还并发名额」的流。
 *
 * 直接返回上游 `ReadableStream` 会让名额与流的实际生命周期脱钩：调用方一旦不读也不取消，名额永不归还，
 * 之后所有请求排在闸门后（表现为「全部超时」）。因此这里接管 reader，在三个出口各释放一次。
 */
function guardStream(upstream: ReadableStream<Uint8Array>, release: () => void): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          reader.releaseLock();
          release();
          controller.close();
          return;
        }
        if (value !== undefined) controller.enqueue(value);
      } catch (error) {
        reader.releaseLock();
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      release();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
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
  readonly #attachmentTimeoutMs: number;
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
    this.#attachmentTimeoutMs = normalizePositive(options.attachmentTimeoutMs, DEFAULT_ATTACHMENT_TIMEOUT_MS);
    // 退避允许为 0（测试消除等待），只拒绝负数与非整数；normalizePositive 的最小值是 1，故单列一行。
    const retryDelay = options.readRetryDelayMs ?? DEFAULT_READ_RETRY_DELAY_MS;
    this.#readRetryDelayMs = Number.isInteger(retryDelay) && retryDelay >= 0 ? retryDelay : DEFAULT_READ_RETRY_DELAY_MS;
    this.#gate = new RequestGate(normalizePositive(options.maxConcurrentRequests, DEFAULT_MAX_CONCURRENT_REQUESTS));
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /**
   * 附件上传：multipart/form-data 写请求。
   *
   * 与 `postJson` 的三点差异都是有意的：
   * - 请求体是 FormData（boundary 由 fetch 生成），不带 `content-type` 头——手写它必然与 boundary 冲突；
   * - 超时用 `attachmentTimeoutMs`：MB 级上传在 15 s 内经常传不完；
   * - 仍**不**自动重放（写语义与 `postJson` 完全一致）。
   */
  async postMultipart(path: string, form: FormData, context?: ForgejoRequestContext): Promise<unknown> {
    return this.#write("POST", path, form, context, this.#attachmentTimeoutMs);
  }

  /**
   * 附件内容下载：唯一**不做响应体上限**的读入口。
   *
   * 1 MiB 上限的意义是「不让失控的 JSON 响应吃满内存」，而附件本来就是 MB 级字节，套用同一条上限等于
   * 让功能不可用。安全边界因此换了形式而不是取消：路径由本方法用**校验过的 uuid** 拼出（见
   * {@link ATTACHMENT_PATH_PREFIX}），字节按块交给调用方，进程内存不随附件大小增长。
   *
   * 并发名额与流的生命周期绑定：流被读完、取消或出错时才归还。超时覆盖整条流——`AbortSignal` 一次性，
   * 不会在收到响应头后重置（见 `#dispatch`）。
   */
  async getAttachmentStream(attachmentUuid: string, context?: ForgejoRequestContext): Promise<ForgejoStreamResponse> {
    if (!ATTACHMENT_TOKEN_PATTERN.test(attachmentUuid)) {
      throw new GitError("INVALID_RESPONSE", "附件下载坐标不是合法的 uuid");
    }
    const path = `${ATTACHMENT_PATH_PREFIX}${attachmentUuid}`;
    const label = `GET ${path}`;
    const startedAt = Date.now();
    await this.#gate.acquire();
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.#gate.release();
    };
    try {
      const response = await this.#dispatch("GET", path, undefined, this.#attachmentTimeoutMs);
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => undefined);
        throw statusToGitError(response.status, `Forgejo 返回 HTTP ${response.status}（${label}）`);
      }
      // Bun 把 `Response.body` 声明成 `ReadableStream<any>`；二进制响应的块类型在运行期就是 Uint8Array，
      // 这里按真实类型收窄一次（`ReadableStream` 对块类型不变型，不收窄就过不了本文件的签名）。
      const upstream = response.body as ReadableStream<Uint8Array> | null;
      if (upstream === null) {
        release();
        return { stream: null, contentType: null, contentLength: contentLengthOf(response.headers) };
      }
      logger.debug("git.forgejo.request", {
        method: "GET",
        path,
        status: response.status,
        durationMs: Date.now() - startedAt,
        ...contextFields(context),
      });
      return {
        stream: guardStream(upstream, release),
        contentType: response.headers.get("content-type"),
        contentLength: contentLengthOf(response.headers),
      };
    } catch (error) {
      release();
      const normalized = isGitError(error) ? error : toNetworkError(error, label);
      const enriched = withOperationId(normalized, context?.operationId);
      logger.warn("git.forgejo.request_failed", {
        method: "GET",
        path,
        status: enriched.status,
        code: enriched.code,
        durationMs: Date.now() - startedAt,
        ...contextFields(context),
      });
      throw enriched;
    }
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

  async #write(
    method: HttpMethod,
    path: string,
    body: unknown,
    context?: ForgejoRequestContext,
    timeoutMs?: number,
  ): Promise<unknown> {
    try {
      return (await this.#request(method, path, body, context, timeoutMs)).body;
    } catch (error) {
      throw promoteWriteError(error);
    }
  }

  async #request(
    method: HttpMethod,
    path: string,
    body: unknown,
    context: ForgejoRequestContext | undefined,
    timeoutMs: number = this.#timeoutMs,
  ): Promise<ForgejoJsonResponse> {
    const startedAt = Date.now();
    const label = `${method} ${path}`;
    // 先占名额再计时：排队等待不该消耗请求超时预算，否则高负载下所有请求会成批超时。
    await this.#gate.acquire();
    try {
      const response = await this.#dispatch(method, path, body, timeoutMs);
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

  /**
   * 发出请求并处理同源重定向；写请求与方法一起重放，不从 303 降级成 GET（见文件头）。
   *
   * 超时为**一次操作一个信号**：跳转期间不重置，整个请求（含响应体的读取窗口）的总时长有上界。
   */
  async #dispatch(method: HttpMethod, path: string, body: unknown, timeoutMs: number): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `token ${this.#token}`,
      accept: "application/json",
    };
    // `RequestInit["body"]` 而不是全局 `BodyInit`：本包只保证 fetch 的类型可见（`types: ["bun"]`），
    // 顶层 `BodyInit` 别名不在解析范围内。
    let payload: RequestInit["body"];
    if (body instanceof FormData) {
      // multipart 的 content-type（含 boundary）由 fetch 生成；手写会让 boundary 与正文不一致。
      payload = body;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const signal = AbortSignal.timeout(timeoutMs);
    // 两个地址空间都只由内部常量选择：JSON 走 `/api/v1`，附件内容走 origin 根的 `/attachments/`。
    let url = path.startsWith(ATTACHMENT_PATH_PREFIX) ? `${this.#origin}${path}` : `${this.#baseUrl}${path}`;
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
