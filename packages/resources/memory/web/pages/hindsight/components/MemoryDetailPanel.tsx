import { Button } from "@fenix/ui-components/ui/button";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { Check, Copy, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { hindsightApi } from "../../../api/hindsight";
import { type HindsightFailure, toHindsightFailure } from "../failure";
import { memoryTypeTitle } from "../memory-type-title";
import type { MemoryDetail, MemoryTableRow } from "../types";
import { HindsightFailureNotice } from "./HindsightFailureNotice";
import { MemoryDetailBody } from "./MemoryDetailBody";

interface MemoryDetailPanelProps {
  memory: MemoryTableRow;
  onClose: () => void;
  compact?: boolean;
  inPanel?: boolean;
}

/** 内存详情侧面板 — 简化版，用于 Graph/Constellation 视图的节点详情展示 */
export function MemoryDetailPanel({ memory, onClose, compact = false, inPanel = false }: MemoryDetailPanelProps) {
  const { t } = useTranslation(NS.HINDSIGHT);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [fullMemory, setFullMemory] = useState<(MemoryDetail & MemoryTableRow) | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<HindsightFailure | null>(null);

  // 取数：失败不再只写 `console.error` 后静默回落到行摘要（用户看不出「详情没取到」与「详情就是这样」），
  // 而是置失败态由下方分支渲染可见的失败块，重试入口重新发起同一次请求。
  const loadMemory = useCallback(async (memoryId: string) => {
    setLoading(true);
    setFailure(null);
    try {
      setFullMemory(await hindsightApi.getMemory(memoryId));
    } catch (err) {
      console.error("Failed to fetch memory details:", err);
      setFullMemory(null);
      setFailure(toHindsightFailure(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // 获取完整记忆数据
  useEffect(() => {
    const memoryId = memory?.id;
    if (!memoryId) {
      setFullMemory(null);
      setFailure(null);
      return;
    }
    void loadMemory(memoryId);
  }, [memory?.id, loadMemory]);

  const displayMemory = fullMemory || ({ ...memory, type: memory.fact_type } as MemoryDetail & MemoryTableRow);

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(text);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
      // 复制按钮的成功能见（`copiedId` 换成对勾），失败此前只剩 console：点一下什么也不发生，
      // 用户无法区分「没复制上」与「点了没反应」，故补一次可见提示。
      toast.error(t("memoryDetailPanel.copyFailed"));
    }
  };

  if (!memory) return null;

  const memoryId = displayMemory.id || ("node_id" in displayMemory ? displayMemory.node_id : undefined);

  // 面板模式：无外边框/背景，更大的 padding，醒目的关闭按钮
  if (inPanel) {
    return (
      <div className="p-5">
        {/* 头部关闭按钮 */}
        <div className="flex justify-between items-center mb-6 pb-4 border-b border-border">
          <h3 className="text-xl font-bold text-foreground">
            {memoryTypeTitle(t, displayMemory.fact_type || displayMemory.type)}
          </h3>
          <Button variant="secondary" size="icon-sm" onClick={onClose} aria-label={t("memoryDetailPanel.close")}>
            <X className="h-5 w-5" />
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Spinner size="sm" />
            <span className="ml-2 text-muted-foreground">{t("memoryDetailPanel.loadingDetails")}</span>
          </div>
        ) : failure ? (
          <HindsightFailureNotice
            failure={failure}
            titleKey="memoryDetailPanel.loadFailed"
            retryKey="memoryDetailPanel.retry"
            onRetry={() => void loadMemory(memory.id)}
            className="py-12"
          />
        ) : (
          <MemoryDetailBody
            memory={displayMemory}
            variant="panel"
            onCopyId={(memoryId) => void copyToClipboard(memoryId)}
            copiedId={copiedId}
            labels={{
              text: t("memoryDetailPanel.sectionFullText"),
              context: t("memoryDetailPanel.sectionContext"),
              occurred: t("memoryDetailPanel.sectionOccurred"),
              mentioned: t("memoryDetailPanel.sectionMentioned"),
              entities: t("memoryDetailPanel.sectionEntities"),
              tags: t("memoryDetailPanel.sectionTags"),
              memoryId: t("memoryDetailPanel.sectionMemoryId"),
            }}
          />
        )}
      </div>
    );
  }

  // 紧凑/默认模式
  const padding = compact ? "p-3" : "p-4";
  const titleSize = compact ? "text-sm" : "text-lg";

  return (
    <div
      className={`bg-card border-2 border-primary rounded-lg ${padding} sticky top-4 max-h-[calc(100vh-120px)] overflow-y-auto`}
    >
      <div className="flex justify-between items-start mb-4">
        <h3 className={`${titleSize} font-bold text-card-foreground`}>
          {memoryTypeTitle(t, displayMemory.fact_type || displayMemory.type)}
        </h3>
        <Button
          variant="ghost"
          size={compact ? "icon-xs" : "icon-sm"}
          onClick={onClose}
          aria-label={t("memoryDetailPanel.close")}
        >
          <X className={compact ? "h-3 w-3" : "h-4 w-4"} />
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Spinner size="sm" />
          <span className="ml-2 text-sm text-muted-foreground">{t("memoryDetailPanel.loading")}</span>
        </div>
      ) : (
        <div className={compact ? "space-y-2" : "space-y-4"}>
          {/* 文本 */}
          <div className={`${compact ? "p-2" : "p-3"} bg-muted rounded-lg`}>
            <div className={`${compact ? "text-[10px]" : "text-xs"} font-bold text-muted-foreground uppercase mb-1`}>
              {t("memoryDetailPanel.sectionFullText")}
            </div>
            <div className={`${compact ? "text-xs" : "text-sm"} whitespace-pre-wrap`}>{displayMemory.text}</div>
          </div>

          {/* Memory ID */}
          {memoryId && (
            <div>
              <div className={`${compact ? "text-[10px]" : "text-xs"} font-bold text-muted-foreground uppercase mb-1`}>
                {t("memoryDetailPanel.sectionMemoryId")}
              </div>
              <div className="flex items-center gap-2">
                <code className={`${compact ? "text-[9px]" : "text-xs"} font-mono text-muted-foreground`}>
                  {memoryId}
                </code>
                <Button
                  variant="ghost"
                  size="sm"
                  className={`${compact ? "h-4 w-4" : "h-5 w-5"} p-0`}
                  onClick={() => void copyToClipboard(memoryId)}
                >
                  {copiedId === memoryId ? (
                    <Check className={`${compact ? "h-2.5 w-2.5" : "h-3 w-3"} text-green-600`} />
                  ) : (
                    <Copy className={`${compact ? "h-2.5 w-2.5" : "h-3 w-3"} text-muted-foreground`} />
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
