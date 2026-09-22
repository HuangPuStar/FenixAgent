import type { StatusTone } from "@fenix/ui-components/config/StatusBadge";
import { ApiError } from "@fenix/web-runtime/api/request";
import { parseExpression } from "cron-parser";
import { z } from "zod/v4";
import type { AgentDefinition, HttpDefinition, TaskV2Info } from "../../../api/tasks-v2";
import type { TaskFormValues } from "../components/TaskForm";

/**
 * 授权类错误码：`forbidden` 是宿主 `/web/*` 守卫与组织归属校验（`requireTeamScope`）的后端值，
 * `UNAUTHORIZED` 是 request 层对**没有** code 的 401/403 归一后的值——`normalizeErrorCode` 只在响应
 * 未携带 code 时才按 HTTP 状态映射，带 code 的响应原样透传。两种都认，否则「无权限」会退化成通用失败。
 */
const UNAUTHORIZED_CODES: ReadonlySet<string> = new Set(["forbidden", "UNAUTHORIZED"]);

/**
 * 判断加载失败是否属于「无权限」（401/403）。
 *
 * 用途是把它从通用加载失败里拆出来：授权是持久状态，再点一次重试只会拿到同一个 403，
 * 因此调用方对它只展示原因、不给重试入口（通用失败分支必须保留重试）。
 */
export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof ApiError && UNAUTHORIZED_CODES.has(error.code);
}

function isValidCronExpression(cron: string, timezone: string): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  try {
    parseExpression(cron, timezone.trim() ? { tz: timezone.trim() } : undefined);
    return true;
  } catch {
    return false;
  }
}

