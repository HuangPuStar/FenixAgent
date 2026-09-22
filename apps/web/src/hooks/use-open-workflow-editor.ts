/**
 * 打开工作流编辑器（`/agent/workflow/$id/edit`）的导航接线。
 *
 * 2026-09-22 前端去重：`routes/agent/_panel/workflow.tsx` 与 `routes/agent/_panel/workflow_.$id.versions.tsx`
 * 各自逐字复制了同一段「`useCallback` + `navigate({ to, params })`」——版本页的「编辑」与列表页的「编辑」
 * 落点是同一条路由，目标一改就要在两处同步。收敛到本 hook 后，路由落点只有一处定义。
 */
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

/** 返回「按 workflow id 跳到编辑器」的回调。 */
export function useOpenWorkflowEditor() {
  const navigate = useNavigate();

  return useCallback(
    (workflowId: string) => {
      void navigate({
        to: "/agent/workflow/$id/edit",
        params: { id: workflowId },
      });
    },
    [navigate],
  );
}
