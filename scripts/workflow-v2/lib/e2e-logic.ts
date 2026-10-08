/**
 * 画布端到端联调（1J）的**纯逻辑**：配置解析、响应判读、伪造值扫描、schema 标记与脱敏。
 *
 * 为什么单独成模块：这些函数既不读环境也不碰网络，可以直接单测
 * （`scripts/__tests__/canvas-e2e-logic.test.ts`）；与它们相邻的 HTTP 出口在 `e2e-core.ts`，
 * 控制台链路与画布链路分别在 `e2e-console.ts` / `e2e-canvas.ts`。
 *
 * 脱敏有两套**互不替代**的规则：上游侧（签名 URL 查询串、`session_key`、Go 堆栈）复用探针的
 * `redactString`——同一份口径，避免两条链路各写一套；控制台侧（控制台会话 cookie、画布票据）由本文件
 * 的 `redactConsoleSecrets` 负责。任何要进报告或日志的文本都必须先过 `toEvidence`。
 */

import { redactString, redactValue } from "./probe-core";

// ── 配置 ──

export const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
export const DEFAULT_TIMEOUT_MS = 15_000;
/** 证据文本的字符上限：够定位问题，又不会把整份 schema 灌进终端。 */
export const EVIDENCE_MAX_CHARS = 400;

export interface E2eConfig {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  /** 控制台会话 cookie（浏览器里复制）；与 email/password 二选一。 */
  readonly sessionCookie: string | null;
  readonly email: string | null;
  readonly password: string | null;
  /** 组织 B（判据 C 的对照方）控制台账号；与 foreignWorkflowId 二选一。 */
  readonly foreignEmail: string | null;
  readonly foreignPassword: string | null;
  /** 组织 B 名下的上游 workflow ID；给了就不再登录组织 B。 */
  readonly foreignWorkflowId: string | null;
  /** 受测 workflow ID：给了就复用既有 workflow（不创建、不删除，编辑后写回还原）。 */
  readonly workflowId: string | null;
  /** 账号有多个组织时指定 active organization（经 `x-active-org-id` 下发）。 */
  readonly activeOrgId: string | null;
  /** 保留本次创建的临时资源（排障用；默认清理）。 */
  readonly keepResources: boolean;
  /** 组织未绑定时是否允许脚本自动绑定（默认允许；会为该组织在上游侧建一个 App）。 */
  readonly autoBind: boolean;
}

/** 一条前置条件：缺失时要打印的变量名与补法（只列名，绝不列值）。 */
export interface ConfigRequirement {
  readonly label: string;
  readonly variables: readonly string[];
  readonly hint: string;
}

export interface ConfigResolution {
  readonly config: E2eConfig;
  /** 致命缺失：缺任一即无法开始（退出码 2，判据一条都跑不了）。 */
  readonly fatal: readonly ConfigRequirement[];
  /** 判据 C 的前置缺失：判据 A、B 照常执行，但退出码非 0（缺前置）。 */
  readonly crossTenant: readonly ConfigRequirement[];
  /** 影响结论解释的提示（复用既有资源、自动绑定之类）。 */
  readonly notes: readonly string[];
}

