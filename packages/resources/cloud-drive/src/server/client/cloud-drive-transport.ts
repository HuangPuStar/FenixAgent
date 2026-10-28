import type * as z from "zod/v4";
import { CloudDriveError, invalidResponseError, transportError, upstreamError } from "./cloud-drive-error";
import type { PatchUploadInput } from "./cloud-drive-gateway";
import {
  createTimeoutSignal,
  parseJsonText,
  parseWire,
  readBoundedText,
  readTusHeaders,
  SUBJECT_PATTERN,
} from "./cloud-drive-http";

/**
 * CloudDrive 的传输层：认证头、超时、错误分类、响应形状校验与诊断只在这里实现一次。
 *
 * 与资源 client 分开是为了让「所有出站请求共享同一套安全与失败语义」这件事有一个明确的 owner：
 * `baseHeaders()` 是 master key 与 `X-On-Behalf-Of` 的唯一生成点，调用方无法覆盖；任何新增端点都必须
 * 经过本类，而不是各自拼 fetch。
 */

/** fetch 的窄签名：`typeof fetch` 还带 `preconnect` 等静态成员，注入实现时无需伪造它们。 */
export type CloudDriveFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** 诊断事件；只含调用元数据，**不含** headers、body、master key 或下载票据。 */
export interface CloudDriveDiagnostic {
  readonly operation: string;
  readonly subject: string;
  readonly durationMs: number;
  readonly outcome: "ok" | "error";
  readonly status?: number;
  readonly code?: string;
}

export type CloudDriveDiagnosticHandler = (diagnostic: CloudDriveDiagnostic) => void;

export interface CloudDriveTransportOptions {
  readonly baseUrl: string;
  readonly masterKey: string;
  readonly keyId?: string;
  readonly timeoutMs: number;
  /** 注入 fetch 供单测替换；生产用全局 fetch。 */
  readonly fetchImpl?: CloudDriveFetch;
  readonly onDiagnostic?: CloudDriveDiagnosticHandler;
}

export interface JsonRequest {
  readonly method: string;
  readonly path: string;
  readonly query?: Record<string, string | undefined>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

export interface StreamRequest {
  readonly path: string;
  readonly query?: Record<string, string | undefined>;
  readonly accept: string;
  readonly range?: string;
  readonly signal?: AbortSignal;
}

export interface TusRequest {
  readonly method: "HEAD" | "PATCH";
  readonly signal?: AbortSignal;
  readonly chunk?: PatchUploadInput;
}

export class CloudDriveTransport {
  private readonly baseUrl: string;
  private readonly masterKey: string;
  private readonly keyId: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: CloudDriveFetch;
  private readonly onDiagnostic: CloudDriveDiagnosticHandler | undefined;

  constructor(options: CloudDriveTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.masterKey = options.masterKey;
    this.keyId = options.keyId;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.onDiagnostic = options.onDiagnostic;
  }

  /**
   * JSON 请求：构造认证头、计时、错误分类与上游形状校验只在这里发生一次。
   *
   * 计时覆盖到响应体读完为止：JSON 响应很小，body 卡住同样属于失败。
   */
  async jsonRequest<TSchema extends z.ZodType>(
    subject: string,
    operation: string,
    request: JsonRequest,
    schema: TSchema,
  ): Promise<z.output<TSchema>> {
    const startedAt = Date.now();
    const timeout = createTimeoutSignal(request.signal, this.timeoutMs);
    let status: number | undefined;
    let code: string | undefined;
    try {
      const headers = this.baseHeaders(subject);
      headers.Accept = "application/json";
      const hasBody = request.body !== undefined;
      if (hasBody) headers["Content-Type"] = "application/json";
      const response = await this.fetchImpl(this.url(request.path, request.query), {
        method: request.method,
        headers,
        body: hasBody ? JSON.stringify(request.body) : undefined,
        signal: timeout.signal,
      });
      status = response.status;
      if (!response.ok) throw upstreamError(response.status, parseJsonText(await readBoundedText(response)));
      const text = await response.text();
      timeout.clear();
      const payload = parseJsonText(text);
      if (payload === undefined) throw invalidResponseError();
      return parseWire(schema, payload);
    } catch (error) {
      const failure = failureOf(error, timeout);
      code = failure.code;
      throw failure;
    } finally {
      timeout.clear();
      this.report({ operation, subject, status, code, durationMs: Date.now() - startedAt });
    }
  }

