/**
 * 上游契约探针的采集基建：类型、脱敏、HTTP 出口、探测登记与台账读写。
 *
 * 与 `probe-suites.ts`（接口套件）一起被入口 `../upstream-contract-probe.ts` 消费；按
 * 「采集基建 / 接口套件 / 编排与报表」拆分是为了守住单文件规模，接口使用方式见入口文件注释。
 */

import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_BASE_URL = "http://127.0.0.1:18080";
export const DEFAULT_STATE_PATH = join(tmpdir(), "fenix-workflow-v2-probe-state.json");
export const REQUEST_TIMEOUT_MS = 15_000;
/** 单个响应体在快照里保留的最大字符数；超出部分截断，避免基线文件被大响应撑爆。 */
const MAX_BODY_CHARS = 4_000;
const MAX_RESPONSE_SHAPE_KEYS = 14;

export type ProbeOutcome = "ok" | "fail" | "skipped";

/** 一次接口探测的采集结果；字段与快照文档的表格列一一对应。 */
export interface ProbeRecord {
  id: string;
  group: string;
  title: string;
  method: "GET" | "POST";
  path: string;
  /** 已脱敏的请求体 / 查询参数。 */
  request: unknown;
  httpStatus: number | null;
  businessCode: number | null;
  msg: string | null;
  outcome: ProbeOutcome;
  durationMs: number;
  /** 成功响应的关键字段形状（键路径 + 类型），供文档「成功响应关键字段」列使用。 */
  shape: string | null;
  note: string | null;
}

export interface ProbeResponse {
  httpStatus: number;
  json: unknown;
  businessCode: number | null;
  msg: string | null;
  bodyText: string;
  setCookieTokens: string[];
}

/** 一次探测的返回值：登记项之外保留原始响应，供调用方提取探针资源 ID。 */
export interface ProbeRun {
  record: ProbeRecord;
  response: ProbeResponse | null;
}

export interface ProbeSpec {
  id: string;
  group: string;
  title: string;
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /** 显式 `Cookie` 头；`null` 表示不带凭据（用于认证形态探测）。 */
  sessionKey?: string | null;
  /**
   * `error-shape`：该探测的目的就是采集失败形态（如缺凭据、缺必填参数），
   * 非 2xx 或非 0 业务码视为**符合预期**，不计入失败清单。
   */
  expectation?: "success" | "error-shape";
  note?: string;
}

/** 探针资源台账；上游没有「按空间列 App」的接口，复用只能靠它定位。 */
export interface ProbeState {
  baseUrl: string;
  email: string;
  spaceId: string;
  appId: string;
  workflowId: string;
  updatedAt: string;
}

/** 跨探测共享的运行上下文。 */
export interface RunContext {
  baseUrl: string;
  email: string;
  sessionKey: string | null;
  spaceId: string;
  appId: string;
  workflowId: string;
  executeId: string | null;
  records: ProbeRecord[];
}

const SECRET_KEY_PATTERN =
  /(^|[^a-z0-9])(session_key|password|passwd|token|secret|signature|authorization|cookie|ticket)([^a-z0-9]|$)/i;
const SIGNED_URL_PATTERN = /https?:\/\/[^\s"'\\]+/g;
const STACK_TRACE_MARKER = "\nstack: goroutine";

/** 密钥类字段统一替换；保留字段名与结构，便于人工核对契约是否变化。 */
function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/** 脱敏字符串值：签名 URL 查询串、内联会话键、Go 堆栈（含本机路径）全部替换为占位符。 */
export function redactString(value: string): string {
  const stackIndex = value.indexOf(STACK_TRACE_MARKER);
  const withoutStack = stackIndex >= 0 ? `${value.slice(0, stackIndex)}<stack-trace-truncated>` : value;
  const withoutSession = withoutStack.replace(/(session_key=)[^;,\s"\\]+/g, "$1<redacted>");
  return withoutSession.replace(SIGNED_URL_PATTERN, (raw) => {
    const queryIndex = raw.indexOf("?");
    return queryIndex < 0 ? raw : `${raw.slice(0, queryIndex)}?<redacted>`;
  });
}

/** 递归脱敏任意 JSON 值。 */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = isSecretKey(key) ? "<redacted>" : redactValue(item);
    }
    return result;
  }
  return value;
}

/**
 * 归纳 JSON 形状：`data{workflow_list:[{workflow_id:string,...}]}` —— 只保留键路径与类型，
 * 不保留具体值（ID 之类会随环境漂移，写进基线只会产生噪音）。
 */
export function describeShape(value: unknown, depth = 2): string {
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `[${describeShape(value[0], depth)}]`;
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  if (depth === 0) return "{...}";
  const entries = Object.entries(value as Record<string, unknown>);
  const shown = entries
    .slice(0, MAX_RESPONSE_SHAPE_KEYS)
    .map(([key, item]) => `${key}:${describeShape(item, depth - 1)}`);
  return `{${shown.join(",")}${entries.length > MAX_RESPONSE_SHAPE_KEYS ? ",..." : ""}}`;
}

function parseCookies(setCookieHeaders: string[]): string[] {
  const tokens: string[] = [];
  for (const header of setCookieHeaders) {
    const match = /(?:^|,\s*)session_key=([^;,\s]+)/.exec(header);
    if (match?.[1]) tokens.push(match[1]);
  }
  return tokens;
}

/**
 * 统一请求出口：解析 `Set-Cookie`、捕获 HTTP 状态与业务码。
 * 上游的 `Set-Cookie` 里 `domain` 带端口（非法 domain，cookie jar 一律拒收），
 * 所以这里手工取 token、由调用方用显式 `Cookie` 头回传，全程不依赖 cookie jar。
 */
