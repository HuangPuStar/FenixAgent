/**
 * 画布反代的传输层：`/workflow-canvas/*` 静态资产与 `/workflow-canvas/storage/*` 存储域
 * （冻结 [§2.1.1](../../../../../../docs/design/2026-09-29-workflow-v2-interface-freeze.md) 与 §6.1）。
 *
 * 为什么独立于路由文件：`routes/canvas/static-proxy.ts` 只保留 Elysia 的协议适配（挂载前缀、路径形状、
 * 方法门），路径映射、出站会话注入、响应头白名单与 SPA 回退都是可独立单测的传输逻辑，两者混写会同时
 * 超出单文件职责与可读性。代理实例按构造持有「存储域 origin」这一份状态，路由工厂每构造一次即一份干净
 * 状态（生产只在装配期构造一次）。
 *
 * 三条不变量：
 * 1. **出站注入平台会话**：上游除 `/`、`/static`、`/sign`、`/favicon.png` 等白名单外全站经 session
 *    中间件，不带 cookie 请求 `/workflow-canvas/*` 连 JS 资源都 401（实测见设计 §9.1.1 第 2 条）。
 *    每个上游请求经 `UpstreamSession.ensureCookie()` 取会话；上游判定失效（HTTP 401 或业务码 700012006）时
 *    invalidate + 单飞重登 + **重放一次**，仍失败即 502 降级——与 `upstream-client` 同一套口径，不做无边界重试。
 * 2. **入站剥离会话材料**：上游 `Set-Cookie` 绝不到浏览器。响应头按**白名单复制**（不是复制全部再删几个），
 *    `Set-Cookie`、`X-Frame-Options` 与 hop-by-hop 头因此天然落在转发集合之外。
 * 3. **存储域是另一个系统**：预签名直链自带鉴权，所以只允许 GET/HEAD，且**不带**平台会话——把上游的
 *    `session_key` 发给对象存储等于把凭据送出本模块的信任边界。
 */

import { createLogger } from "@fenix/logger";
import { getWorkflowV2Config } from "../config";
import { callUpstream, UPSTREAM_AUTH_FAILED_CODE } from "./upstream-client";
import { getUpstreamSession, UpstreamSessionUnavailableError } from "./upstream-session";

const logger = createLogger("wf-v2-canvas-proxy");

/** `/workflow-canvas/bff/*` 的路径段：属 1D 的透传面，本面必须放行而不是代它出站（冻结 §2.1）。 */
export const CANVAS_BFF_SEGMENT = "bff";
/** `/workflow-canvas/storage/*` 的路径段：存储域反代（冻结 §6.1）。 */
export const CANVAS_STORAGE_SEGMENT = "storage";

/**
 * 画布响应注入的 CSP（设计 §5.3）。
 *
 * 取 `'self'` 而不是「请求 Host 推导出的 origin」：同源反代下响应自身的 origin 就是控制台 origin，浏览器
 * 按它判定；而 Host 由客户端提供，用它放宽 `frame-ancestors` 等于让伪造 Host 的请求替我们改安全策略。
 */
const CANVAS_CSP = "frame-ancestors 'self'; frame-src 'self'";

/** 会话失效响应是小 JSON；超过这个体积的 JSON 是资产（语言包等），不为判码整段缓冲。 */
const JSON_INSPECT_MAX_BYTES = 64 * 1024;

/** 存储域解析失败后的静默窗口：无凭据的浏览器请求不该把发现调用放大成对上游的洪泛。 */
const STORAGE_DISCOVERY_BACKOFF_MS = 5_000;

/** 签名 URL 的取样对象：上游自带的默认工作流图标（契约快照 §9.1 第 8 条实测返回 `code:0`）。 */
const STORAGE_PROBE_URI = "default_icon/default_workflow_icon.png";

/** 取签名 URL 的上游端点；它返回的直链 origin 即对象存储的对外地址。 */
const SIGN_IMAGE_URL_PATH = "/api/workflow_api/sign_image_url";

/**
 * 转发给浏览器的上游响应头白名单。
 *
 * 白名单而非黑名单：`Set-Cookie`（会话材料）、`X-Frame-Options`（会拒绝被 iframe 嵌入）、
 * `Transfer-Encoding` / `Connection` 等 hop-by-hop 头都因此天然落在集合外，不必逐个补 `delete`。
 *
 * `Content-Encoding` **不在**名单里：Bun 的 fetch 已按它解压 body（实测 `content-length` 与
 * `content-encoding` 仍保留压缩表示的旧值），转发该标记会让浏览器对已解压的字节再解压一次。
 */
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "cache-control",
  "etag",
  "last-modified",
  "expires",
  "vary",
  "content-disposition",
  "content-language",
] as const;

