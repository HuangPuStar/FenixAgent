import { parseExpression } from "cron-parser";
import { z } from "zod/v4";
import type { AgentDefinition, HttpDefinition, TaskV2Info } from "@/src/api/tasks-v2";
import type { TaskFormValues } from "../components/TaskForm";

export const taskFormSchema = z
  .object({
    type: z.enum(["http", "agent"]),
    name: z.string().min(1, "名称不能为空"),
    cron: z.string().min(1, "Cron 不能为空"),
    timezone: z.string().optional().default(""),
    timeoutSeconds: z.coerce.number().min(1).max(3600),
    description: z.string().optional().default(""),
    url: z.string().optional().default(""),
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional().default("POST"),
    headers: z.string().optional().default(""),
    body: z.string().optional().default(""),
    agentId: z.string().optional().default(""),
    prompt: z.string().optional().default(""),
  })
  .superRefine((data, context) => {
    if (data.type === "http") {
      if (!data.url.trim()) context.addIssue({ code: "custom", path: ["url"], message: "请输入 URL" });
      if (data.headers.trim()) {
        try {
          const parsed: unknown = JSON.parse(data.headers);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        } catch {
          context.addIssue({ code: "custom", path: ["headers"], message: "Headers 不是有效的 JSON 对象" });
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
