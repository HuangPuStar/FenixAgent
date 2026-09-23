"use client";

import "./KnowledgeGraphPanel.css";

import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@fenix/ui-components/ui/alert-dialog";
import { Button } from "@fenix/ui-components/ui/button";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { unwrap } from "@fenix/web-runtime/api/request";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useRequest } from "ahooks";
import { Loader2, Network, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { kbApi } from "../../api/knowledge-bases";
import type { KnowledgeGraphProgress } from "../../types/knowledge";
import { isKnowledgeGraphNotFound } from "./knowledge-graph-state";
import { KnowledgeLoadFailure } from "./pages/agent-knowledge-load-failure";
import { useKnowledgeGraphCanvas } from "./use-knowledge-graph-canvas";

interface KnowledgeGraphPanelProps {
  knowledgeBaseId: string;
  canManage?: boolean;
}

const POLL_INTERVAL_MS = 3000;

/**
 * 知识图谱面板：取数（§3.4 三态）+ 生成进度轮询 + 删除，画布交给 `use-knowledge-graph-canvas`
 * （G6 实例生命周期）与 `knowledge-graph-spec`（配置构建），见 §4.7 / §3.5 三层拆分。
 */
export function KnowledgeGraphPanel({ knowledgeBaseId, canManage = false }: KnowledgeGraphPanelProps) {
  const { t } = useTranslation(NS.KNOWLEDGE);

  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<KnowledgeGraphProgress | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 在途取数的取消句柄（§3.4）：换知识库 / 卸载时 abort。
  // 这里取代了此前手写的 `requestId` 令牌——令牌只能**丢弃**迟到的结果，请求仍在服务端跑完并占着连接；
  // `AbortSignal` 才是真的取消。`request()` 会把外部 abort 归一成 `{ success: false }` → `unwrap()` 抛
  // `ApiError`，而 ahooks 对「被后发请求取代的那一笔」不会再落 state（`Fetch` 内部的 count 守卫），
  // 所以主动取消不会点亮失败块。
  const graphAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => graphAbortRef.current?.abort(), []);

  /**
   * 图谱取数（§3.4）：三态由 `data` / `loading` / `error` 派生，不再手写
   * `useCallback` + `useEffect` + `setState`；重试与生成完成后的重查复用 `refresh`。
   *
   * `refreshDeps: [knowledgeBaseId]` 承担「换知识库即重查」；404（尚未生成图谱）仍在服务内归一成
   * `null` 落空态，与改造前 `setGraphData(null)` 同形——「没有图谱」不是失败。
   *
   * 语义差异已记账：改造前每次取数先清空 `graphData`（渲染副作用因此立刻销毁旧图实例），现在旧数据
   * 保留到新响应到达。加载态本来就不渲染画布容器，视觉不变；旧图实例的销毁推迟到新数据落地或组件卸载
   * （销毁逻辑仍在画布 hook 的 effect cleanup 里，未改动）。
   */
  const {
    data: graphData = null,
    loading: graphLoading,
    error: graphError,
    refresh: refreshGraph,
    mutate: mutateGraph,
  } = useRequest(
    async () => {
      graphAbortRef.current?.abort();
      const controller = new AbortController();
      graphAbortRef.current = controller;
      try {
        const data = await unwrap(kbApi.getGraph({ id: knowledgeBaseId }, { signal: controller.signal }));
        return data ?? null;
      } catch (error) {
        if (isKnowledgeGraphNotFound(error)) return null;
        throw error;
      }
    },
    {
      refreshDeps: [knowledgeBaseId],
      onError: (error) => console.error("[KnowledgeGraphPanel] load failed", error),
    },
  );
  // 失败态是独立分支（下方 `KnowledgeLoadFailure`）：失败时 `graphData` 为 `null`，
  // 不给分支就会渲染成「暂无图谱」——把取数失败伪装成「确实没有图谱」（§3.4 禁止）。
  const graphErrorMessage = graphError
    ? graphError instanceof Error
      ? graphError.message
      : t("graph.loadFailed")
    : null;

  /**
   * 停止进度轮询并收起生成态。
   *
   * 为什么抽出来：生成成功、进度轮询失败、以及 `knowledgeBaseId` 变化时的重置，三处此前各写一遍同样的
   * 「cleanup 定时器 + 置空 ref + `setGenerating(false)` + `setProgress(null)`」（其中两处逐字相同）。
   * 这四步必须同时发生：漏掉清理会留下无人回收的定时器，漏掉复位会留下一条永不消失的进度条。
   */
  const stopProgressPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    setGenerating(false);
    setProgress(null);
  }, []);

  // 换知识库时复位生成态：进度轮询绑的是旧知识库的进度，继续跑会把旧库的进度画在新库的面板上
  // （旧实现靠 `fetchGraph` 的引用变化顺带触发这段复位；改用 `useRequest` 后显式挂到 knowledgeBaseId 上，
  // 重查本身由 `refreshDeps` 承担，本 effect 只管复位）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: knowledgeBaseId 是触发条件（换库即复位），effect 体只调 stopProgressPolling，按建议删掉会静默丢掉复位语义
  useEffect(() => {
    stopProgressPolling();
  }, [knowledgeBaseId, stopProgressPolling]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const { containerRef } = useKnowledgeGraphCanvas(graphData, t);

  const handleGenerate = useCallback(async () => {
    try {
      setGenerating(true);
      setProgress({ progress: 0 });
      await unwrap(kbApi.generateGraph({ id: knowledgeBaseId }));

      pollRef.current = setInterval(async () => {
        try {
          const progressData = await unwrap(kbApi.getGraphProgress({ id: knowledgeBaseId }));
          setProgress(progressData);
          if (progressData.progress >= 1) {
            stopProgressPolling();
            // 这里用不抛错的 `refresh()` 而不是 `refreshAsync()`：重取失败由取数自身的 `onError` 记录、
            // 由失败块呈现；让它抛进本 tick 的 catch 会被当成「进度轮询失败」——语义不对（生成已经完成）。
            refreshGraph();
            toast.success(t("graph.generateSuccess"));
          }
        } catch (error) {
          stopProgressPolling();
          console.error("[KnowledgeGraphPanel] progress polling failed", error);
          toast.error(t("graph.progressFailed"));
        }
      }, POLL_INTERVAL_MS);
    } catch (err) {
      console.error("[KnowledgeGraphPanel] generate failed", err);
      toast.error(t("graph.generateFailed"));
      setGenerating(false);
      setProgress(null);
    }
  }, [knowledgeBaseId, refreshGraph, t, stopProgressPolling]);

  const handleDelete = useCallback(async () => {
    try {
      await unwrap(kbApi.deleteGraph({ id: knowledgeBaseId }));
      // 本地清空（`mutate`）与改造前的 `setGraphData(null)` 同形：刚删掉的图谱没有重取的意义，
      // 立即落空态即可；服务端若仍有残留，下一次 `refresh`（轮询 / 换库 / 重试）会重新对齐。
      mutateGraph(null);
      setDeleteConfirmOpen(false);
      toast.success(t("graph.deleteSuccess"));
    } catch (err) {
      console.error("[KnowledgeGraphPanel] delete failed", err);
      toast.error(t("graph.deleteFailed"));
    }
  }, [knowledgeBaseId, mutateGraph, t]);

  const nodeCount = graphData?.graph.nodes?.length ?? 0;
  const edgeCount = graphData?.graph.edges?.length ?? 0;

  return (
    <div className="space-y-5">
      {/* 操作按钮行 */}
      <div className="flex items-center gap-2.5">
        {graphData && (
          <Button
            variant="outline"
            size="sm"
            disabled={!canManage}
            className="text-xs h-8 rounded-lg border-slate-200 hover:border-red-300 hover:text-red-500 hover:bg-red-50 transition-all duration-150"
            onClick={() => setDeleteConfirmOpen(true)}
          >
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            {t("graph.delete")}
          </Button>
        )}
        <Button
          size="sm"
          disabled={generating || !canManage}
          className="text-xs h-8 rounded-lg shadow-md shadow-indigo-500/20 bg-indigo-500 hover:bg-indigo-500 transition-all duration-150"
          onClick={handleGenerate}
        >
          {generating ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5 mr-1.5" />
          )}
          {generating ? t("graph.generating") : t("graph.generate")}
        </Button>
      </div>

      {/* 进度条 */}
      {generating && progress && (
        <div className="space-y-2.5 rounded-xl bg-slate-50 border border-slate-100 p-4">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-slate-500">{t("graph.generating")}...</span>
            <span className="font-bold text-indigo-500 tabular-nums">{Math.round(progress.progress * 100)}%</span>
          </div>
          <div className="h-2 rounded-full bg-slate-200 overflow-hidden">
            <div
              className="knowledge-graph-progress-fill h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all duration-500"
              style={{ width: `${Math.round(progress.progress * 100)}%` }}
            />
          </div>
          {progress.progressMsg && <p className="text-3xs text-slate-400 truncate">{progress.progressMsg}</p>}
        </div>
      )}

      {/* 加载态 */}
      {graphLoading && (
        <div className="flex items-center justify-center min-h-100">
          <Spinner size="lg" label={t("graph.loading")} />
        </div>
      )}

      {graphErrorMessage && !graphLoading && (
        <div className="grid min-h-96 place-content-center rounded-xl border border-red-100 bg-red-50/50 p-6">
          {/* 重试复用 `useRequest` 的 `refresh`（与改造前重新调 `fetchGraph` 同义） */}
          <KnowledgeLoadFailure
            error={graphErrorMessage}
            title={t("graph.loadFailed")}
            onRetry={() => void refreshGraph()}
          />
        </div>
      )}

      {/* 空态 */}
      {!graphLoading && !graphErrorMessage && !graphData && !generating && (
        <div className="grid min-h-96 place-content-center rounded-xl bg-slate-50 border border-slate-100">
          <EmptyState icon={<Network />} title={t("graph.empty")} description={t("graph.emptyHint")} />
        </div>
      )}

      {/* G6 力导向图 */}
      {!graphLoading && graphData && nodeCount > 0 && (
        <div className="rounded-xl bg-white border border-slate-100 overflow-hidden shadow-sm">
          {/* 顶栏：节点/边计数 + 操作提示 */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-100 bg-gray-50">
            <div className="flex items-center gap-4 text-xs text-slate-500">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-indigo-500" />
                {t("graph.nodes")}: {nodeCount}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-4 rounded bg-slate-400" />
                {t("graph.edges")}: {edgeCount}
              </span>
            </div>
            <span className="text-3xs text-slate-400">{t("graph.networkHint")}</span>
          </div>
          {/* G6 画布 */}
          <div ref={containerRef} className="w-full" style={{ height: "560px" }}>
            {/* tooltip 的基础样式 — 由 G6 动态插入的 tooltip 元素使用 */}
            <style>{`
              .g6-tooltip {
                padding: 10px 14px !important;
                border-radius: 10px !important;
                font-family: system-ui, -apple-system, sans-serif !important;
                font-size: 12px !important;
                background: #fff !important;
                box-shadow: 0 4px 24px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06) !important;
                border: 1px solid #e8edf4 !important;
                max-width: 360px !important;
                line-height: 1.5 !important;
              }
            `}</style>
          </div>
        </div>
      )}

      {/* 删除确认弹窗 */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("graph.deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("graph.deleteConfirmDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <Button variant="destructive" onClick={handleDelete}>
              {t("graph.delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