  /**
   * 打开二进制流（下载 / 页图）。
   *
   * 超时只覆盖到响应头：长传输不应被请求超时打断；调用方的 `AbortSignal`（客户端断开）仍会中止上游
   * 连接。
   */
  async openStream(subject: string, operation: string, request: StreamRequest): Promise<Response> {
    const startedAt = Date.now();
    const timeout = createTimeoutSignal(request.signal, this.timeoutMs);
    let status: number | undefined;
    let code: string | undefined;
    try {
      const headers = this.baseHeaders(subject);
      headers.Accept = request.accept;
      if (request.range) headers.Range = request.range;
      const response = await this.fetchImpl(this.url(request.path, request.query), {
        method: "GET",
        headers,
        signal: timeout.signal,
      });
      status = response.status;
      if (!response.ok) throw upstreamError(response.status, parseJsonText(await readBoundedText(response)));
      if (!response.body) throw invalidResponseError();
      return response;
    } catch (error) {
      const failure = failureOf(error, timeout);
      code = failure.code;
      throw failure;
    } finally {
      timeout.clearTimeout();
      this.report({ operation, subject, status, code, durationMs: Date.now() - startedAt });
    }
  }

  /** TUS HEAD/PATCH：认证头 + 进度头 + 统一错误分类。 */
  async tusRequest(subject: string, operation: string, uploadId: string, request: TusRequest) {
    const startedAt = Date.now();
    const timeout = createTimeoutSignal(request.signal, this.timeoutMs);
    let status: number | undefined;
    let code: string | undefined;
    try {
      const headers = this.baseHeaders(subject);
      const init: RequestInit = { method: request.method, headers, signal: timeout.signal };
      if (request.chunk) {
        headers["Tus-Resumable"] = "1.0.0";
        headers["Upload-Offset"] = String(request.chunk.offset);
        headers["Content-Type"] = "application/offset+octet-stream";
        headers["Content-Length"] = String(request.chunk.chunk.byteLength);
        init.body = request.chunk.chunk;
      }
      const response = await this.fetchImpl(this.url(`/v1/tus/${encodeURIComponent(uploadId)}`), init);
      status = response.status;
      if (!response.ok) throw upstreamError(response.status, parseJsonText(await readBoundedText(response)));
      return { uploadId, ...readTusHeaders(response) };
    } catch (error) {
      const failure = failureOf(error, timeout);
      code = failure.code;
      throw failure;
    } finally {
      timeout.clear();
      this.report({ operation, subject, status, code, durationMs: Date.now() - startedAt });
    }
  }

  /** 认证头：master key 与主体断言只在这里出现，调用方无法覆盖。 */
  private baseHeaders(subject: string): Record<string, string> {
    if (!SUBJECT_PATTERN.test(subject)) {
      throw new CloudDriveError("invalid", "CLOUD_DRIVE_SUBJECT_INVALID", "当前用户标识不适用于 CloudDrive");
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.masterKey}`,
      "X-On-Behalf-Of": subject,
    };
    if (this.keyId) headers["X-Key-Id"] = this.keyId;
    return headers;
  }

  private url(path: string, query?: Record<string, string | undefined>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private report(event: Omit<CloudDriveDiagnostic, "outcome">): void {
    if (!this.onDiagnostic) return;
    try {
      this.onDiagnostic({ ...event, outcome: event.code ? "error" : "ok" });
    } catch {
      // 诊断回调是旁路：日志实现出错不得改变请求结果。
    }
  }
}

/** 已是 CloudDriveError 就原样返回，否则按网络/超时归类。 */
function failureOf(error: unknown, timeout: { didTimeout(): boolean }): CloudDriveError {
  return error instanceof CloudDriveError ? error : transportError(error, timeout.didTimeout());
}
