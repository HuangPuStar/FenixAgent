import * as z from "zod/v4";

/** HTTP 黑盒测试配置；API Key 只通过请求头传输。 */
export interface TemporaryE2eHttpConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** 已读取的 HTTP 响应，供资源信封与原始下载分别验证。 */
export interface TemporaryE2eResponse {
  status: number;
  headers: Headers;
  json: unknown;
  text: string;
}

interface RequestOptions {
  json?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  expected?: number | number[];
  /** 完整响应到达后报告状态，调用方判断是否为写入完成或明确拒绝。 */
  onResponseComplete?: (status: number) => void;
}

/** 请求、响应及错误统一脱敏，避免服务端回显凭据时泄漏到终端。 */
export class TemporaryE2eHttp {
  constructor(private readonly config: TemporaryE2eHttpConfig) {}

  /** 打印脱敏后的证据；过长响应明确标注截断，断言仍使用完整响应。 */
  log(value: unknown): void {
    const text =
      typeof value === "string"
        ? value
        : JSON.stringify(
            value,
            (key, item) =>
              /authorization|api[-_]?key|secret|token|password|cookie|session[-_]?id/i.test(key) ? "<redacted>" : item,
            2,
          );
    let safe = text ?? String(value);
    for (const secret of [
      this.config.apiKey,
      encodeURIComponent(this.config.apiKey),
      JSON.stringify(this.config.apiKey).slice(1, -1),
    ]) {
      if (secret) safe = safe.split(secret).join("<redacted>");
    }
    console.log(safe.length > 20_000 ? `${safe.slice(0, 20_000)}\n...<响应已截断>` : safe);
  }

  /** 执行一次真实 HTTP 请求，输出方法、URL、请求体、状态、耗时、响应头和响应体。 */
  async request(method: string, path: string, options: RequestOptions = {}): Promise<TemporaryE2eResponse> {
    const url = `${this.config.baseUrl}${path}`;
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${this.config.apiKey}`);
    if (options.json !== undefined) headers.set("Content-Type", "application/json");
    this.log(`\n>>> ${method} ${url}`);
    this.log(Object.fromEntries(headers));
    if (options.json !== undefined) this.log(options.json);
    if (options.form) {
      const fields: Array<{ field: string; value: string | File }> = [];
      options.form.forEach((value, field) => {
        fields.push({ field, value });
      });
      this.log({
        multipart: await Promise.all(
          fields.map(async ({ field, value }) => ({
            field,
            value:
              typeof value === "string"
                ? value
                : { name: value.name, size: value.size, type: value.type, content: await value.text() },
          })),
        ),
      });
    }
    const started = Date.now();
    try {
      const deadline = AbortSignal.timeout(this.config.timeoutMs);
      const response = await fetch(url, {
        method,
        headers,
        body: options.form ?? (options.json === undefined ? undefined : JSON.stringify(options.json)),
        signal: this.config.signal ? AbortSignal.any([deadline, this.config.signal]) : deadline,
        redirect: "error",
      });
      const text = await response.text();
      options.onResponseComplete?.(response.status);
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* 文件下载与非 JSON 错误页保留原文。 */
      }
      this.log(`<<< HTTP ${response.status} (${Date.now() - started}ms)`);
      this.log(
        Object.fromEntries(
          [...response.headers].filter(([name]) =>
            ["content-type", "x-request-id", "x-instance-id", "x-session-id"].includes(name),
          ),
        ),
      );
      this.log(json ?? JSON.stringify(text));
      const expected = options.expected ?? 200;
      if (!(Array.isArray(expected) ? expected.includes(response.status) : response.status === expected))
        throw new Error(`${method} ${path}: HTTP ${response.status}，期望 ${JSON.stringify(expected)}`);
      return { status: response.status, headers: response.headers, json, text };
    } catch (error) {
      this.log(`[HTTP FAIL] ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /** 校验资源 API 信封及 wire DTO，不把 HTTP 200 的业务失败视为成功。 */
  async api<T>(method: string, path: string, schema: z.ZodType<T>, options: RequestOptions = {}): Promise<T> {
    const response = await this.request(method, path, options);
    const result = z.object({ success: z.literal(true), data: schema }).safeParse(response.json);
    if (!result.success) throw new Error(`${method} ${path}: 响应信封或 data 不符合接口契约：${result.error.message}`);
    return result.data.data;
  }
}