function readValue(env: Record<string, string | undefined>, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** 开关语义：未设置用默认值，`0` / `false` 视为关闭（其余一律视为开启）。 */
function readFlag(env: Record<string, string | undefined>, key: string, fallback: boolean): boolean {
  const value = readValue(env, key);
  if (value === null) return fallback;
  return value !== "0" && value.toLowerCase() !== "false";
}

function readTimeout(env: Record<string, string | undefined>): number {
  const raw = readValue(env, "WORKFLOW_V2_E2E_TIMEOUT_MS");
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/** 把环境变量解析成运行配置，并把「缺什么、怎么补」一并算出来（由入口负责打印）。 */
export function resolveConfig(env: Record<string, string | undefined>): ConfigResolution {
  const sessionCookie = readValue(env, "WORKFLOW_V2_E2E_SESSION_COOKIE");
  const email = readValue(env, "WORKFLOW_V2_E2E_EMAIL");
  const password = readValue(env, "WORKFLOW_V2_E2E_PASSWORD");
  const foreignEmail = readValue(env, "WORKFLOW_V2_E2E_EMAIL_B");
  const foreignPassword = readValue(env, "WORKFLOW_V2_E2E_PASSWORD_B");
  const foreignWorkflowId = readValue(env, "WORKFLOW_V2_E2E_FOREIGN_WORKFLOW_ID");
  const workflowId = readValue(env, "WORKFLOW_V2_E2E_WORKFLOW_ID");

  const fatal: ConfigRequirement[] = [];
  // 会话二选一：cookie 最省事（浏览器复制），账号密码路径顺带把登录链路也跑了一遍。
  // 三段判定按「缺得最少」优先：先点名只缺的那一枚，再说「整套会话都没有」。
  if (!sessionCookie && !(email && password)) {
    if (email && !password) {
      fatal.push({
        label: "控制台账号密码",
        variables: ["WORKFLOW_V2_E2E_PASSWORD"],
        hint: "给了 WORKFLOW_V2_E2E_EMAIL 就得同时给 WORKFLOW_V2_E2E_PASSWORD（脚本只做一次性登录，不留存凭据），或改用 WORKFLOW_V2_E2E_SESSION_COOKIE",
      });
    } else if (!email && password) {
      fatal.push({
        label: "控制台账号邮箱",
        variables: ["WORKFLOW_V2_E2E_EMAIL"],
        hint: "给了 WORKFLOW_V2_E2E_PASSWORD 就得同时给 WORKFLOW_V2_E2E_EMAIL，或改用 WORKFLOW_V2_E2E_SESSION_COOKIE",
      });
    } else {
      fatal.push({
        label: "控制台会话",
        variables: ["WORKFLOW_V2_E2E_SESSION_COOKIE", "WORKFLOW_V2_E2E_EMAIL", "WORKFLOW_V2_E2E_PASSWORD"],
        hint:
          "二选一：给浏览器里的会话 cookie（WORKFLOW_V2_E2E_SESSION_COOKIE=" +
          "better-auth.session_token=…），或给控制台账号（WORKFLOW_V2_E2E_EMAIL + WORKFLOW_V2_E2E_PASSWORD，脚本自行登录）",
      });
    }
  }

  const crossTenant: ConfigRequirement[] = [];
  // 判据 C 要一个「属于另一个组织」的 workflow：直接给 ID，或给另一个组织的账号让脚本去列。
  if (!foreignWorkflowId && !(foreignEmail && foreignPassword)) {
    crossTenant.push({
      label: "跨租户判据的对照 workflow",
      variables: ["WORKFLOW_V2_E2E_FOREIGN_WORKFLOW_ID", "WORKFLOW_V2_E2E_EMAIL_B", "WORKFLOW_V2_E2E_PASSWORD_B"],
      hint:
        "二选一：直接给另一个组织名下的上游 workflow ID（WORKFLOW_V2_E2E_FOREIGN_WORKFLOW_ID，控制台该组织的画布 URL 里就有），" +
        "或给另一个组织的控制台账号（WORKFLOW_V2_E2E_EMAIL_B + WORKFLOW_V2_E2E_PASSWORD_B），由脚本列出该组织的第一个 workflow",
    });
  }

  const notes: string[] = [];
  notes.push(
    sessionCookie
      ? "会话来源：环境变量会话 cookie（跳过登录链路）"
      : `会话来源：控制台账号登录（${email ?? "<未给>"}）`,
  );
  if (workflowId) notes.push(`复用既有 workflow ${workflowId}：不创建、不删除，编辑后会把原始 schema 写回还原`);
  if (foreignWorkflowId) notes.push(`跨租户对照使用给定的 workflow ${foreignWorkflowId}`);
  if (!readFlag(env, "WORKFLOW_V2_E2E_AUTO_BIND", true))
    notes.push("已关闭自动绑定（WORKFLOW_V2_E2E_AUTO_BIND=0）：组织未绑定时判据 A、B 会以缺前置收场");
  if (readFlag(env, "WORKFLOW_V2_E2E_KEEP_RESOURCES", false))
    notes.push("已开启保留资源（WORKFLOW_V2_E2E_KEEP_RESOURCES=1）：本次创建的临时 workflow 不会被删除");

  return {
    config: {
      baseUrl: (readValue(env, "WORKFLOW_V2_E2E_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
      timeoutMs: readTimeout(env),
      sessionCookie,
      email,
      password,
      foreignEmail,
      foreignPassword,
      foreignWorkflowId,
      workflowId,
      activeOrgId: readValue(env, "WORKFLOW_V2_E2E_ACTIVE_ORG_ID"),
      keepResources: readFlag(env, "WORKFLOW_V2_E2E_KEEP_RESOURCES", false),
      autoBind: readFlag(env, "WORKFLOW_V2_E2E_AUTO_BIND", true),
    },
    fatal,
    crossTenant,
    notes,
  };
}

// ── 判读结果 ──

/** 一步的判读结论：`expected` / `actual` 是人读的对照，`suggestion` 是下一步动作。 */
export interface Verdict {
  readonly ok: boolean;
  readonly expected: string;
  readonly actual: string;
  readonly suggestion: string | null;
}

function verdict(ok: boolean, expected: string, actual: string, suggestion: string | null = null): Verdict {
  return { ok, expected, actual, suggestion };
}

/** 判据用尽的通用下一步建议：常见失败面各自给一条可执行动作。 */
const SUGGESTION = {
  unreachable:
    "请求未完成：确认平台服务在跑（bun run dev，默认 http://127.0.0.1:3000）且 WORKFLOW_V2_E2E_BASE_URL 指向它；网络慢可调大 WORKFLOW_V2_E2E_TIMEOUT_MS",
  unauthorized:
    "401：控制台会话或画布票据被拒——换一份 WORKFLOW_V2_E2E_SESSION_COOKIE / 核对账号密码，并确认票据头已带上",
  notFound:
    "404：workflow 不在当前组织的本地注册表里，或请求路径不在透传白名单内（白名单只有 /api/workflow_api/、/api/common/upload/、/api/playground_api/get_imagex_url）",
  notBound:
    "503 tenant_not_bound：该组织还没绑定上游应用——先调 POST /web/workflow-v2/org-app（幂等），或允许脚本自动绑定",
  sessionUnavailable:
    "503 upstream_session_unavailable：平台上游账号会话失效——调 POST /web/workflow-v2/platform-account/login 重登后重跑",
  upstream:
    "上游拒绝或不可达：查平台服务日志里 wf-v2-canvas-bff 的同一路径，并核对 GET /web/workflow-v2/platform-account 的 status",
  notEnvelope:
    "响应不是上游信封：可能打到了控制台面（{success,data}）或网关错误页——核对请求路径前缀 /workflow-canvas/bff",
} as const;

// ── 信封与失败形态 ──

export interface EnvelopeInspection {
  readonly hasEnvelope: boolean;
  readonly code: number | null;
  /** 顶层 `msg` 的逐字取值。**本面自产失败信封的唯一合法键**，`judgeBffFailure` 只认它。 */
  readonly msg: string | null;
  /** 顶层 `message` 的逐字取值：上游部分端点（如 `workflow_detail`）用它而不是 `msg`。 */
  readonly message: string | null;
  readonly keys: readonly string[];
  readonly hasData: boolean;
}

/**
 * 归纳上游信封（`{code,msg|message,data?}`）的可见形态；非对象或非数字 `code` 一律视为「不是信封」。
 *
 * 两个文案键都**原样**带出、不做合并：`msg` 与 `message` 的合法消费者不同（前者是本面失败信封的唯一
 * 形状，后者只出现在上游成功面），合并会让 `judgeBffFailure` 的逐字比较失去意义。要取「上游随行文案」
 * 请用 {@link upstreamCarriedMessage}。
 */
export function inspectEnvelope(json: unknown): EnvelopeInspection {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return { hasEnvelope: false, code: null, msg: null, message: null, keys: [], hasData: false };
  }
  const record = json as Record<string, unknown>;
  const code = typeof record.code === "number" ? record.code : null;
  return {
    hasEnvelope: code !== null,
    code,
    msg: typeof record.msg === "string" ? record.msg : null,
    message: typeof record.message === "string" ? record.message : null,
    keys: Object.keys(record).sort(),
    hasData: "data" in record,
  };
}

/**
 * 上游成功信封「随行文案」的取值：`msg` 优先，缺失（键不存在或类型不是字符串）时回退 `message`。
 *
 * 存在的理由是一条实测事实：**上游成功响应的信封字段名不统一** —— `workflow_detail` 顶层是
 * `{code, data, message}`，而 `canvas` 等是 `{code, data, msg}`（采集方式与原始键集合见契约快照
 * `docs/design/2026-09-29-workflow-v2-upstream-contract-snapshot.md` 的实测记录）。只认 `msg` 会把
 * `workflow_detail` 的成功响应误判成「口径漂移」。
 *
 * 回退**不削弱严格性**：这里只解决「文案装在哪个键里」，不解决「有没有文案」——两个键都缺失或均非字符串
 * 时仍返回 `null`，由调用方判失败。
 */
export function upstreamCarriedMessage(envelope: EnvelopeInspection): string | null {
  return envelope.msg ?? envelope.message;
}

function describeEnvelope(httpStatus: number | null, json: unknown): string {
  const envelope = inspectEnvelope(json);
  return `HTTP ${httpStatus ?? "未完成"}，顶层键 [${envelope.keys.join(", ")}]，code=${envelope.code ?? "-"}，msg=${envelope.msg ?? "-"}`;
}

/**
 * 上游成功判据：HTTP 2xx **且** 信封 `code === 0` **且** 随行文案存在（`msg` 或 `message` 至少一个）。
 *
 * 刻意不宽容（例如「没有 code 就算成功」）：本判据要核对的就是上游原生 `{data, code, msg}` 口径本身，
 * 放宽等于把口径漂移放过去。
 *
 * **文案键名的回退为什么不让真实的上游失败漏过**：成败由 `code` 与 HTTP 状态**先行**判定，两者都在文案
 * 判定之前返回；契约快照（`docs/…-upstream-contract-snapshot.md` 的 §A 失败面）实测的记录是「业务失败一律
 * HTTP 200 + `code≠0`（`777777775`/`700012006`/`720xx` …），传输与 thrift 必填失败走 HTTP 400/401」，
 * 即**没有任何一条失败分支靠「文案键叫什么」来表达**。因此本次回退只解决「文案装在 `msg` 还是 `message`
 * 里」，不解决「到底失败没有」：`code !== 0` 与「两个键都缺失」两条仍逐字照旧失败。唯一被这次回退放行的
 * 是「成功 + 文案只存在于 `message`」这一种形状 —— 实测中它正是 `workflow_detail` 的原生形状。
 */
export function judgeUpstreamSuccess(httpStatus: number | null, json: unknown): Verdict {
  const expected = "HTTP 2xx + { code: 0, 且 msg 或 message 存在 }";
  const actual = describeEnvelope(httpStatus, json);
  if (httpStatus === null) return verdict(false, expected, actual, SUGGESTION.unreachable);
  if (httpStatus === 401) return verdict(false, expected, actual, SUGGESTION.unauthorized);
  if (httpStatus === 404) return verdict(false, expected, actual, SUGGESTION.notFound);
  if (httpStatus === 503) return verdict(false, expected, actual, SUGGESTION.notBound);
  const envelope = inspectEnvelope(json);
  if (!envelope.hasEnvelope) return verdict(false, expected, actual, SUGGESTION.notEnvelope);
  if (httpStatus >= 400 || envelope.code !== 0) {
    return verdict(
      false,
      expected,
      actual,
      envelope.code === 503 ? SUGGESTION.sessionUnavailable : SUGGESTION.upstream,
    );
  }
  // 只判「有没有随行文案」，不判「装在哪个键」：空串沿用原语义放行，两键皆缺才算口径漂移。
  if (upstreamCarriedMessage(envelope) === null) {
    return verdict(false, expected, actual, "上游成功响应缺 msg/message：口径已漂移，先比对 docs/design 的契约快照");
  }
  return verdict(true, expected, actual, null);
}

/**
 * 本面自产失败信封的判据：HTTP 状态与业务码**逐字一致**、`msg` 与期望逐字相同。
 *
 * 冻结 §6 规定失败信封是 `{code: <status>, msg: <固定文案>}`（不是上游的业务码），画布侧据此判定
 * 是否换票；跨租户 404 还必须与「不存在」同形，所以这里连 msg 一起比。
 */
export function judgeBffFailure(
  httpStatus: number | null,
  json: unknown,
  expected: { readonly status: number; readonly msg: string },
): Verdict {
  const want = `HTTP ${expected.status} + { code: ${expected.status}, msg: "${expected.msg}" }`;
  const actual = describeEnvelope(httpStatus, json);
  const envelope = inspectEnvelope(json);
  if (httpStatus === null) return verdict(false, want, actual, SUGGESTION.unreachable);
  if (httpStatus !== expected.status || envelope.code !== expected.status) {
    const suggestion =
      envelope.code !== null && envelope.code !== 0 && envelope.code !== httpStatus
        ? SUGGESTION.upstream
        : `该步期望 ${expected.status}：${httpStatus === 200 ? "拿到了成功响应，说明这道门没有生效" : "状态码与期望不同"}`;
    return verdict(false, want, actual, suggestion);
  }
  if (envelope.msg !== expected.msg) {
    return verdict(false, want, actual, "状态码对了但 msg 不同：失败口径已变，先核对该端点的文案常量");
  }
  return verdict(true, want, actual, null);
}

export interface ConsoleEnvelope {
  readonly success: boolean | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly keys: readonly string[];
  readonly hasData: boolean;
}

/** 归纳控制台面信封（`{success,data}` / `{success:false,error:{code,message}}`）。 */
export function inspectConsoleEnvelope(json: unknown): ConsoleEnvelope {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return { success: null, errorCode: null, errorMessage: null, keys: [], hasData: false };
  }
  const record = json as Record<string, unknown>;
  const error =
    record.error !== null && typeof record.error === "object" ? (record.error as Record<string, unknown>) : null;
  return {
    success: typeof record.success === "boolean" ? record.success : null,
    errorCode: typeof error?.code === "string" ? error.code : null,
    errorMessage: typeof error?.message === "string" ? error.message : null,
    keys: Object.keys(record).sort(),
    hasData: "data" in record,
  };
}

/** 控制台面成功判据：HTTP 2xx + `success === true` + 带 `data`（与画布面的上游信封分属两套口径）。 */
export function judgeConsoleSuccess(httpStatus: number | null, json: unknown): Verdict {
  const expected = "HTTP 2xx + { success: true, data }";
  const envelope = inspectConsoleEnvelope(json);
  const actual = `HTTP ${httpStatus ?? "未完成"}，success=${envelope.success ?? "-"}，error=${envelope.errorCode ?? "-"}/${envelope.errorMessage ?? "-"}`;
  if (httpStatus === null) return verdict(false, expected, actual, SUGGESTION.unreachable);
  if (httpStatus === 401) return verdict(false, expected, actual, SUGGESTION.unauthorized);
  if (envelope.success === true && envelope.hasData && httpStatus < 400) return verdict(true, expected, actual, null);
  if (envelope.errorCode === "TENANT_NOT_BOUND" || envelope.errorCode === "NOT_BOUND") {
    return verdict(false, expected, actual, SUGGESTION.notBound);
  }
  if (envelope.errorCode === "PLATFORM_SESSION_UNAVAILABLE")
    return verdict(false, expected, actual, SUGGESTION.sessionUnavailable);
  if (httpStatus >= 400) return verdict(false, expected, actual, SUGGESTION.upstream);
  return verdict(false, expected, actual, "响应形状不是控制台信封：核对请求路径前缀 /web/workflow-v2");
}

// ── 伪造值扫描与同形比较 ──

/**
 * 深度扫描 `needles` 是否出现在响应里（字符串包含即命中，含数组元素与嵌套对象）。
 *
 * 返回命中的 JSON 路径（如 `data.workflow.project_id=e2e-forged-space`），空数组表示一个都没出现。
 * 这是判据 B「伪造值被 strip」的直接证据面：只要有一处回显，就说明客户端自报值到了上游。
 */
export function findValuePaths(json: unknown, needles: readonly string[]): string[] {
  const hits: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (typeof node === "string") {
      for (const needle of needles) if (node.includes(needle)) hits.push(`${path}=${needle}`);
      return;
    }
    if (Array.isArray(node)) {
      for (const [index, item] of node.entries()) walk(item, `${path}[${index}]`);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, item] of Object.entries(node as Record<string, unknown>))
        walk(item, path ? `${path}.${key}` : key);
    }
  };
  walk(json, "");
  return hits;
}