/** 命中即不参与 SPA 回退的路径前缀：这些目录下装的都是资产，返回 index.html 比 404 更难排查。 */
const STATIC_SEGMENT_PREFIXES = new Set(["static", "assets", "locales", "images", "fonts"]);

/** 同上，按扩展名判定（上游的入口引用 `/favicon.png` 这类根级文件）。 */
const STATIC_FILE_EXTENSIONS = new Set(
  (
    ".js .mjs .cjs .css .map .json .txt .wasm .webmanifest .png .jpg .jpeg .gif .svg .ico .webp .avif .bmp " +
    ".woff .woff2 .ttf .otf .eot .mp4 .webm .mp3"
  ).split(" "),
);

/** 解析后的画布子路径：段已解码、校验通过，编码回写由 `buildUpstreamUrl` 负责。 */
interface CanvasPath {
  /** 解码并校验后的路径段；空数组表示挂载根路径。 */
  segments: string[];
  /** 原路径以 `/` 结尾（目录式请求，需原样回写，否则上游会 301 重定向）。 */
  trailingSlash: boolean;
}

/** 只读方法：本面只服务静态资产，写通道是 `/workflow-canvas/bff/*`（冻结 §6）。 */
function normalizeReadMethod(method: string): "GET" | "HEAD" | null {
  const upper = method.toUpperCase();
  if (upper === "GET") return "GET";
  if (upper === "HEAD") return "HEAD";
  return null;
}

/** 单段合法性：`.`、`..`、空段、路径分隔符与控制字符一律拒绝（`%2F` 解码后会变成段内分隔符）。 */
function isSafeSegment(segment: string): boolean {
  if (segment === "" || segment === "." || segment === "..") return false;
  for (const ch of segment) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
    if (ch === "/" || ch === "\\") return false;
  }
  return true;
}

/**
 * 把去掉挂载前缀后的请求路径解析为可安全拼接的段；返回 `null` 表示必须拒绝。
 *
 * Elysia 通配参数是**未解码**的原文（1.4.28 实测 `params["*"] === "..%2F..%2Fadmin"`），这里手工解码
 * 一次再逐段校验：解码后才看得见 `%2e%2e` 这类伪装，校验通过后再由 `encodeURIComponent` 回写，送进 URL 的
 * `.` 只可能是数据而不是路径语义。非法百分号转义（裸 `%`）无法判断原始意图，同样拒绝。
 */
function parseCanvasPath(remainder: string): CanvasPath | null {
  if (remainder === "") return { segments: [], trailingSlash: false };
  let decoded: string;
  try {
    decoded = decodeURIComponent(remainder);
  } catch {
    return null;
  }
  const trailingSlash = decoded.endsWith("/");
  const rawSegments = decoded.split("/");
  const segments = trailingSlash ? rawSegments.slice(0, -1) : rawSegments;
  if (segments.length === 0 || !segments.every(isSafeSegment)) return null;
  return { segments, trailingSlash };
}

/**
 * 拼接上游 URL：基址去尾斜杠，段重新编码，查询串原样带过（`?workflow_id=..&space_id=..` 是画布入口参数）。
 *
 * 返回 `null` 即拒绝：即使将来有人改回字符串拼接，前缀校验也会拦下越界的转发目标。
 */
function buildUpstreamUrl(baseUrl: string, path: CanvasPath, search: string): URL | null {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const encodedPath = path.segments.map(encodeURIComponent).join("/");
  const suffix = path.trailingSlash && encodedPath.length > 0 ? "/" : "";
  const target = new URL(`${basePath}/${encodedPath}${suffix}${search}`, base);
  if (target.origin !== base.origin || !target.pathname.startsWith(`${basePath}/`)) return null;
  return target;
}

/** 静态资源判定：命中即不参与 SPA 回退（把 index.html 当 JS 回给浏览器会变成难排查的语法错误）。 */
function isStaticAssetPath(path: CanvasPath): boolean {
  const first = path.segments[0];
  if (first !== undefined && STATIC_SEGMENT_PREFIXES.has(first)) return true;
  const last = path.segments[path.segments.length - 1] ?? "";
  const dot = last.lastIndexOf(".");
  return dot > 0 && STATIC_FILE_EXTENSIONS.has(last.slice(dot).toLowerCase());
}

/**
 * 本面自己的错误响应：上游信封形状（画布侧按 `{code,msg}` 解析），文案只描述本面状态，不含上游细节。
 */
