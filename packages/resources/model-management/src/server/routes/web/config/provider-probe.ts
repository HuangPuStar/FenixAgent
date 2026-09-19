import { configError, configSuccess } from "@server/services/config-utils";

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

/** 探测失败的稳定错误码；前端按这些码分支，取值与迁移前一致。 */
export type ProviderTestErrorCode =
  | "PROVIDER_TEST_LIST_HTTP_ERROR"
  | "PROVIDER_TEST_LIST_RESPONSE_INVALID"
  | "MODEL_TEST_MESSAGE_HTTP_ERROR"
  | "MODEL_TEST_MESSAGE_RESPONSE_INVALID"
  | "CONFIG_TEST_REQUEST_FAILED";

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

/** 官方 API 挂在 `/v1` 下；用户已经写进 `/v1` 时不重复拼接。 */
export function withVersionedBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
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
    const res = await fetch(`${withVersionedBaseUrl(target.baseUrl)}/models`, {
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
        // Anthropic 的 /models 在部分部署上不可用，但 /messages 可用：提示用户改用"测试模型"。
        hint: res.status === 404 || res.status === 405 ? "configure_model_then_test_model" : undefined,
      });
    }

    return extractModelIds((await res.json()) as { data?: Array<{ id?: string }> }, "anthropic");
  }

  const res = await fetch(`${withVersionedBaseUrl(target.baseUrl)}/models`, {
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

/** 从模型响应中尽量提取文本内容，仅用于展示，不影响测试结果。 */
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

/** 模型连通性测试：发一条简单消息，HTTP 2xx 即视为通过。 */
export async function testModelMessage(
  target: ProviderProbeTarget & { readonly modelId: string },
  signal: AbortSignal,
) {
  if (target.protocol === "anthropic") {
    const res = await fetch(`${withVersionedBaseUrl(target.baseUrl)}/messages`, {
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

    const json = (await res.json()) as { content?: unknown };
    return configSuccess({ ok: true, content: extractMessageText(json.content) || "" });
  }

  const res = await fetch(`${withVersionedBaseUrl(target.baseUrl)}/chat/completions`, {
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

  const json = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  return configSuccess({ ok: true, content: extractMessageText(json.choices?.[0]?.message?.content) || "" });
}