/** 键序无关的规范化 JSON：只比较「客户端解析得到的内容」，避免键序差异造成假失败。 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * 两个响应体是否不可区分：用于「跨租户 404」与「workflow 不存在 404」的对照。
 *
 * 冻结 §4 要求未命中一律 404 且不泄漏资源存在性——真正的判据不是「都是 404」，而是两者的响应体
 * **逐字相同**（否则存在性仍然可从差异里读出来）。
 */
export function judgeIndistinguishable(
  left: unknown,
  right: unknown,
  labels: { left: string; right: string },
): Verdict {
  const a = JSON.stringify(canonicalize(left ?? null));
  const b = JSON.stringify(canonicalize(right ?? null));
  const expected = `${labels.left} 与 ${labels.right} 的响应体逐字相同`;
  const actual = a === b ? `两侧同为 ${a}` : `${labels.left}=${a}；${labels.right}=${b}`;
  return verdict(
    a === b,
    expected,
    actual,
    a === b ? null : "两侧响应不同形：存在性可能已被差异泄漏，检查 notFound() 是否对两条路径返回了同一形状",
  );
}

// ── schema 标记（编辑 → 保存 → 复读的载体） ──

export interface SchemaEdit {
  readonly schema: string;
  /** 被改写的节点 id；无可用节点时为 null（此时判据 A 的「编辑」无法证明）。 */
  readonly nodeId: string | null;
  readonly before: string | null;
  readonly after: string | null;
  readonly detail: string;
}

