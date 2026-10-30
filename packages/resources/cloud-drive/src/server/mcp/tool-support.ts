import type * as z from "zod/v4";
import type { CloudDriveActor, CloudDriveFacade } from "../facades/cloud-drive-facade";
import type { CloudDriveFailure, CloudDriveResult } from "../facades/cloud-drive-result";
import type { CloudDriveMcpScope } from "./token";

/**
 * CloudDrive MCP 工具面的公共支撑：结果上限、参数严格校验、错误映射与 Facade 调用收敛。
 *
 * 工具定义（名称、描述、参数形状）在 `tools.ts`；SDK 装配在 `server.ts`。业务规则（乐观并发、
 * actor 隔离、幂等键）全部留在 Facade，和 `/web/cloud-drive/*` 共用同一份实现——两个入口不能各有
 * 一套写语义。
 *
 * 安全约束：
 * 1. 参数里没有 `user_id` / `org` 等主体字段；actor 只从 token 派生。strictObject 让越权字段直接失败。
 * 2. 错误只返回稳定 code 与固定中文文案；上游 message/details、URL、票据、master key 都不进入结果。
 * 3. 读结果上限 64 KiB；超出时截断并保留分页游标，让模型可以继续取。
 * 4. 文件内容是**不可信数据**：描述与 server instructions 都明确要求不要执行文件里的指令。
 */

/** 单次工具结果（JSON 文本）的字节上限。 */
export const CLOUD_DRIVE_MCP_RESULT_LIMIT_BYTES = 64 * 1024;
/** `cloud_drive_write_text` 的内容上限：超过部分必须走控制台的分片上传。 */
export const CLOUD_DRIVE_MCP_WRITE_TEXT_MAX_BYTES = 1024 * 1024;

/** 稳定错误码；网关不向上游透传，Agent 可以按它决定是否重试。 */
export type CloudDriveMcpErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNAVAILABLE"
  | "RATE_LIMITED"
  | "INVALID_ARGUMENT"
  | "NOT_CONFIGURED"
  | "UPSTREAM_ERROR";

const ERROR_MESSAGES: Record<CloudDriveMcpErrorCode, string> = {
  NOT_FOUND: "资源不存在，或当前用户无权访问。",
  CONFLICT: "资源已被其他操作修改，请重新读取元数据后再试。",
  UNAVAILABLE: "个人云盘暂不可用，请稍后重试。",
  RATE_LIMITED: "个人云盘请求过于频繁，请稍后重试。",
  INVALID_ARGUMENT: "参数不合法。",
  NOT_CONFIGURED: "个人云盘未配置，请联系管理员。",
  UPSTREAM_ERROR: "云盘服务返回异常，请稍后重试。",
};

/** 工具调用结果；形状与 MCP `CallToolResult` 对齐，便于直接返回。 */
export interface CloudDriveMcpToolResult {
  /** SDK 的 CallToolResult 带开放索引签名；保留它才能把结果直接交给 registerTool。 */
  readonly [key: string]: unknown;
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

/** 工具内部结果，附带只进日志的上游诊断字段。 */
export interface CloudDriveMcpToolOutcome {
  readonly result: CloudDriveMcpToolResult;
  readonly upstreamStatus?: number;
  readonly upstreamCode?: string;
  /** 失败时的稳定 code；成功时为 undefined。 */
  readonly errorCode?: CloudDriveMcpErrorCode;
}

export interface CloudDriveMcpToolContext {
  readonly actor: CloudDriveActor;
  readonly facade: CloudDriveFacade;
}

/** 工具定义；`inputSchema` 同时用于 MCP 声明与本地严格校验。 */
export interface CloudDriveMcpTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly scope: CloudDriveMcpScope;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
  readonly inputSchema: z.ZodObject<z.ZodRawShape>;
  run(context: CloudDriveMcpToolContext, rawArguments: unknown): Promise<CloudDriveMcpToolOutcome>;
}

