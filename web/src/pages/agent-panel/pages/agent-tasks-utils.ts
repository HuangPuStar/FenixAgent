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

/** 将绝对时间投影到以当前整点开始的 24 小时时间轴。 */
export function projectTaskTime(timestamp: number | null, now = Date.now()): number | null {
  if (timestamp == null) return null;
  const start = new Date(now);
  start.setMinutes(0, 0, 0);
  const position = ((timestamp * 1000 - start.getTime()) / 86_400_000) * 100;
  return position >= 0 && position <= 100 ? position : null;
}