/**
 * 在 workflow schema 文本里改一处**可持久化的外观字段**（首个节点的 `data.nodeMeta.title`）。
 *
 * 为什么挑外观字段：判据 A 要证明的是「编辑经 BFF 落到了上游」，不是图语义正确性——改写标题既必然出现在
 * 回读的 schema_json 里，又不会让 `validate_tree` / 调试运行因为图变了而失败。没有可用节点时原样返回，
 * 由调用方判失败（不静默假装改过）。
 */
export function applySchemaMarker(schemaText: string, marker: string): SchemaEdit {
  let parsed: unknown;
  try {
    parsed = JSON.parse(schemaText);
  } catch {
    return {
      schema: schemaText,
      nodeId: null,
      before: null,
      after: null,
      detail: "schema_json 不是合法 JSON，无法编辑",
    };
  }
  const nodes = (parsed as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) {
    return { schema: schemaText, nodeId: null, before: null, after: null, detail: "schema 没有 nodes 数组，无法编辑" };
  }
  for (const node of nodes) {
    if (node === null || typeof node !== "object") continue;
    const candidate = node as Record<string, unknown>;
    const nodeId = typeof candidate.id === "string" ? candidate.id : null;
    const data = candidate.data;
    if (nodeId === null || data === null || typeof data !== "object" || Array.isArray(data)) continue;
    const dataRecord = data as Record<string, unknown>;
    const nodeMeta = dataRecord.nodeMeta ?? {};
    if (nodeMeta === null || typeof nodeMeta !== "object" || Array.isArray(nodeMeta)) continue;
    const before =
      typeof (nodeMeta as Record<string, unknown>).title === "string"
        ? ((nodeMeta as Record<string, unknown>).title as string)
        : null;
    const after = `${before ?? "node"}${marker}`;
    dataRecord.nodeMeta = { ...(nodeMeta as Record<string, unknown>), title: after };
    return {
      schema: JSON.stringify(parsed),
      nodeId,
      before,
      after,
      detail: `节点 ${nodeId} 标题：${before ?? "<无>"} → ${after}`,
    };
  }
  return {
    schema: schemaText,
    nodeId: null,
    before: null,
    after: null,
    detail: "schema 没有带 id/data 的节点，无法编辑",
  };
}