function canvasErrorResponse(status: number, msg: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ code: status, msg }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/** 405：静态反代只读；`Allow` 是给浏览器与调试者的显式信号（写请求走 bff 面）。 */
function methodNotAllowedResponse(): Response {
  return canvasErrorResponse(405, "method not allowed", { allow: "GET, HEAD" });
}

/**
 * 按白名单复制上游响应头并注入 CSP；body 以**流**原样透传（上游的 chunked / SSE 不能被我们缓冲成整块）。
 *
 * `content-encoding` 存在说明 Bun 的 fetch 已解压 body，此时压缩表示下的 `content-length` 已失真，必须丢弃。
 */
function buildProxyResponse(upstream: Response, status: number = upstream.status): Response {
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (upstream.headers.has("content-encoding")) headers.delete("content-length");
  headers.set("content-security-policy", CANVAS_CSP);
  return new Response(upstream.body, { status, statusText: upstream.statusText, headers });
}

/** 改写已成型响应的状态码（body 与头不变）；只服务 SPA 回退把上游根文档统一成 200。 */
function withStatus(response: Response, status: number): Response {
  return new Response(response.body, { status, statusText: "", headers: response.headers });
}

/** 出站失败的种类；三种的对外状态码不同（超时 504、上游不可达 502、客户端断连 499）。 */
type TransportFailure = "timeout" | "network" | "aborted";

/** 一次出站请求的结果：成功给上游响应，失败给可区分的传输原因。 */
type TransportResult = { ok: true; response: Response } | { ok: false; reason: TransportFailure };

/**
 * 发送一次上游请求。
 *
 * 超时只覆盖「响应头到达」：body 是流，固定预算会截断慢链路上的大 bundle（素材最重的就是 JS），客户端断连
 * 则由 `request.signal` 传递，上游请求随之取消。`accept-encoding: identity` 是为了避开「fetch 已解压但
 * 压缩头仍被保留」的坑（见白名单注释），代价只是内网多传未压缩字节。
 */
