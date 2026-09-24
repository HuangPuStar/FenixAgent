import { configError, configSuccess } from "../../../config-envelope";

/**
 * Provider 连通性探测：用给定凭据向上游发起真实请求，验证端点与密钥可用。
 *
 * 这是一个**无状态的外部调用模块**：不读数据库、不接收 actor、不认识资源归属。凭据与端点由调用方
 * （`providers.ts` 路由）在完成授权后解析好传入，因此这里的函数可以同时服务两条输入来源：
 *
 * - 配置面板里"先测后存"的流程传内联凭据（Provider 尚未落库，没有资源可授权）；
 * - 已保存的 Provider 传库中凭据（授权由路由经 Facade 完成，需要 `update` 动作）。
 *
 * 返回值直接是 `/web` 信封（`{success, data}`），因为探测结果本身就是面向控制台的协议响应，
 * 中间再插一层中性结果类型只会让两个 handler 各写一遍翻译。HTTP 状态码由路由按错误码映射。
 */

/**
 * 探测失败的稳定错误码；前端按这些码分支，取值与迁移前一致。
 *
 * `CONFIG_TEST_CREDENTIAL_UNRESOLVED` 为本轮新增：探测前的凭据解析失败与"上游/网络失败"是两种处置
 * （前者重试无用，要去补环境变量），因此单独给一个码而不是复用 `CONFIG_TEST_REQUEST_FAILED`。
 *
 * `MODEL_TEST_MESSAGE_RESPONSE_INVALID` 此前是**死码**——2xx 一律判"通过"，正文取不到文本也不管。
 * 现在由"2xx 但响应不可用"的两种情形产生：正文不是 JSON（`reason: invalid_json`）、正文里没有可展示
 * 文本（`reason: missing_text`），见 `readProbeMessage`。
 */
export type ProviderTestErrorCode =
  | "PROVIDER_TEST_LIST_HTTP_ERROR"
  | "PROVIDER_TEST_LIST_RESPONSE_INVALID"
  | "MODEL_TEST_MESSAGE_HTTP_ERROR"
  | "MODEL_TEST_MESSAGE_RESPONSE_INVALID"
  | "CONFIG_TEST_REQUEST_FAILED"
  | "CONFIG_TEST_CREDENTIAL_UNRESOLVED";

/** 探测目标的凭据与端点；`baseUrl` 必须已经过 {@link normalizeProviderBaseUrl} 处理。 */
export interface ProviderProbeTarget {
  readonly protocol: "openai" | "anthropic";
  readonly baseUrl: string;
  readonly apiKey: string;
}

/**
 * 端点回落：Provider 未配置 `baseUrl` 时按协议取官方端点，并去掉尾部斜杠。
 *
 * 这里刻意用 `||` 而不是 `??`：`baseUrl` 是用户输入的自由文本，空字符串既不是合法端点也不承载
 * 任何信息，语义上等同于"未配置"，两者都应回落到官方端点。这与"不用 `||` 吞掉有意义的空串"的
 * 约定不冲突——该约定针对的是空串本身有意义的字段。
 */
export function normalizeProviderBaseUrl(baseUrl: string | null | undefined, protocol: "openai" | "anthropic"): string {
  const fallback = protocol === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com";
  return (baseUrl || fallback).replace(/\/+$/, "");
}

/**
 * 探测会打的三种叶子路径；`/messages` 只属于 Anthropic 协议。
 *
 * 版本段（`/v1` 之类）不在这里，由 {@link buildProbeUrl} 按 baseUrl 实际形态决定加不加。
 */
export type ProbeLeafPath = "/models" | "/chat/completions" | "/messages";

/** 版本段：`v1` / `v4` / `v1beta` / `v2alpha`。整段匹配，不含糊地"在路径里找版本号"。 */
const VERSION_SEGMENT = /^v\d+(?:beta|alpha)?$/i;