/** 回读时取指定节点的标题；节点不存在或标题不是字符串都返回 null（由调用方判失败）。 */
export function readNodeTitle(schemaText: string, nodeId: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(schemaText);
  } catch {
    return null;
  }
  const nodes = (parsed as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return null;
  for (const node of nodes) {
    if (node === null || typeof node !== "object") continue;
    const candidate = node as Record<string, unknown>;
    if (candidate.id !== nodeId) continue;
    const data = candidate.data;
    if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
    const nodeMeta = (data as Record<string, unknown>).nodeMeta;
    if (nodeMeta === null || typeof nodeMeta !== "object" || Array.isArray(nodeMeta)) return null;
    const title = (nodeMeta as Record<string, unknown>).title;
    return typeof title === "string" ? title : null;
  }
  return null;
}

// ── 脱敏 ──

/** 控制台会话 cookie 的内联掩码（`better-auth.session_token=…` 形态，含 `__Secure-` 前缀）。 */
const CONSOLE_COOKIE_PATTERN = /((?:__Secure-|__Host-)?better-auth[\w.-]*)=([^;,\s"\\]+)/gi;
/** 画布票据的内联掩码：头名 + 值（值只在内存与请求头里流转，任何输出都不该出现）。 */
const TICKET_PATTERN = /([Xx]-[Ff]enix-[Ww]orkflow-[Tt]icket["'\s:=]+)([A-Za-z0-9._~-]{8,})/g;

export function redactConsoleSecrets(text: string): string {
  return text.replace(CONSOLE_COOKIE_PATTERN, "$1=<redacted>").replace(TICKET_PATTERN, "$1<redacted>");
}

/** 任何进报告/日志的值都走这里：先按上游口径脱敏，再掩掉控制台凭据，最后截断。 */
export function toEvidence(value: unknown, maxChars = EVIDENCE_MAX_CHARS): string {
  const text = typeof value === "string" ? value : JSON.stringify(redactValue(value));
  const masked = redactConsoleSecrets(redactString(text ?? ""));
  return masked.length > maxChars ? `${masked.slice(0, maxChars)}…<truncated>` : masked;
}
