import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { connectWorkflowSSE, disconnectWorkflowSSE, type WorkflowSSEEvent } from "../../../api/workflow-sse";

/**
 * 编辑器的**外部事件与反馈**：SSE 订阅 + 保存状态、dry-run 结果的提示 + 调试快捷键。
 *
 * 三件事都是「编辑器对外界动作的回执」：保存成功、校验通过与否、别的协作者改了草稿；快捷键是同一个主题下
 * 的另一条全局事件订阅。它们只读编辑器已经算好的状态（`saveStatus` / `dryRunResult`）并把事件转给调用方，
 * 不持有任何自己的状态。
 *
 * SSE 用 ref 缓存 `hasUnsavedChanges` / `previewVersion` / 两个回调，避免它们出现在依赖数组里导致
 * 频繁断连重连：连接应该只在 `workflowId` 变化时重建，handler 内通过 ref 读最新值即可。
 */
export interface UseWorkflowEditorEventsParams {
  workflowId: string | undefined;
  saveStatus: "idle" | "saving" | "saved" | "unsaved";
  dryRunResult: { valid: boolean; issues: Array<{ type: string; message: string; field?: string }> } | null;
  /** 有未保存改动时不接受对端草稿更新（否则会盖掉用户正在编辑的内容） */
  hasUnsavedChanges: boolean;
  /** 版本预览态下同样不接受草稿更新（用户看的是历史版本） */
  previewVersion: number | null;
  /** 对端更新了草稿：重载草稿到画布 */
  onDraftUpdated: () => void;
  /** 运行相关事件交给运行视图处理 */
  onWorkflowEvent: (event: WorkflowSSEEvent) => void;
}

export function useWorkflowEditorEvents({
  workflowId,
  saveStatus,
  dryRunResult,
  hasUnsavedChanges,
  previewVersion,
  onDraftUpdated,
  onWorkflowEvent,
}: UseWorkflowEditorEventsParams): void {
  const { t } = useTranslation("workflows");

  // ── 保存状态 toast ──
  useEffect(() => {
    if (saveStatus === "saved") {
      toast.success(t("editor.saved"), { duration: 1500 });
    }
  }, [saveStatus, t]);

  // ── DryRun 结果 toast ──
  useEffect(() => {
    if (!dryRunResult) return;
    if (dryRunResult.valid) {
      toast.success(t("editor.validate_pass"), { duration: 2000 });
    } else {
      toast.error(t("editor.validate_fail", { count: dryRunResult.issues.length }), {
        description: dryRunResult.issues.map((i) => `${i.type === "error" ? "❌" : "⚠️"} ${i.message}`).join("\n"),
        duration: 5000,
      });
    }
  }, [dryRunResult, t]);

  // ── Workflow SSE 实时事件 ──
  const hasUnsavedChangesRef = useRef(hasUnsavedChanges);
  hasUnsavedChangesRef.current = hasUnsavedChanges;
  const previewVersionRef = useRef(previewVersion);
  previewVersionRef.current = previewVersion;
  const onDraftUpdatedRef = useRef(onDraftUpdated);
  onDraftUpdatedRef.current = onDraftUpdated;
  const onWorkflowEventRef = useRef(onWorkflowEvent);
  onWorkflowEventRef.current = onWorkflowEvent;

  useEffect(() => {
    if (!workflowId) return;

    connectWorkflowSSE(workflowId, (event) => {
      switch (event.type) {
        case "workflow.draft_updated":
          if (!hasUnsavedChangesRef.current && previewVersionRef.current === null) {
            onDraftUpdatedRef.current();
          }
          break;
        case "workflow.run_started":
        case "workflow.run_status_changed":
        case "workflow.run_cancelled":
          onWorkflowEventRef.current(event);
          break;
        case "workflow.dry_run_completed":
        case "workflow.version_published":
          break;
      }
    });

    return () => {
      disconnectWorkflowSSE(workflowId);
    };
  }, [workflowId]);

  // ── Ctrl/Cmd+Shift+D 打印当前 Context Queue 到控制台（调试用） ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "D") {
        e.preventDefault();
        import("@fenix/web-runtime/chat/context-queue").then(({ dumpContext }) => {
          console.log("[Workflow CQ]", new Date().toLocaleTimeString(), dumpContext());
        });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
