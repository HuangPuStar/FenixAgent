/**
 * 日志投影的纯函数层：一行原始文本 → 一行可对外输出的结构化日志。无 IO、无状态，便于用例直接喂样本。
 *
 * 为什么必须有这一层（§7「只读取经过权限过滤的日志投影，不得直接暴露底层日志文件」）：日志文件是
 * **进程级共享**的，不按组织分目录，因此「权限过滤」在日志这条线上只能是**按可见范围筛选与裁剪**——
 * 由服务端枚举白名单化的日志源（`@fenix/logger` 的 `listLogSources`），再由本层把每一行裁剪成固定形状。
 * 客户端拿不到文件路径，也拿不到投影之外的字段。
 *
 * 本层做三件事，缺一不可：
 *   1. **字段投影**：只输出 timestamp / level / module / requestId / message / error 六个字段，
 *      原始 JSON 行里的其它字段（可能是 prompt 正文、请求头、任意业务负载）一律不进入响应。
 *   2. **红线脱敏**（§7「日志不得记录 token、Cookie、密码和连接串」）：写入侧可能违反该约束，
 *      投影层不假定上游干净——先按文本规则把凭据形状的内容抹掉，再出站。
 *   3. **长度裁剪**：单字段有上限，避免一行日志把响应和前端渲染拖垮。
 *
 * **已知残留（不是本层能修的，必须在设计上写明）**：本层无法还原语义，只能按形状脱敏。上游把
 * prompt 正文与 Agent 响应**截断后**写进日志的调用（例如 `packages/agent-runtime/src/routes/web/
 * control.ts` 的事件体 `JSON.stringify(b).slice(0, 200)`、`packages/acp-link/src/server.ts` 的
 * `promptText.slice(0, 200)`）落在 `message` 字段里，与普通诊断文本同形，投影层区分不了，因此这些
 * 片段仍可能出现在检索结果与导出里。修法在上游（记长度、摘要或结构化标记），归 §7 的「日志内容
 * 脱敏」优化项，不在本层再补一层猜测性正则——猜测会同时带来漏报和误伤。
 */

/** 日志记录的出站形状（协议 DTO 的定义在 `../../schemas/api-system-logs.schema`，本层只产数据）。 */
export interface ProjectedLogEntry {
  timestamp: string | null;
  level: string | null;
  module: string | null;
  requestId: string | null;
  message: string;
  error: { type: string | null; message: string | null; stack: string | null } | null;
}

/** 脱敏标记：保留字段名与位置，只抹掉值，便于排查「这里本来有凭据」。 */
export const REDACTION_MARKER = "[REDACTED]";
/** 裁剪标记：说明该字段被截断，避免被误读成日志原文如此。 */
export const TRUNCATION_SUFFIX = "…[truncated]";

/** 单行解析前的最大长度：超长行只取前缀再解析，防止畸形行把单条记录撑爆。 */
export const MAX_LINE_LENGTH = 8_000;
const SHORT_FIELD_LIMIT = 200;
const MESSAGE_FIELD_LIMIT = 2_000;
const STACK_FIELD_LIMIT = 4_000;

/**
 * 文本级脱敏规则表，按序应用。
 *
 * 顺序有语义：`Bearer` 先于「键值对」规则，因为 `Authorization: Bearer abc` 被键值对规则先吃掉时会
 * 只抹到第一个空格（留下 `abc`）；`Cookie` 整行规则先于键值对规则，因为 Cookie 头是 `k=v; k=v`
 * 的多对形态，只抹第一对等于没抹。
 *
 * 每条规则都刻意只匹配**值**并保留键名/结构：运维排查需要「哪个字段被脱敏」，而不是把整行抹平。
 */
const REDACTION_RULES: readonly [RegExp, string][] = [
  // Cookie / Set-Cookie：整行值都可能是凭据对，抹到行尾。
  [/(\b(?:set-cookie|cookie)\b\s*[:=]\s*)([^\n]+)/gi, `$1${REDACTION_MARKER}`],
  // Bearer / Basic 凭据：`Basic <base64>` 的 base64 也过不了「键值对」规则（它被空格截断在 `Basic`），
  // 因此这两种 scheme 必须在同一条规则里抹掉。
  [/(\bbearer\s+|\bbasic\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTION_MARKER}`],
  // URL 内的 user:password@（连接串是 §7 红线之一，保留 scheme 与 host 供排查）。
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTION_MARKER}@`],
  // 键值形态的凭据（含 query string 里的 `?token=`、JSON 里的 `"apiKey":"..."`）。
  [
    /(\b(?:authorization|proxy-authorization|password|passwd|pwd|passphrase|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|client[_-]?secret|private[_-]?key|credential)\b["']?\s*[:=]\s*["']?)([^\s"',;&)}\]]+)/gi,
    `$1${REDACTION_MARKER}`,
  ],
  // 已知前缀的密钥与 JWT：没有键名可依托时按形状识别。
  [/\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abpsr])[-_][A-Za-z0-9_-]{12,}/g, REDACTION_MARKER],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, REDACTION_MARKER],
];

/**
 * 抹掉文本里的凭据形状内容。
 *
 * 只在本层出站前调用：入站日志原文不改写（日志文件仍归写入侧所有，投影层不做回写）。
 */
export function redactLogText(text: string): string {
  let redacted = text;
  for (const [pattern, replacement] of REDACTION_RULES) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

/** 裁剪超长字段；未超限时原样返回，不加标记。 */
function crop(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}${TRUNCATION_SUFFIX}`;
}

/** 字符串字段的投影：先脱敏再裁剪，非字符串与空串一律归 null（`""` 与「字段缺失」在协议里是同一件事）。 */
function projectedField(value: unknown, limit: number): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return crop(redactLogText(value), limit);
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 把一行日志投影为出站记录。
 *
 * 非 JSON 行（`warn retry` 这类裸文本）与 JSON 行一样走本函数：前者整行进 `message`，同样过脱敏与裁剪——
 * 这正是「不得直读文件」的关键——不存在「解析失败就原样放行」的旁路。
 */
export function projectLogLine(line: string): ProjectedLogEntry {
  const raw = line.slice(0, MAX_LINE_LENGTH);
  const record = parseJsonObject(raw);

  if (!record) {
    return {
      timestamp: null,
      level: null,
      module: null,
      requestId: null,
      message: crop(redactLogText(raw), MESSAGE_FIELD_LIMIT),
      error: null,
    };
  }

  const errorRecord = toRecord(record.err);

  return {
    timestamp: projectedField(record.time, SHORT_FIELD_LIMIT),
    level: projectedField(record.level, SHORT_FIELD_LIMIT),
    module: projectedField(record.module, SHORT_FIELD_LIMIT),
    requestId: projectedField(record.requestId, SHORT_FIELD_LIMIT),
    message: crop(redactLogText(typeof record.msg === "string" ? record.msg : raw), MESSAGE_FIELD_LIMIT),
    error: errorRecord
      ? {
          type: projectedField(errorRecord.type, SHORT_FIELD_LIMIT),
          message: projectedField(errorRecord.message, MESSAGE_FIELD_LIMIT),
          stack: projectedField(errorRecord.stack, STACK_FIELD_LIMIT),
        }
      : null,
  };
}

/** 解析 JSON 对象行；失败或非对象返回 null（调用方回退到裸文本投影）。 */
function parseJsonObject(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return toRecord(value);
  } catch {
    return null;
  }
}
