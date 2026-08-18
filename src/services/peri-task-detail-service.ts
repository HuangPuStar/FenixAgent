import { createDeterministicRcsSessionId } from "@fenix/chat-channel";
import { NotFoundError } from "../errors";
import type { PeriTaskDetail, PeriTaskDetailQuery } from "../schemas/peri-task-details";
import type { PeriTaskDetailStore } from "./peri-task-detail-store";

const MAX_PREVIEW_CODE_POINTS = 500;

export interface PeriTaskDetailContext {
  organizationId: string;
  userId: string;
  environmentId: string;
  sessionId: string;
  taskId: string;
}

interface PeriTaskDetailServiceDeps {
  getOwnedEnvironment: (environmentId: string, organizationId: string, userId: string) => Promise<unknown>;
  store: PeriTaskDetailStore;
}

function truncateByUtf8Bytes(value: string, byteLimit: number): string {
  let bytes = 0;
  let output = "";
  for (const char of Array.from(value).slice(0, MAX_PREVIEW_CODE_POINTS)) {
    const size = new TextEncoder().encode(char).byteLength;
    if (bytes + size > byteLimit) break;
    bytes += size;
    output += char;
  }
  return output;
}

/**
 * 读取 Peri Task 的诚实首版 Detail：当前真实来源只有 Session Doc 中的有界摘要。
 * 不接受客户端 locator，不声称摘要是完整 transcript，并统一以 404 隐藏归属差异。
 */
export async function getPeriTaskDetail(
  context: PeriTaskDetailContext,
  query: PeriTaskDetailQuery,
  deps: PeriTaskDetailServiceDeps,
): Promise<PeriTaskDetail> {
  await deps.getOwnedEnvironment(context.environmentId, context.organizationId, context.userId);
  const rcsSessionId = createDeterministicRcsSessionId(context.environmentId, context.userId, context.sessionId);
  const task = deps.store.get(rcsSessionId, context.taskId);
  if (!task) throw new NotFoundError("任务详情不存在");

  if (task.detailAvailability === "expired") {
    return { kind: "unavailable", taskId: task.taskId, taskKind: task.kind, reason: "expired" };
  }
  if (task.detailAvailability !== "preview" || !task.summary) {
    return { kind: "unavailable", taskId: task.taskId, taskKind: task.kind, reason: "not_provided" };
  }

  const content = truncateByUtf8Bytes(task.summary, query.byteLimit);
  if (!content) {
    return { kind: "unavailable", taskId: task.taskId, taskKind: task.kind, reason: "not_provided" };
  }
  return {
    kind: "preview",
    taskId: task.taskId,
    taskKind: task.kind,
    items: [{ type: "text", content }],
    nextCursor: null,
    complete: false,
    limitation: "source_only_provides_preview",
  };
}