/** 取 baseUrl 的路径段：先去掉 query / hash，再丢掉 scheme 与主机名——版本段只可能出现在路径里。 */
function baseUrlPathSegments(baseUrl: string): string[] {
  const [withoutQuery = ""] = baseUrl.split(/[?#]/);
  const afterScheme = withoutQuery.replace(/^[a-z][a-z\d+.-]*:\/\//i, "");
  const slash = afterScheme.indexOf("/");
  return slash === -1 ? [] : afterScheme.slice(slash).split("/").filter(Boolean);
}

/**
 * baseUrl 的路径是否已经写到"版本段"上。
 *
 * 只看路径**末尾一到两段**，不在路径中间找版本号（`.../v4/compat` 里的 `v4` 不是版本段，很可能只是
 * 一个普通路径名）：
 *
 * - 末段是版本段：`https://api.openai.com/v1`、`https://open.bigmodel.cn/api/paas/v4`、`.../api/v3`；
 * - 倒数第二段是版本段：`.../v1beta/openai`（Gemini 的 OpenAI 兼容层把 API 根名 `openai` 挂在版本段
 *   后面）——再往后追加 `/v1` 就会 404，所以这一形态必须一起认。
 */
function isVersionedBaseUrl(baseUrl: string): boolean {
  const segments = baseUrlPathSegments(baseUrl);
  const last = segments.at(-1);
  if (last === undefined) return false;
  if (VERSION_SEGMENT.test(last)) return true;
  const secondLast = segments.at(-2);
  return secondLast !== undefined && VERSION_SEGMENT.test(secondLast);
}

/** baseUrl 是否已经写到该叶子路径上（用户把完整端点粘进了配置框）。 */
function hasLeafPath(baseUrl: string, path: ProbeLeafPath): boolean {
  const [withoutQuery = ""] = baseUrl.split(/[?#]/);
  return withoutQuery.endsWith(path);
}

/**
 * 拼出探测请求的最终 URL：`baseUrl` + 版本段（按需）+ 叶子路径（按需）。
 *
 * 三种形态：
 *
 * - **裸主机**：`https://api.openai.com` → `https://api.openai.com/v1/chat/completions`
 *   （Anthropic 同理 `https://api.anthropic.com` → `.../v1/messages`）；
 * - **已含版本段**：`https://open.bigmodel.cn/api/paas/v4` → `.../api/paas/v4/chat/completions`，
 *   不再补 `/v1`（这是本轮修的 P1：之前一律补成 `.../v4/v1/...` 而 404）；
 * - **用户直接粘贴完整端点**：`.../v1/chat/completions` 原样返回，不再追加（之前会拼成
 *   `.../v1/chat/completions/v1/chat/completions`）。
 *
 * 已知盲区（改动前后同样覆盖不到，只能靠用户把 baseUrl 填成带版本段的形态）：
 *
 * - 指向**不带版本段**的自定义根：`https://gw.example.com/anthropic` → `.../anthropic/v1/messages`；
 *   这一形态还有一层协议事实：Anthropic 兼容面（DeepSeek `https://api.deepseek.com/anthropic` 等）
 *   常只实现 `/v1/messages`，没有 `/v1/models`，因此本函数在该形态下拼出的列表请求必然 404。列表接口
 *   属 OpenAI 兼容面（DeepSeek 为 `https://api.deepseek.com/models`），与消息端点不在同一地址上——
 *   探测不做跨地址回落（会变成猜），改由 {@link fetchProviderModels} 的提示与配置面板的手动输入承接。
 * - 版本段不是整段：`.../api/v2.1`、`.../api/2024-10-01`（日期版本）认不出来，仍会补 `/v1`；
 * - 带 query 的 baseUrl（Azure 的 `?api-version=`）：拼出来的 query 位置不对，本就不受支持。
 */
export function buildProbeUrl(baseUrl: string, path: ProbeLeafPath): string {
  // baseUrl 已经过 normalizeProviderBaseUrl 去掉尾斜杠；这里再防一手，让函数可独立使用。
  const normalized = baseUrl.replace(/\/+$/, "");
  if (hasLeafPath(normalized, path)) return normalized;
  return isVersionedBaseUrl(normalized) ? `${normalized}${path}` : `${normalized}/v1${path}`;
}

/**
 * 提取错误响应正文的前 200 字符作为诊断信息。
 *
 * 上游错误正文可能回显请求内容，因此只截断取用、不落日志；调用方把它放进响应体的 `detail` 字段
 * 供配置面板展示。读取失败时返回 `undefined` 而不是抛出：诊断信息缺失不该把失败原因换掉。
 */
async function readErrorDetail(res: Response): Promise<string | undefined> {
  try {
    const detail = (await res.text()).trim().slice(0, 200);
    return detail || undefined;
  } catch {
    return;
  }
}

function probeError(code: ProviderTestErrorCode, data?: Record<string, unknown>) {
  return configError(code, code, data);
}

/**
 * 探测无法开始：凭据是 `{env:NAME}` 引用而该环境变量未配置。
 *
 * `data` 只带探测目标（`target` / `protocol` / 可选的 `modelId`），**不带引用名或凭据原文**：失败的
 * 是"引用解析不出来"这件事，把用户填写的字段回显进响应什么也帮不上。
 */
export function credentialUnresolvedError(data: Record<string, unknown>) {
  return probeError("CONFIG_TEST_CREDENTIAL_UNRESOLVED", data);
}

/** 把 fetch 抛出的异常归纳成可展示的失败原因：超时与请求失败对用户是两种不同的处置。 */
export function getTestFailureReason(error: unknown): { reason: "timeout" | "request_failed"; detail?: string } {
  if (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return { reason: "timeout" };
  }

  if (error instanceof Error && error.message) {
    return { reason: "request_failed", detail: error.message };
  }

  return { reason: "request_failed" };
}

/**
 * 带超时的探测执行。
 *
 * 超时用 `AbortController` 而不是 `Promise.race`：后者只是放弃等待，上游请求会继续挂着占连接。
 * `finally` 保证定时器一定被清理，否则一个快速返回的探测会留下一个到点触发的 abort。
 */
async function runWithTimeout<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 探测包装：把超时/网络异常统一转成 `CONFIG_TEST_REQUEST_FAILED`。
 *
 * `errorData` 由调用方给全（`target` 是 `provider` 还是 `model`、协议、模型 ID），因为"哪一类探测失败"
 * 是调用方才知道的上下文；这里只负责补上失败原因。
 */
export async function probeWithTimeout<T>(
  timeoutMs: number,
  errorData: Record<string, unknown>,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T | ReturnType<typeof probeError>> {
  try {
    return await runWithTimeout(timeoutMs, run);
  } catch (error: unknown) {
    return probeError("CONFIG_TEST_REQUEST_FAILED", {
      ...errorData,
      ...getTestFailureReason(error),
    });
  }
}

function extractModelIds(json: { data?: Array<{ id?: string }> }, protocol: "openai" | "anthropic") {
  if (!Array.isArray(json.data)) {
    return probeError("PROVIDER_TEST_LIST_RESPONSE_INVALID", { protocol, reason: "missing_data_array" });
  }
  const models = json.data
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (models.length === 0) {
    return probeError("PROVIDER_TEST_LIST_RESPONSE_INVALID", { protocol, reason: "missing_model_id" });
  }
  return configSuccess({ models });
}

/** 列出上游模型：OpenAI 兼容协议用 `Bearer`，Anthropic 用 `x-api-key`。 */
export async function fetchProviderModels(target: ProviderProbeTarget, signal: AbortSignal) {
  if (target.protocol === "anthropic") {
    const res = await fetch(buildProbeUrl(target.baseUrl, "/models"), {
      headers: {
        "x-api-key": target.apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal,
    });

    if (!res.ok) {
      return probeError("PROVIDER_TEST_LIST_HTTP_ERROR", {
        protocol: "anthropic",
        status: res.status,
        detail: await readErrorDetail(res),
        // Anthropic 兼容端点常常只实现 `/v1/messages`（DeepSeek 的 `/anthropic` 前缀即如此），列表接口
        // 因此必然 404/405，而消息调用完全正常：hint 让前端把处置方式说清（手动输入模型 ID，或改用该
        // 服务商的 OpenAI 兼容地址重新获取），而不是让用户以为密钥或地址填错了。
        hint: res.status === 404 || res.status === 405 ? "configure_model_then_test_model" : undefined,
      });
    }

    return extractModelIds((await res.json()) as { data?: Array<{ id?: string }> }, "anthropic");
  }

  const res = await fetch(buildProbeUrl(target.baseUrl, "/models"), {
    headers: { Authorization: `Bearer ${target.apiKey}` },
    signal,
  });

  if (!res.ok) {
    return probeError("PROVIDER_TEST_LIST_HTTP_ERROR", {
      protocol: "openai",
      status: res.status,
      detail: await readErrorDetail(res),
    });
  }

  return extractModelIds((await res.json()) as { data?: Array<{ id?: string }> }, "openai");
}

/** 2xx 响应体的解析结果；解析不出来时带上正文摘要，供展示层解释"上游到底回了什么"。 */
type ProbeJsonBody = { readonly ok: true; readonly json: unknown } | { readonly ok: false; readonly detail?: string };

/**
 * 读取并解析 2xx 响应体。
 *
 * 不走 `res.json()`：它抛出的 `SyntaxError` 会被 {@link probeWithTimeout} 归纳成"请求失败"，而
 * "上游回了 2xx、正文却不是消息响应"（网关错误页、被截断的响应、误配的 SSE 流、204 空正文）是**响应
 * 内容**问题，用户需要看到上游到底回了什么。正文摘要沿用 {@link readErrorDetail} 的口径：截断 200
 * 字符、只进响应体、不落日志。
 */
async function readProbeJson(res: Response): Promise<ProbeJsonBody> {
  let raw: string;
  try {
    raw = await res.text();
  } catch (error: unknown) {
    // 正文读取失败在 fetch 语义下近乎不可达；仍把异常信息带出去，避免"响应无效"成了无因之果。
    return { ok: false, detail: error instanceof Error ? error.message.slice(0, 200) : undefined };
  }
  try {
    return { ok: true, json: JSON.parse(raw) as unknown };
  } catch {
    // 这里刻意不保留 SyntaxError 的 message：它只有出错位置，上游正文摘要才是可诊断信息。
    return { ok: false, detail: raw.trim().slice(0, 200) || undefined };
  }
}

/**
 * 2xx 响应的统一判定：正文可解析、且能提取到非空文本，才算通过。
 *
 * 2xx 只证明"请求被上游接收"，不证明"这个模型能正常回话"：推理模型把正文放在 `reasoning_content`、
 * 网关返回自己的错误页、被截断的响应、只回 `tool_calls` 的空壳、`content: []`……这些都会让
 * {@link extractMessageText} 一无所获。改动前它们一律显示"已通过"且内容为空，用户无法判真伪；现在按
 * `MODEL_TEST_MESSAGE_RESPONSE_INVALID` 失败，`data.reason` 区分"正文不是 JSON"（`invalid_json`）与
 * "正文里没有可展示文本"（`missing_text`）。
 *
 * 判定取舍：探测请求**不带 `tools`**，合规上游不可能正当回答 `tool_calls`（真出现只说明网关改写了
 * 请求或响应不可信）；而"有响应、无文本"恰恰无法证明文本能力可用。因此这里不区分"结构不合法"与
 * "只有 tool_calls"，一律判失败——放行 tool_calls 等于把刚修掉的假通过再开一个口子。`content` 是数组
 * 形态（`[{type:"text",text:...}]`）时由 `extractMessageText` 正常取值，只有取不到任何文本才失败。
 */
async function readProbeMessage(
  res: Response,
  protocol: "openai" | "anthropic",
  pickContent: (json: unknown) => unknown,
) {
  const body = await readProbeJson(res);
  if (!body.ok) {
    return probeError("MODEL_TEST_MESSAGE_RESPONSE_INVALID", {
      protocol,
      status: res.status,
      reason: "invalid_json",
      detail: body.detail,
    });
  }

  const content = extractMessageText(pickContent(body.json));
  if (!content) {
    return probeError("MODEL_TEST_MESSAGE_RESPONSE_INVALID", { protocol, status: res.status, reason: "missing_text" });
  }

  return configSuccess({ ok: true, content });
}

/**
 * 从模型响应里按常见形状取出文本：字符串、Anthropic 的 content block 数组（`text` / `content`）、
 * 以及 OpenAI 兼容层把文本包成块数组的形态。取不到返回空串——**由调用方决定空串的后果**
 * （{@link readProbeMessage} 判失败），这里不做任何"这算不算通过"的判断。
 */
function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (typeof part === "string") return [part];
      if (typeof part !== "object" || part === null) return [];
      if ("text" in part && typeof part.text === "string") return [part.text];
      if ("content" in part && typeof part.content === "string") return [part.content];
      return [];
    })
    .join("\n")
    .trim();
}

/** 模型连通性测试：发一条简单消息，2xx 且响应里能提取到文本才算通过（见 {@link readProbeMessage}）。 */
export async function testModelMessage(
  target: ProviderProbeTarget & { readonly modelId: string },
  signal: AbortSignal,
) {
  if (target.protocol === "anthropic") {
    const res = await fetch(buildProbeUrl(target.baseUrl, "/messages"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": target.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: target.modelId,
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
      }),
      signal,
    });

    if (!res.ok) {
      return probeError("MODEL_TEST_MESSAGE_HTTP_ERROR", {
        protocol: "anthropic",
        status: res.status,
        detail: await readErrorDetail(res),
      });
    }

    return readProbeMessage(res, "anthropic", (json) => (json as { content?: unknown }).content);
  }

  const res = await fetch(buildProbeUrl(target.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${target.apiKey}`,
    },
    body: JSON.stringify({
      model: target.modelId,
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 32,
    }),
    signal,
  });

  if (!res.ok) {
    return probeError("MODEL_TEST_MESSAGE_HTTP_ERROR", {
      protocol: "openai",
      status: res.status,
      detail: await readErrorDetail(res),
    });
  }

  return readProbeMessage(
    res,
    "openai",
    (json) => (json as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content,
  );
}
