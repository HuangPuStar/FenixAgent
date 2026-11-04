import assert from "node:assert/strict";

/** Connection settings shared by HTTP and ACP probes. */
export interface ConnectionConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  secrets?: string[];
}

/** Interactive I/O can be replaced by local fixtures without bypassing request checks. */
export interface ManualIO {
  write: (line: string) => void;
  pause: () => Promise<void>;
}

/** Request-specific expectations, including native OpenAI responses. */
interface RequestOptions {
  body?: unknown;
  status?: number;
  headers?: Record<string, string>;
  native?: boolean;
  stream?: boolean;
  binary?: boolean;
  check?: (data: unknown, headers: Headers) => void;
}

/** Require an object before extracting protocol fields. */
export function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "预期对象响应");
  return value as Record<string, unknown>;
}

/** Require a non-empty protocol identifier or string. */
export function field(value: unknown, name: string): string {
  const result = object(value)[name];
  assert.ok(typeof result === "string" && result.length > 0, `缺少 ${name}`);
  return result;
}

/** Validate paginated collection semantics instead of treating HTTP 200 as sufficient. */
export function pageItems(value: unknown): Record<string, unknown>[] {
  const data = object(value);
  assert.ok(Array.isArray(data.items), "缺少 items");
  assert.ok(typeof data.total === "number" && data.total >= 0, "缺少 total");
  assert.ok(typeof data.page === "number" && data.page > 0, "缺少 page");
  assert.ok(typeof data.pageSize === "number" && data.pageSize > 0, "缺少 pageSize");
  return data.items.map(object);
}

/** Normalize concrete IDs to the published operation names for coverage reporting. */
export function operationName(method: string, path: string): string {
  const normalized = path
    .split("?")[0]
    .replace(/(\/providers\/)[^/]+/, "$1{providerId}")
    .replace(/(\/models\/)[^/]+/, "$1{id}")
    .replace(/(\/(?:agents|skills|mcp-servers|instances)\/)[^/]+/, "$1{id}")
    .replace(/(\/environments\/)[^/]+/, "$1{environmentId}")
    .replace(/(\/api\/v1\/workflows\/)[^/]+/, "$1{workflowId}")
    .replace(/(\/workflow-v2\/workflows\/)[^/]+/, "$1{id}");
  return `${method} ${normalized}`;
}

