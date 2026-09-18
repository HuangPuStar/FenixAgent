/**
 * Peri Task 详情抽屉：按需加载单条任务的 Detail 并在 Sheet 中展示。
 *
 * 来源：`packages/agent-runtime/web/components/chat/PeriTaskDetailSheet.tsx` 逐字复制。
 *
 * 纯化改动点：
 * - 移除内部直连 HTTP（源实现 import `getPeriTaskDetail` 并拼
 *   `/web/agents/:environmentId/sessions/:sessionId/peri-tasks/:taskId/detail`），改为宿主注入的
 *   `loadDetail(taskId, signal)` 回调；`environmentId` / `sessionId` props 随之移除。
 * - `loadDetail` 经 ref 读取（effect 依赖仍为 task / retryVersion），避免宿主传入内联箭头函数时
 *   每次渲染重新发起请求。
 * - `PeriTaskDetail` 的 DTO 类型在包内就地声明（源在 `apps/web/src/api/peri-task-details.ts`，
 *   属于宿主 API 层，包内不复制该 api 模块）。
 * - i18n 命名空间改为 `uiComponents`，key 加 `chat.components.` 前缀。
 */

import { AlertCircle, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../lib/i18n";
import { Button } from "../../ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../../ui/sheet";
import type { PeriTaskViewProjection } from "../types";

/**
 * Peri Task 详情 DTO。复制自 `apps/web/src/api/peri-task-details.ts`（宿主 API 层类型，包内不引
 * `@fenix/*` 也不引宿主模块）；字段与源逐字一致。
 */
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

interface PeriTaskDetailSheetProps {
  task: PeriTaskViewProjection | null;
  /**
   * 宿主注入的详情加载器；实现必须支持 AbortSignal 取消。
   * 源实现由组件内部直连 `GET .../peri-tasks/:taskId/detail`，纯化后由宿主提供。
   */
  loadDetail: (taskId: string, signal: AbortSignal) => Promise<PeriTaskDetail>;
  onClose: () => void;
}

/** 打开时才读取详情；关闭或切换 task 会取消旧请求并阻止 stale response 覆盖。复制自 `packages/agent-runtime/web/components/chat/PeriTaskDetailSheet.tsx`。 */
export function PeriTaskDetailSheet({ task, loadDetail, onClose }: PeriTaskDetailSheetProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const [detail, setDetail] = useState<PeriTaskDetail | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const requestVersion = useRef(0);

  // loadDetail 只经 ref 参与请求：宿主传入内联函数时不应触发重复请求。
  const loadDetailRef = useRef(loadDetail);
  useEffect(() => {
    loadDetailRef.current = loadDetail;
  });

  useEffect(() => {
    if (!task) return;
    // retryVersion 是显式重试触发器，不参与请求参数。
    void retryVersion;
    const controller = new AbortController();
    const version = ++requestVersion.current;
    setDetail(null);
    setError(false);
    setLoading(true);
    void loadDetailRef.current(task.taskId, controller.signal).then(
      (value) => {
        if (version !== requestVersion.current) return;
        setDetail(value);
        setLoading(false);
      },
      (reason: unknown) => {
        if (controller.signal.aborted || version !== requestVersion.current) return;
        setError(true);
        setLoading(false);
        void reason;
      },
    );
    return () => {
      requestVersion.current += 1;
      controller.abort();
    };
  }, [task, retryVersion]);

  return (
    <Sheet open={task !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-lg flex flex-col">
        <SheetHeader>
          <SheetTitle>{task?.title ?? t("chat.components.periTask.detailTitle")}</SheetTitle>
          <SheetDescription>
            {task?.kind === "background"
              ? t("chat.components.periTask.kindBackground")
              : t("chat.components.periTask.kindSubagent")}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-text-muted" role="status">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("chat.components.periTask.detailLoading")}
            </div>
          ) : error ? (
            <div className="space-y-3" role="alert">
              <p className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" /> {t("chat.components.periTask.detailLoadFailed")}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setRetryVersion((version) => version + 1)}>
                  {t("chat.components.periTask.detailRetry")}
                </Button>
                <Button variant="outline" size="sm" onClick={onClose}>
                  {t("chat.components.periTask.detailClose")}
                </Button>
              </div>
            </div>
          ) : detail?.kind === "preview" ? (
            <div className="space-y-3">
              <p className="text-xs text-text-muted">{t("chat.components.periTask.previewOnly")}</p>
              {detail.items.map((item) => (
                <pre key={item.content} className="whitespace-pre-wrap break-words text-sm font-sans text-text-primary">
                  {item.content}
                </pre>
              ))}
            </div>
          ) : detail?.kind === "unavailable" ? (
            <p className="text-sm text-text-muted">
              {detail.reason === "expired"
                ? t("chat.components.periTask.detailExpired")
                : t("chat.components.periTask.detailUnavailable")}
            </p>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