function isValidTimezone(timezone: string): boolean {
  if (timezone.trim().length === 0) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export const taskFormSchema = z
  .object({
    type: z.enum(["http", "agent"]),
    name: z.string().trim().min(1, "名称不能为空").max(128, "名称不能超过 128 个字符"),
    cron: z.string().trim().min(1, "Cron 不能为空"),
    timezone: z.string().trim().refine(isValidTimezone, "必须是有效的 IANA 时区").optional().default(""),
    timeoutSeconds: z.coerce
      .number()
      .finite("超时必须是有效数字")
      .int("超时必须是整数")
      .min(1, "超时至少为 1 秒")
      .max(3600, "超时不能超过 3600 秒"),
    description: z.string().max(2000, "描述不能超过 2000 个字符").optional().default(""),
    url: z.string().trim().optional().default(""),
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional().default("POST"),
    headers: z.string().max(10000, "Headers 不能超过 10000 个字符").optional().default(""),
    body: z.string().max(100000, "请求体不能超过 100000 个字符").optional().default(""),
    agentId: z.string().trim().optional().default(""),
    prompt: z.string().max(100000, "Prompt 不能超过 100000 个字符").optional().default(""),
  })
  .superRefine((data, context) => {
    if (!isValidCronExpression(data.cron, data.timezone)) {
      context.addIssue({ code: "custom", path: ["cron"], message: "Cron 表达式无效，请检查字段取值范围" });
    }
    if (data.type === "http") {
      try {
        const parsedUrl = new URL(data.url.trim());
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") throw new Error();
        if (!parsedUrl.hostname) throw new Error();
      } catch {
        context.addIssue({ code: "custom", path: ["url"], message: "请输入有效的 HTTP 或 HTTPS URL" });
      }
      if (data.headers.trim()) {
        try {
          const parsed: unknown = JSON.parse(data.headers);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          if (Object.values(parsed).some((value) => typeof value !== "string")) throw new Error();
        } catch {
          context.addIssue({ code: "custom", path: ["headers"], message: "Headers 必须是值为字符串的 JSON 对象" });
        }
      }
    }
    if (data.type === "agent") {
      if (!data.agentId.trim()) context.addIssue({ code: "custom", path: ["agentId"], message: "请选择 Agent" });
      if (!data.prompt.trim()) context.addIssue({ code: "custom", path: ["prompt"], message: "Prompt 不能为空" });
    }
  });

export const INITIAL_TASK_FORM_VALUES: TaskFormValues = {
  type: "http",
  name: "",
  cron: "*/5 * * * *",
  timezone: "",
  timeoutSeconds: 300,
  description: "",
  url: "",
  method: "POST",
  headers: "",
  body: "",
  agentId: "",
  prompt: "",
};

/**
 * 执行日志状态 → 色调 / 文案 key。
 *
 * 内联日志面板（`TasksPanel`）与日志弹窗（`TaskLogDialog`）此前各持一份，
 * 靠肉眼保持「timeout 也算失败」这类判断一致；归一到这里后，新增状态只改一处。
 */
export const LOG_STATUS_TONES: Record<string, StatusTone> = {
  success: "success",
  failed: "danger",
  timeout: "danger",
  skipped: "neutral",
  pending: "warning",
};

const LOG_STATUS_LABEL_KEYS: Record<string, string> = {
  success: "status.success",
  failed: "status.failed",
  timeout: "status.timeout",
  skipped: "status.skipped",
  pending: "status.pending",
};

/**
 * 日志状态对应的文案 key；未知状态按 `pending` 展示，与去重前的回退口径一致
 * （后端新增状态时先落到「等待中」，而不是露出原始英文状态码）。
 */
export function logStatusLabelKey(status: string): string {
  return LOG_STATUS_LABEL_KEYS[status] ?? LOG_STATUS_LABEL_KEYS.pending;
}

/**
 * 日志时间戳（Unix 秒）格式化为 `MM-DD HH:mm`。
 * 不用 `toLocaleString`：日志表格列宽固定，本地化格式的长度不稳定。
 */
export function formatTaskLogTime(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 将任务表单转换为后端 definition 联合类型。 */
export function buildTaskDefinition(values: TaskFormValues): HttpDefinition | AgentDefinition {
  if (values.type === "http") {
    return {
      url: values.url,
      method: values.method,
      headers: values.headers.trim() ? JSON.parse(values.headers) : undefined,
      body: values.body.trim() || undefined,
    };
  }
  return { prompt: values.prompt };
}

/** 将真实任务 DTO 转为编辑器视图模型。 */
export function taskToFormValues(task: TaskV2Info): TaskFormValues {
  const definition = task.definition as unknown as Record<string, unknown> | null;
  return {
    type: task.type,
    name: task.name,
    cron: task.cron,
    timezone: task.timezone ?? "",
    timeoutSeconds: task.timeoutSeconds,
    description: task.description ?? "",
    url: (definition?.url as string) ?? "",
    method: ((definition?.method as string) ?? "POST") as TaskFormValues["method"],
    headers: definition?.headers ? JSON.stringify(definition.headers) : "",
    body: (definition?.body as string) ?? "",
    agentId: task.agentId ?? "",
    prompt: (definition?.prompt as string) ?? "",
  };
}

/** Unix 秒级时间戳的紧凑相对时间展示。 */
export function formatTaskRelativeTime(
  timestamp: number | null | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (timestamp == null) return "—";
  const diff = Date.now() - timestamp * 1000;
  if (diff < 60_000) return t("relativeTime.justNow");
  if (diff < 3_600_000) return t("relativeTime.minutesAgo", { count: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t("relativeTime.hoursAgo", { count: Math.floor(diff / 3_600_000) });
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp * 1000));
}

/** 将绝对时间投影到从当前时刻开始的可选未来时间窗。 */
export function projectTaskTime(timestamp: number | null, now = Date.now(), windowHours = 24): number | null {
  if (timestamp == null) return null;
  const duration = windowHours * 3_600_000;
  const position = ((timestamp * 1000 - now) / duration) * 100;
  return position >= 0 && position <= 100 ? position : null;
}

/**
 * 展开当前时刻起指定时间窗口内的未来 cron 触发点，并转换为时间轴百分比。
 * 返回空数组代表计划无效或窗口内没有触发点；调用方可回退到后端 nextRunAt。
 */
export function projectCronOccurrences(
  cron: string,
  timezone: string | null | undefined,
  now = Date.now(),
  nextRunAt?: number | null,
  windowHours = 24,
): number[] {
  const duration = windowHours * 3_600_000;
  const end = new Date(now + duration);

  const fixedMinutes = /^\*\/([1-9]\d*) \* \* \* \*$/.exec(cron.trim());
  if (fixedMinutes) {
    const interval = Number(fixedMinutes[1]) * 60_000;
    let occurrence: number;
    if (nextRunAt != null) {
      occurrence = nextRunAt * 1000;
    } else {
      try {
        occurrence = parseExpression(cron, {
          currentDate: new Date(now),
          endDate: end,
          tz: timezone?.trim() || undefined,
        })
          .next()
          .getTime();
      } catch (error) {
        console.warn("[task-runtime] unable to project fixed-minute cron expression", { cron, error });
        return [];
      }
    }
    if (occurrence < now) occurrence += Math.ceil((now - occurrence) / interval) * interval;
    const positions: number[] = [];
    for (; occurrence <= end.getTime(); occurrence += interval) {
      positions.push(((occurrence - now) / duration) * 100);
    }
    return positions;
  }

  try {
    const schedule = parseExpression(cron, {
      currentDate: new Date(now),
      endDate: end,
      tz: timezone?.trim() || undefined,
    });
    const positions: number[] = [];
    while (schedule.hasNext()) {
      const occurrence = schedule.next();
      const position = ((occurrence.getTime() - now) / duration) * 100;
      if (position >= 0 && position <= 100) positions.push(position);
    }
    return positions;
  } catch (error) {
    console.warn("[task-runtime] unable to project cron expression", { cron, error });
    return [];
  }
}