/** Consume complete SSE frames, including fragmented UTF-8 and CRLF delimiters. */
export async function readChatStream(response: Response, emit: (value: unknown) => void): Promise<string> {
  assert.ok(response.body, "SSE 无响应体");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let finished = false;
  let done = false;
  let assistant = false;
  const consume = (frame: string) => {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    emit(data);
    assert.ok(!done, "[DONE] 后仍有数据");
    if (data === "[DONE]") {
      assert.ok(finished, "缺少 finish_reason");
      done = true;
      return;
    }
    const chunk = object(JSON.parse(data));
    assert.ok(!chunk.error, "SSE 返回 error");
    assert.ok(Array.isArray(chunk.choices) && chunk.choices.length === 1, "SSE choices 无效");
    const choice = object(chunk.choices[0]);
    const delta = object(choice.delta);
    if (delta.role === "assistant") assistant = true;
    if (typeof delta.content === "string") text += delta.content;
    if (choice.finish_reason != null) {
      assert.ok(["stop", "length"].includes(String(choice.finish_reason)), "意外的终态");
      finished = true;
    }
  };
  try {
    while (true) {
      const next = await reader.read();
      buffer += decoder.decode(next.value, { stream: !next.done });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        consume(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
      if (next.done) break;
    }
    if (buffer.trim()) consume(buffer);
    assert.ok(done && finished && assistant && text.trim(), "SSE 截断、缺少 assistant 或没有回答");
    return text;
  } finally {
    try {
      await reader.cancel();
    } catch (error) {
      emit({ cleanupError: error instanceof Error ? error.message : String(error) });
    } finally {
      reader.releaseLock();
    }
  }
}

/** Print and verify each operation, delegating optional pauses to the caller. */
export class ManualRunner {
  readonly operations = new Set<string>();
  private sequence = 0;
  private secrets: Set<string>;

  constructor(
    readonly config: ConnectionConfig,
    private io: ManualIO,
  ) {
    this.secrets = new Set([config.apiKey, ...(config.secrets ?? [])].filter(Boolean));
  }

  /** Register secrets before sending them so even echoed error bodies are redacted. */
  private remember(value: unknown, sensitive = false): void {
    if (typeof value === "string" && sensitive) this.secrets.add(value);
    else if (Array.isArray(value)) {
      for (const entry of value) this.remember(entry, sensitive);
    } else if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        this.remember(
          entry,
          sensitive || /^(authorization|api[-_]?key|clientSecret|password|cookie|headers|environment)$/i.test(key),
        );
      }
    }
  }

  /** Print protocol data while masking configured credentials wherever they appear. */
  print(label: string, value: unknown): void {
    let line = `${label} ${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`;
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length))
      line = line.split(secret).join("<redacted>");
    line = line.replace(/Bearer\s+[^\s"\\]+/gi, "Bearer <redacted>");
    this.io.write(line);
  }

  /** One visible protocol action; apply the configured pause and propagate failure without retries. */
  async step<T>(title: string, action: () => Promise<T>): Promise<T> {
    this.print(`\n[${++this.sequence}]`, title);
    try {
      const result = await action();
      this.print("\u001b[32m结果", "PASS\u001b[0m");
      return result;
    } catch (error) {
      this.print("结果 FAIL", error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      await this.io.pause();
    }
  }

  /** Send one HTTP request; print full JSON, multipart contents or SSE and check the contract. */
  async request(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<{ data: unknown; headers: Headers }> {
    return this.step(`${method} ${path}`, async () => {
      const headers = new Headers({ authorization: `Bearer ${this.config.apiKey}`, ...options.headers });
      let body: string | FormData | undefined;
      let printable = options.body;
      if (options.body instanceof FormData) {
        const entries = [];
        const values: [string, unknown][] = Array.from(options.body.entries());
        for (const [key, value] of values) {
          assert.ok(typeof value === "string" || value instanceof File, "无效 multipart 项");
          entries.push({
            key,
            value:
              typeof value === "string"
                ? value
                : {
                    name: value.name,
                    type: value.type,
                    size: value.size,
                    ...(value.type.startsWith("text/")
                      ? { text: await value.text() }
                      : { base64: Buffer.from(await value.arrayBuffer()).toString("base64") }),
                  },
          });
        }
        printable = entries;
        body = options.body;
      } else if (options.body !== undefined) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(options.body);
      }
      this.remember(options.body);
      this.print("输入", {
        url: new URL(path, this.config.baseUrl).href,
        method,
        headers: Object.fromEntries(headers),
        body: printable,
      });
      const response = await fetch(new URL(path, this.config.baseUrl), {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.config.timeoutMs),
        redirect: "error",
      });
      const responseHeaders = Object.fromEntries(response.headers);
      if (responseHeaders["set-cookie"]) responseHeaders["set-cookie"] = "<redacted>";
      this.print("输出", { status: response.status, headers: responseHeaders });
      let parsed: unknown;
      if (options.binary && response.ok) {
        assert.match(response.headers.get("content-type") ?? "", /application\/octet-stream/i);
        const bytes = new Uint8Array(await response.arrayBuffer());
        parsed = bytes;
        this.print("响应体", { size: bytes.byteLength, base64: Buffer.from(bytes).toString("base64") });
      } else if (options.stream && response.ok) {
        assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/i);
        parsed = await readChatStream(response, (frame) => this.print("SSE", frame));
        this.print("聚合回答", parsed);
      } else {
        const raw = await response.text();
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          this.print("响应体", raw);
          throw error;
        }
        this.print("响应体", parsed);
      }
      assert.equal(response.status, options.status ?? 200, "HTTP 状态不符");
      if (!options.native && !options.binary) {
        const wrapped = object(parsed);
        assert.equal(wrapped.success, true, `业务失败: ${JSON.stringify(wrapped.error)}`);
        assert.ok(Object.hasOwn(wrapped, "data"), "缺少 data 包装");
        parsed = wrapped.data;
      }
      options.check?.(parsed, response.headers);
      this.operations.add(operationName(method, path));
      return { data: parsed, headers: response.headers };
    });
  }
}
