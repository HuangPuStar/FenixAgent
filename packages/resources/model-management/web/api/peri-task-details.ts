/**
 * peri-task-details.ts — Peri 任务详情 API 模块
 *
 * 后端协议由本包提供（`src/server/routes/web/peri-task-details.ts` 的
 * `/web/agents/:environmentId/sessions/:sessionId/peri-tasks/:taskId/detail`），浏览器侧取数 client
 * 随之落在同一 owner 下：路由与取数实现分居两处时，查询参数（`limit` / `byteLimit`）与返回联合类型
 * 会在两侧各自漂移而构建期无感。
 *
 * 迁移自宿主 `apps/web/src/api/peri-task-details.ts`（仅换落点，路径、查询范围与类型逐字不变）。
 * 消费方为宿主装配层（`apps/web/src/pages/agent-panel/chat-panel-ports.tsx`）；渲染组件
 * `@fenix/ui-components` 的 `PeriTaskDetailSheet` 只接收注入的 `loadDetail`，设计系统不反向依赖本包。
 */

import { request, unwrap } from "@fenix/web-runtime/api/request";

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