async function sendRequest(input: {
  url: URL;
  method: string;
  /** 出站 `Cookie` 头；存储域为 `null`（另一个系统，不发平台凭据）。 */
  cookieHeader: string | null;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<TransportResult> {
  const controller = new AbortController();
  const abortByClient = () => controller.abort();
  if (input.signal.aborted) abortByClient();
  else input.signal.addEventListener("abort", abortByClient, { once: true });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs);

  try {
    const response = await fetch(input.url, {
      method: input.method,
      headers: {
        ...(input.cookieHeader === null ? {} : { Cookie: input.cookieHeader }),
        "accept-encoding": "identity",
      },
      signal: controller.signal,
    });
    return { ok: true, response };
  } catch (error) {
    if (input.signal.aborted) return { ok: false, reason: "aborted" };
    if (timedOut) return { ok: false, reason: "timeout" };
    logger.warn("画布反代出站失败", {
      path: input.url.pathname,
      error: error instanceof Error ? error.name : "unknown",
    });
    return { ok: false, reason: "network" };
  } finally {
    // 只清超时定时器：abort 监听保留到请求结束，body 仍在流式读取时客户端断连要能取消上游。
    clearTimeout(timer);
  }
}

/** JSON 解析失败返回 null：判码只需要「是不是那个业务码」。 */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** 业务码读取：只认数字（上游返回 number），`"0"` 之类的字符串不算。 */
function readBusinessCode(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
  const code = (payload as Record<string, unknown>).code;
  return typeof code === "number" ? code : undefined;
}

/**
 * 会话失效判定：HTTP 401（完全没带 Cookie）或业务码 700012006（键非法/被踢/过期），与 `upstream-client` 同口径。
 *
 * 静态面的难点是响应体是流：为判码整段缓冲会毁掉流式透传，而会话失效的响应恰好是 `application/json`
 * 的小 JSON（实测 `{"code":700012006,...}`），因此只对 JSON 且声明长度不大的响应读体，其余直接透传。
 * 读过的 body 用原文重建响应，返回给调用方时与未读时等价。
 */
async function inspectAuthFailure(response: Response): Promise<{ failed: boolean; response: Response }> {
  if (response.status === 401) {
    await response.body?.cancel();
    return { failed: true, response };
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return { failed: false, response };
  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > JSON_INSPECT_MAX_BYTES) {
    return { failed: false, response };
  }
  const text = await response.text();
  const rebuilt = new Response(text, { status: response.status, headers: response.headers });
  return { failed: readBusinessCode(safeJson(text)) === UPSTREAM_AUTH_FAILED_CODE, response: rebuilt };
}

/** 传输失败的对外映射：客户端断连不算错误（499），超时与上游不可达给出可区分的状态码。 */
function transportFailureResponse(reason: TransportFailure, url: URL): Response {
  if (reason === "aborted") return new Response(null, { status: 499 });
  logger.warn("画布反代上游不可达", { path: url.pathname, reason });
  return canvasErrorResponse(reason === "timeout" ? 504 : 502, "画布上游不可达");
}

/**
 * 带上平台会话请求上游，并在会话失效时重登重放一次。
 *
 * 重放只发生一次：重登后仍被判定失效，说明问题不在会话（账号被外部踢键或上游异常），此时返回 502 让
 * 控制台按「画布不可用」降级，绝不循环重登（上游是单会话账号，重登风暴会互相踢键）。
 */
async function fetchCanvasResponse(input: {
  url: URL;
  method: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<Response> {
  const session = getUpstreamSession();

  const first = await sendRequest({ ...input, cookieHeader: await session.ensureCookie() });
  if (!first.ok) return transportFailureResponse(first.reason, input.url);
  const inspected = await inspectAuthFailure(first.response);
  if (!inspected.failed) return buildProxyResponse(inspected.response);

  logger.warn("画布反代判定上游会话失效，重登后重放一次", {
    path: input.url.pathname,
    status: inspected.response.status,
  });
  session.invalidate();

  const replay = await sendRequest({ ...input, cookieHeader: await session.ensureCookie() });
  if (!replay.ok) return transportFailureResponse(replay.reason, input.url);
  const replayed = await inspectAuthFailure(replay.response);
  if (replayed.failed) {
    logger.error("重登后仍被判会话失效，画布反代降级", { path: input.url.pathname });
    return canvasErrorResponse(502, "画布上游会话不可用");
  }
  return buildProxyResponse(replayed.response);
}

/**
 * 从 `sign_image_url` 的响应里取存储域 origin。
 *
 * `url` 在**顶层**：该端点的响应是上游的扁平 thrift 结构（`{"url":"http://127.0.0.1:9000/...","code":0}`，
 * 实测），不带 `workflow_api` 常见的 `data` 包装。只留 origin：签名查询串是短时凭据，不留在内存、更不进日志。
 */
function readStorageOrigin(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const url = (payload as Record<string, unknown>).url;
  if (typeof url !== "string" || url.length === 0) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** 画布反代实例：两个入口都按构造时刻的模块配置出站，存储域解析结果按实例记忆。 */
export interface CanvasUpstreamProxy {
  /** `/workflow-canvas/<rest>`：静态资产（含 SPA 回退）；`rest` 为去掉挂载前缀后的未解码路径。 */
  proxyAsset(request: Request, rest: string): Promise<Response>;
  /** `/workflow-canvas/storage/<rest>`：对象存储预签名直链，仅 GET/HEAD。 */
  proxyStorage(request: Request, rest: string): Promise<Response>;
}

/** 创建画布反代实例；无装配期副作用，首次存储域请求才向上游取签名 URL。 */
export function createCanvasUpstreamProxy(): CanvasUpstreamProxy {
  let storageOrigin: string | null = null;
  let discoveryInFlight: Promise<string | null> | null = null;
  let discoveryFailedAtMs = 0;

  /**
   * 解析存储域 origin：向上游要一张签名 URL，取它的 origin。
   *
   * 为什么不新增环境变量：冻结 §2.2 的键集已定，且该 origin 由上游自己的对象存储配置决定（部署面可能换
   * 端口或域名），从**出链来源**处取比再拉一个配置键更不容易漂移。移除条件：上游支持配置对外存储域，或
   * 部署面给出存储基址配置键时，本段发现逻辑连同下面的取样对象一并删除。
   */
  async function discoverStorageOrigin(): Promise<string | null> {
    try {
      const result = await callUpstream({ path: SIGN_IMAGE_URL_PATH, body: { uri: STORAGE_PROBE_URI } });
      const origin = result.status === 200 ? readStorageOrigin(result.body) : null;
      if (origin === null) {
        discoveryFailedAtMs = Date.now();
        logger.warn("画布存储域解析失败", {
          status: result.status,
          code: readBusinessCode(result.body),
        });
        return null;
      }
      storageOrigin = origin;
      logger.info("画布存储域已解析", { origin });
      return origin;
    } catch (error) {
      discoveryFailedAtMs = Date.now();
      logger.warn("画布存储域解析出错", { error: error instanceof Error ? error.name : "unknown" });
      return null;
    }
  }

  /** 取存储域 origin；并发请求共享一次发现，失败后短退避（避免无凭据请求放大成上游洪泛）。 */
  async function resolveStorageOrigin(): Promise<string | null> {
    if (storageOrigin !== null) return storageOrigin;
    if (Date.now() - discoveryFailedAtMs < STORAGE_DISCOVERY_BACKOFF_MS) return null;
    if (discoveryInFlight === null) {
      const attempt: Promise<string | null> = discoverStorageOrigin().finally(() => {
        if (discoveryInFlight === attempt) discoveryInFlight = null;
      });
      discoveryInFlight = attempt;
    }
    return discoveryInFlight;
  }

  /** 静态资产面：根路径、深链与资源都走这里，404 时按是否静态资源决定 SPA 回退。 */
  async function proxyAsset(request: Request, rest: string): Promise<Response> {
    const path = parseCanvasPath(rest);
    // 第二道保险（路由 handler 已用同一常量判过）：`/workflow-canvas/bff/*` 属透传面，绝不能转给上游——
    // 那会把 API 请求变成 SPA 的 index.html，票据链路被静默绕过。
    if (path !== null && path.segments[0] === CANVAS_BFF_SEGMENT) return canvasErrorResponse(404, "not found");
    if (path === null) {
      // 被拒路径是不可信输入：不回显也不进日志（回显会变成探测面，写日志等于日志注入面）。
      return canvasErrorResponse(400, "invalid path");
    }
    const method = normalizeReadMethod(request.method);
    if (method === null) return methodNotAllowedResponse();

    const config = getWorkflowV2Config();
    const search = new URL(request.url).search;
    try {
      const target = buildUpstreamUrl(config.canvasUpstreamUrl, path, search);
      if (target === null) return canvasErrorResponse(400, "invalid path");
      const response = await fetchCanvasResponse({
        url: target,
        method,
        timeoutMs: config.upstreamTimeoutMs,
        signal: request.signal,
      });
      if (response.status !== 404 || isStaticAssetPath(path)) return response;

      // SPA 回退：深链与刷新请求的上游 404 用根文档兜底，状态统一成 200——否则画布每次刷新都是 404 页。
      const fallbackTarget = buildUpstreamUrl(config.canvasUpstreamUrl, { segments: [], trailingSlash: true }, "");
      if (fallbackTarget === null) return response;
      const fallback = await fetchCanvasResponse({
        url: fallbackTarget,
        method,
        timeoutMs: config.upstreamTimeoutMs,
        signal: request.signal,
      });
      // 兜底也非 2xx 时保留原始 404：上游故障的诊断价值高于「看起来像成功了」。
      return fallback.status === 200 ? withStatus(fallback, 200) : response;
    } catch (error) {
      return mapProxyFailure(error);
    }
  }

  /** 存储域面：GET/HEAD 到发现的存储 origin，不带平台会话。 */
  async function proxyStorage(request: Request, rest: string): Promise<Response> {
    const method = normalizeReadMethod(request.method);
    if (method === null) return methodNotAllowedResponse();
    const path = parseCanvasPath(rest);
    if (path === null || path.segments.length === 0) return canvasErrorResponse(400, "invalid path");

    const origin = await resolveStorageOrigin();
    if (origin === null) return canvasErrorResponse(502, "画布存储域不可用");

    const config = getWorkflowV2Config();
    try {
      const target = buildUpstreamUrl(origin, path, new URL(request.url).search);
      if (target === null) return canvasErrorResponse(400, "invalid path");
      const result = await sendRequest({
        url: target,
        method,
        cookieHeader: null,
        timeoutMs: config.upstreamTimeoutMs,
        signal: request.signal,
      });
      return result.ok ? buildProxyResponse(result.response) : transportFailureResponse(result.reason, target);
    } catch (error) {
      return mapProxyFailure(error);
    }
  }

  return { proxyAsset, proxyStorage };
}

/** 兜底错误映射：会话不可用是可预期降级，其余按上游故障记录，对外只给状态码与固定文案。 */
function mapProxyFailure(error: unknown): Response {
  if (error instanceof UpstreamSessionUnavailableError) {
    logger.warn("画布反代降级：平台会话不可用", { reason: error.reason });
    return canvasErrorResponse(502, "画布上游会话不可用");
  }
  logger.error("画布反代请求失败", { error: error instanceof Error ? error.name : "unknown" });
  return canvasErrorResponse(502, "画布上游不可达");
}