export async function sendRequest(
  spec: Pick<ProbeSpec, "method" | "path" | "query" | "body" | "sessionKey">,
  baseUrl: string,
): Promise<ProbeResponse> {
  const url = new URL(spec.path, baseUrl);
  for (const [key, value] of Object.entries(spec.query ?? {})) url.searchParams.set(key, value);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (spec.sessionKey) headers.Cookie = `session_key=${spec.sessionKey}`;
  const response = await fetch(url, {
    method: spec.method,
    headers,
    body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const bodyText = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    // 非 JSON 响应（如网关对 panic 返回的纯文本 `code=... message=...`）保持原样。
    json = undefined;
  }
  const envelope = json !== null && typeof json === "object" ? (json as Record<string, unknown>) : undefined;
  const rawCode = envelope?.code;
  const setCookieHeaders =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie") ?? ""];
  return {
    httpStatus: response.status,
    json,
    businessCode: typeof rawCode === "number" ? rawCode : null,
    msg: typeof envelope?.msg === "string" ? envelope.msg : null,
    bodyText: bodyText.slice(0, MAX_BODY_CHARS),
    setCookieTokens: parseCookies(setCookieHeaders),
  };
}

/** 执行单个探测并按脱敏后的结果登记；未显式给出 `sessionKey` 时默认带上探针会话。 */
export async function probe(context: RunContext, spec: ProbeSpec): Promise<ProbeRun> {
  const startedAt = Date.now();
  const resolved: ProbeSpec = {
    ...spec,
    sessionKey: spec.sessionKey === undefined ? context.sessionKey : spec.sessionKey,
  };
  const request = redactValue({
    ...(resolved.query ? { query: resolved.query } : {}),
    ...(resolved.body === undefined ? {} : { body: resolved.body }),
  });
  let response: ProbeResponse;
  try {
    response = await sendRequest(resolved, context.baseUrl);
  } catch (error) {
    const record: ProbeRecord = {
      id: spec.id,
      group: spec.group,
      title: spec.title,
      method: spec.method,
      path: spec.path,
      request,
      httpStatus: null,
      businessCode: null,
      msg: null,
      outcome: "fail",
      durationMs: Date.now() - startedAt,
      shape: null,
      note: `请求未完成：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    };
    context.records.push(record);
    return { record, response: null };
  }

  const envelopeOk = response.httpStatus < 400 && (response.businessCode === null || response.businessCode === 0);
  const outcome: ProbeOutcome =
    spec.expectation === "error-shape" ? (envelopeOk ? "fail" : "ok") : envelopeOk ? "ok" : "fail";
  // 只有「非标准包体」才回落到原文（如网关对 panic 返回的纯文本 `code=... message=...`），
  // 正常响应一律用 `msg`，避免把整个响应体塞进摘要。
  const message = response.msg ?? (response.businessCode === null ? response.bodyText.slice(0, 200) : null);
  const record: ProbeRecord = {
    id: resolved.id,
    group: resolved.group,
    title: resolved.title,
    method: resolved.method,
    path: resolved.path,
    request,
    httpStatus: response.httpStatus,
    businessCode: response.businessCode,
    msg: message === null ? null : redactString(message),
    outcome,
    durationMs: Date.now() - startedAt,
    shape: envelopeOk && response.json !== undefined ? describeShape(response.json) : null,
    note: spec.note ?? (spec.expectation === "error-shape" && outcome === "ok" ? "预期失败样本" : null),
  };
  context.records.push(record);
  return { record, response };
}

/** 从响应中按路径取值，路径任一层缺失即返回 undefined。 */
export function pick(json: unknown, keys: string[]): unknown {
  let current: unknown = json;
  for (const key of keys) {
    if (current === null || typeof current !== "object") return;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseArgs(argv: string[]): { json: boolean; outPath: string | null; statePath: string } {
  let json = false;
  let outPath: string | null = null;
  let statePath = DEFAULT_STATE_PATH;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") json = true;
    else if (arg === "--out") outPath = argv[++index] ?? null;
    else if (arg === "--state") statePath = argv[++index] ?? DEFAULT_STATE_PATH;
    else {
      console.error(`未知参数：${arg}`);
      process.exit(1);
    }
  }
  if (argv.includes("--out") && outPath === null) {
    console.error("--out 需要给出文件路径");
    process.exit(1);
  }
  return { json, outPath, statePath };
}

export async function loadState(path: string): Promise<ProbeState | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const state = parsed as Partial<ProbeState>;
    if (!state.baseUrl || !state.email || !state.spaceId || !state.appId || !state.workflowId) return null;
    return state as ProbeState;
  } catch {
    // 台账缺失或损坏只意味着「需要重新建资源」，不是错误。
    return null;
  }
}

export async function saveState(path: string, state: ProbeState): Promise<void> {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** 探测声明的可选字段；`sessionKey` 缺省即用运行上下文里的探针会话。 */
export interface ProbeOptions {
  query?: Record<string, string>;
  body?: unknown;
  sessionKey?: string | null;
  expectation?: "success" | "error-shape";
  note?: string;
}

/** POST 探测的紧凑声明（`probe()` 之外只关心标题、路径与载荷）。 */
export function post(id: string, group: string, title: string, path: string, options: ProbeOptions = {}): ProbeSpec {
  return { id, group, title, method: "POST", path, ...options };
}

/** GET 探测的紧凑声明；上游的 GET 接口一律走 query。 */
export function get(id: string, group: string, title: string, path: string, options: ProbeOptions = {}): ProbeSpec {
  return { id, group, title, method: "GET", path, ...options };
}
