import Elysia from "elysia";
import { telemetryDiagnostic } from "./index";

/** 浏览器公开入口不接收压缩，避免压缩炸弹绕过 1MiB 解码后预算。 */
export const MAX_OTLP_BODY_BYTES = 1024 * 1024;
const MAX_CLIENTS = 4096;
const MAX_INFLIGHT = 8;

/** 流式计量，不能信任 Content-Length；超限即取消读取。 */
export async function readBoundedBody(
  request: Request,
  limit = MAX_OTLP_BODY_BYTES,
  signal = request.signal,
): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(part.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** 只接受单公开 origin；localhost/非法/缺失均不能作为生产浏览器遥测信任源。 */
export function inspectPublicOrigin(value?: string): {
  origin?: string;
  issue?: "missing" | "invalid" | "localhost";
} {
  const raw = value?.trim();
  if (!raw) return { issue: "missing" };
  try {
    const parsed = new URL(raw);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      return { issue: "invalid" };
    if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase()))
      return { issue: "localhost" };
    return { origin: parsed.origin };
  } catch {
    return { issue: "invalid" };
  }
}

/** 固定路由、认证、全局背压和逐用户有界速率账本；绝不接受客户端提供的上游地址或凭据。 */
export function createOtelProxy(options: {
  endpoint?: string;
  /** 公开站点基址；反代终止 TLS 时用它的 origin 校验浏览器 Origin。 */
  publicBaseUrl?: string;
  /** 启用浏览器遥测的生产入口必须显式配置公开 origin；缺失时拒绝全部请求。 */
  requireConfiguredOrigin?: boolean;
  /** 每窗口用户槽位上限；默认 4096，测试可注入小值验证回收。 */
  maxClients?: number;
  authenticate: (request: Request) => Promise<string | null>;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}) {
  const maxClients = options.maxClients ?? MAX_CLIENTS;
  const clients = new Map<string, { start: number; count: number; inflight: number }>();
  const now = options.now ?? Date.now;
  const publicOrigin = inspectPublicOrigin(options.publicBaseUrl);
  let inflight = 0;
  let windowStart = 0;
  let globalCount = 0;
  const rollWindow = (time: number): void => {
    if (time - windowStart < 60_000) return;
    windowStart = time;
    globalCount = 0;
    // 空闲用户随窗口释放槽位；在飞请求跨窗口仍保留并发额度，只重置速率计数。
    for (const [id, bucket] of clients) {
      if (bucket.inflight === 0) clients.delete(id);
      else {
        bucket.start = time;
        bucket.count = 0;
      }
    }
  };
  const expectedOrigin = (request: Request): string | undefined => {
    if (publicOrigin.origin) return publicOrigin.origin;
    if (options.requireConfiguredOrigin || publicOrigin.issue !== "missing") return;
    return new URL(request.url).origin;
  };
  const handle = async (request: Request) => {
    if (!options.endpoint) return new Response(null, { status: 404 });
    const time = now();
    rollWindow(time);
    if (++globalCount > 6000 || inflight >= MAX_INFLIGHT)
      return new Response(null, { status: 429, headers: { "Retry-After": "60" } });
    inflight++;
    let userBucket: { start: number; count: number; inflight: number } | undefined;
    let userKey: string | undefined;
    try {
      const origin = request.headers.get("origin");
      if (!origin || origin !== expectedOrigin(request)) return new Response(null, { status: 403 });
      if (
        request.headers.get("content-type")?.split(";")[0] !== "application/x-protobuf" ||
        (request.headers.get("content-encoding") ?? "identity") !== "identity"
      )
        return new Response(null, { status: 415 });
      if (Number(request.headers.get("content-length")) > MAX_OTLP_BODY_BYTES)
        return new Response(null, { status: 413 });
      const id = await options.authenticate(request);
      if (!id) return new Response(null, { status: 401 });
      const bucket = clients.get(id) ?? { start: time, count: 0, inflight: 0 };
      if (!clients.has(id) && clients.size >= maxClients) return new Response(null, { status: 429 });
      clients.set(id, bucket);
      if (++bucket.count > 60 || bucket.inflight >= 2)
        return new Response(null, { status: 429, headers: { "Retry-After": "60" } });
      bucket.inflight++;
      userBucket = bucket;
      userKey = id;
      const bodySignal = AbortSignal.any([request.signal, AbortSignal.timeout(3000)]);
      const body = await readBoundedBody(request, MAX_OTLP_BODY_BYTES, bodySignal);
      if (body === null) return new Response(null, { status: 413 });
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(3000)]);
      const path = new URL(request.url).pathname.slice("/otel".length);
      const upstream = await (options.fetch ?? globalThis.fetch)(`${options.endpoint.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-protobuf" },
        body: new Uint8Array(body).buffer,
        signal,
        redirect: "error",
      });
      const response = await readBoundedBody(
        new Request(request.url, { method: "POST", body: upstream.body, duplex: "half" }),
        64 * 1024,
        signal,
      );
      if (response === null) return new Response(null, { status: 502 });
      return new Response(new Uint8Array(response).buffer, {
        status: upstream.status,
        headers: { "Content-Type": "application/x-protobuf" },
      });
    } catch {
      // 导出失败不回显上游地址、凭据或输入，只影响当前遥测批次。
      telemetryDiagnostic("浏览器 OTLP 代理失败");
      return new Response(null, { status: 503 });
    } finally {
      inflight--;
      if (userBucket && userKey) {
        userBucket.inflight--;
        // 滚动后 count 被清零的在飞 bucket 在最后一个请求结束时立即回收，避免历史用户占槽。
        if (userBucket.inflight === 0 && userBucket.count === 0) clients.delete(userKey);
      }
    }
  };
  const app = new Elysia({ name: "otel-browser-proxy" });
  for (const signal of ["logs", "metrics", "traces"]) {
    app.post(`/otel/v1/${signal}`, ({ request }) => handle(request), { parse: "none", detail: { hide: true } });
  }
  return app;
}
