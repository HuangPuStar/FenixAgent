import { request, unwrap } from "./request";

export type PeriTaskDetail =
  | {
      kind: "preview";
      taskId: string;
      taskKind: "subagent" | "background";
      items: Array<{ type: "text"; content: string }>;
      nextCursor: null;
      complete: false;
      limitation: "source_only_provides_preview";
    }
  | {
      kind: "unavailable";
      taskId: string;
      taskKind: "subagent" | "background";
      reason: "not_provided" | "expired";
    };

/** 按需读取 Task Detail；调用方负责在切换或关闭 Sheet 时取消 signal。 */
export function getPeriTaskDetail(
  environmentId: string,
  sessionId: string,
  taskId: string,
  signal: AbortSignal,
): Promise<PeriTaskDetail> {
  return unwrap(
    request<PeriTaskDetail>("/web/agents/:environmentId/sessions/:sessionId/peri-tasks/:taskId/detail", {
      params: { environmentId, sessionId, taskId },
      query: { limit: 1, byteLimit: 2_000 },
      signal,
    }),
  );
}
