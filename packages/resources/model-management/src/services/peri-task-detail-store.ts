import type { PeriTaskDetailAvailability, PeriTaskKind } from "@fenix/chat-channel";
import type { DocManager } from "@fenix/chat-channel/server";
import { getPeriTasksMap } from "@fenix/chat-channel/server";

export interface PeriTaskDetailRecord {
  taskId: string;
  kind: PeriTaskKind;
  summary: string | null;
  detailAvailability: PeriTaskDetailAvailability;
}

export interface PeriTaskDetailStore {
  get(rcsSessionId: string, taskId: string): PeriTaskDetailRecord | null;
}

/** 只读取现有 Session Doc 投影；不创建 Doc，也不持久化浏览器提供的 locator。 */
export function createPeriTaskDetailStore(docManager: Pick<DocManager, "getSessionYdoc">): PeriTaskDetailStore {
  return {
    get(rcsSessionId, taskId) {
      const ydoc = docManager.getSessionYdoc(rcsSessionId);
      if (!ydoc) return null;
      const task = getPeriTasksMap(ydoc).get(taskId);
      if (!task) return null;
      const kind = task.get("kind");
      const availability = task.get("detailAvailability");
      if (
        (kind !== "subagent" && kind !== "background") ||
        (availability !== "preview" && availability !== "unavailable" && availability !== "expired")
      ) {
        return null;
      }
      const summary = task.get("summary");
      return {
        taskId,
        kind,
        summary: typeof summary === "string" && summary.length > 0 ? summary : null,
        detailAvailability: availability,
      };
    },
  };
}
