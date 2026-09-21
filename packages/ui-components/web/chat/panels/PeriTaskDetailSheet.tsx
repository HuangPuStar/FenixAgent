// =============================================================================
// Peri Task 详情抽屉 — 聊天面板的右侧 Sheet（任务行点击后按需读取详情）
//
// 复制自 packages/agent-runtime/web/components/chat/PeriTaskDetailSheet.tsx（CE 阶段 2
// 任务 1.6 T6a 迁入）。纯化改动：
//   - `PeriTaskViewProjection` 改从包内 ../types 导入；
//   - Button / Sheet 改为包内 ../../ui/*；
//   - i18n 由宿主 ns=components 收敛到 UI_COMPONENTS_NS 的 chat.components.periTask.* key；
//   - **详情取数改为 prop 注入**（`loadDetail`）：原实现直接 import 宿主
//     `@/src/api/peri-task-details`，而该 API 的后端 owner 是 resources/model-management，
//     包内不得依赖资源包；取数实现由宿主装配层注入（见 apps/web 的 chat-panel-ports）。
//   视觉、结构、交互、取消与 stale-response 防护均未改动。
// =============================================================================

import { AlertCircle, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { Button } from "../../ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../../ui/sheet";
import type { PeriTaskViewProjection } from "../types";

/**
 * 详情响应：与宿主 API 客户端 `getPeriTaskDetail` 的返回结构逐字段一致。
 *
 * 在包内重声明而不是从宿主/资源包导入——`packages/ui-components` 不得依赖宿主 `@/src`
 * 或 resources。宿主注入的 `loadDetail` 返回值经 TS 结构校验，两侧漂移会在装配点报错。
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

export interface PeriTaskDetailSheetProps {
  environmentId: string;
  sessionId: string;
  task: PeriTaskViewProjection | null;
  onClose: () => void;
  /** 详情取数实现，由宿主注入；调用方负责用传入的 signal 在关闭/切换时取消请求。 */
  loadDetail: (
    environmentId: string,
    sessionId: string,
    taskId: string,
    signal: AbortSignal,
  ) => Promise<PeriTaskDetail>;
}

/** 打开时才读取详情；关闭或切换 task 会取消旧请求并阻止 stale response 覆盖。 */
export function PeriTaskDetailSheet({ environmentId, sessionId, task, onClose, loadDetail }: PeriTaskDetailSheetProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const [detail, setDetail] = useState<PeriTaskDetail | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const requestVersion = useRef(0);

  useEffect(() => {
    if (!task) return;
    // retryVersion 是显式重试触发器，不参与请求参数。
    void retryVersion;
    const controller = new AbortController();
    const version = ++requestVersion.current;
    setDetail(null);
    setError(false);
    setLoading(true);
    void loadDetail(environmentId, sessionId, task.taskId, controller.signal).then(
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
  }, [environmentId, sessionId, task, retryVersion, loadDetail]);

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