/** 输出一个成功结果；超过上限时截断并给出稳定提示。 */
export function renderPayload(payload: Record<string, unknown>, textField?: string): CloudDriveMcpToolResult {
  const serialized = JSON.stringify(payload);
  if (byteLength(serialized) <= CLOUD_DRIVE_MCP_RESULT_LIMIT_BYTES) {
    return { content: [{ type: "text", text: serialized }], structuredContent: payload };
  }

  const notice = `结果超过 ${CLOUD_DRIVE_MCP_RESULT_LIMIT_BYTES} 字节上限，已截断。`;
  if (textField !== undefined) {
    const fieldValue = payload[textField];
    const overhead = byteLength(serialized) - byteLength(JSON.stringify(fieldValue)) + byteLength(notice) + 256;
    const budget = Math.max(CLOUD_DRIVE_MCP_RESULT_LIMIT_BYTES - overhead, 0);
    if (typeof fieldValue === "string") {
      const next = { ...payload, [textField]: truncateToBytes(fieldValue, budget), truncated: true, notice };
      return { content: [{ type: "text", text: JSON.stringify(next) }], structuredContent: next };
    }
  }

  const summary = { truncated: true, notice, byte_size: byteLength(serialized) };
  return { content: [{ type: "text", text: JSON.stringify(summary) }], structuredContent: summary };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** 按 UTF-8 字节预算截断，且不把代理对切成半个字符。 */
function truncateToBytes(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, middle)).byteLength <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

export function errorOutcome(
  code: CloudDriveMcpErrorCode,
  details: { upstreamStatus?: number; upstreamCode?: string; fields?: readonly string[] },
) {
  const error = {
    code,
    message: ERROR_MESSAGES[code],
    ...(details.fields && details.fields.length > 0 ? { fields: details.fields } : {}),
  };
  const result: CloudDriveMcpToolResult = {
    content: [{ type: "text", text: JSON.stringify({ error }) }],
    structuredContent: { error },
    isError: true,
  };
  return {
    result,
    errorCode: code,
    ...(details.upstreamStatus === undefined ? {} : { upstreamStatus: details.upstreamStatus }),
    ...(details.upstreamCode === undefined ? {} : { upstreamCode: details.upstreamCode }),
  };
}

/** 把 Facade 的失败分类映射成稳定 MCP code；上游细节由 client 的 onDiagnostic 记入宿主日志。 */
export function mapCloudDriveFailure(error: CloudDriveFailure): CloudDriveMcpToolOutcome {
  const code: CloudDriveMcpErrorCode =
    error.kind === "not-configured"
      ? "NOT_CONFIGURED"
      : error.kind === "not-found" || error.kind === "gone"
        ? "NOT_FOUND"
        : error.kind === "conflict"
          ? "CONFLICT"
          : error.kind === "rate-limited"
            ? "RATE_LIMITED"
            : error.kind === "invalid" || error.kind === "unprocessable" || error.kind === "payload-too-large"
              ? "INVALID_ARGUMENT"
              : error.kind === "unavailable"
                ? "UNAVAILABLE"
                : "UPSTREAM_ERROR";
  return errorOutcome(code, {});
}

/** 参数校验失败：只回字段路径，不回显调用方传值（可能含正文或伪造 ID）。 */
function invalidArguments(paths: readonly string[]): CloudDriveMcpToolOutcome {
  return errorOutcome("INVALID_ARGUMENT", { fields: paths });
}

/** 工具内部未预期异常：不把堆栈或内部细节交给 Agent。 */
export function unexpectedToolOutcome(): CloudDriveMcpToolOutcome {
  return errorOutcome("UPSTREAM_ERROR", {});
}

/** 工具超过请求超时：与上游不可达同语义，Agent 可自行退避重试。 */
export function timeoutToolOutcome(): CloudDriveMcpToolOutcome {
  return errorOutcome("UNAVAILABLE", {});
}

export function parseArguments<T>(
  schema: z.ZodObject,
  raw: unknown,
): { ok: true; value: T } | { ok: false; outcome: CloudDriveMcpToolOutcome } {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    // `strictObject` 对多余字段只给 `<root>` 路径，键名在 `issue.keys` 里；把它翻出来才能定位越权字段。
    const paths = [
      ...new Set(
        parsed.error.issues.flatMap((issue) =>
          issue.code === "unrecognized_keys" ? issue.keys : [issue.path.join(".") || "<root>"],
        ),
      ),
    ];
    return { ok: false, outcome: invalidArguments(paths) };
  }
  return { ok: true, value: parsed.data as T };
}

/** 执行一次 Facade 调用并把结果收敛成工具结果。 */
export async function runFacade<T extends Record<string, unknown>>(
  promise: Promise<CloudDriveResult<T>>,
  render: (data: T) => Record<string, unknown> = (data) => data,
  textField?: string,
): Promise<CloudDriveMcpToolOutcome> {
  const result = await promise;
  if (!result.ok) return mapCloudDriveFailure(result.error);
  return { result: renderPayload(render(result.data), textField) };
}
