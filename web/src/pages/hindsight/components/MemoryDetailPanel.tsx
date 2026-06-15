import { Calendar, Check, Copy, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { hindsightApi } from "@/src/api/hindsight";
import { NS } from "@/src/i18n";
import type { MemoryDetail, MemoryTableRow } from "../types";

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

  // 获取完整记忆数据
  useEffect(() => {
    const memoryId = memory?.id;
    if (!memoryId) {
      setFullMemory(null);
      return;
    }
    setLoading(true);
    hindsightApi
      .getMemory(memoryId)
      .then((data) => {
        setFullMemory(data);
      })
      .catch((err) => {
        console.error("Failed to fetch memory details:", err);
        setFullMemory(null);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [memory?.id]);

  const displayMemory = fullMemory || ({ ...memory, type: memory.fact_type } as MemoryDetail & MemoryTableRow);
  const isObservation = displayMemory.fact_type === "observation" || displayMemory.type === "observation";

  // 根据类型确定标题
  const getMemoryTypeTitle = () => {
    const factType = displayMemory.fact_type || displayMemory.type;
    if (factType === "observation") return t("memoryDetailModal.typeObservation");
    if (factType === "world") return t("memoryDetailModal.typeWorldFact");
    if (factType === "experience") return t("memoryDetailModal.typeExperience");
    return t("memoryDetailPanel.title");
  };
  const memoryTypeTitle = getMemoryTypeTitle();

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(text);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
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
          <h3 className="text-xl font-bold text-foreground">{memoryTypeTitle}</h3>
          <Button variant="secondary" size="sm" onClick={onClose} className="h-8 w-8 p-0">
            <X className="h-5 w-5" />
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <span className="ml-2 text-muted-foreground">{t("memoryDetailPanel.loadingDetails")}</span>
          </div>
        ) : (
          <div className="space-y-5">
            {/* 文本 */}
            <div>
              <div className="text-xs font-bold text-muted-foreground uppercase mb-2">
                {t("memoryDetailPanel.sectionFullText")}
              </div>
              <div className="text-sm whitespace-pre-wrap leading-relaxed text-foreground">{displayMemory.text}</div>
            </div>

            {/* 上下文（非观察类型） */}
            {displayMemory.context && !isObservation && (
              <div>
                <div className="text-xs font-bold text-muted-foreground uppercase mb-2">
                  {t("memoryDetailPanel.sectionContext")}
                </div>
                <div className="text-sm text-foreground">{displayMemory.context}</div>
              </div>
            )}

            {/* 日期 */}
            {displayMemory.occurred_start && (
              <div>
                <div className="text-xs font-bold text-muted-foreground uppercase mb-2">
                  {t("memoryDetailPanel.sectionOccurred")}
                </div>
                <div className="flex items-center gap-2 text-sm text-foreground">
                  <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <span>
                    {new Date(displayMemory.occurred_start).toLocaleString()}
                    {displayMemory.occurred_end && displayMemory.occurred_end !== displayMemory.occurred_start && (
                      <>
                        <span className="text-muted-foreground mx-1">→</span>
                        {new Date(displayMemory.occurred_end).toLocaleString()}
                      </>
                    )}
                  </span>
                </div>
              </div>
            )}

            {displayMemory.mentioned_at && (
              <div>
                <div className="text-xs font-bold text-muted-foreground uppercase mb-2">
                  {t("memoryDetailPanel.sectionMentioned")}
                </div>
                <div className="flex items-center gap-2 text-sm text-foreground">
                  <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <span>{new Date(displayMemory.mentioned_at).toLocaleString()}</span>
                </div>
              </div>
            )}

            {/* 实体 */}
            {displayMemory.entities &&
              (Array.isArray(displayMemory.entities) ? displayMemory.entities.length > 0 : displayMemory.entities) && (
                <div>
                  <div className="text-xs font-bold text-muted-foreground uppercase mb-3">
                    {t("memoryDetailPanel.sectionEntities")}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(Array.isArray(displayMemory.entities)
                      ? displayMemory.entities
                      : String(displayMemory.entities).split(", ")
                    ).map((entity: unknown, _i: number) => {
                      const entityText =
                        typeof entity === "string"
                          ? entity
                          : (entity as Record<string, unknown>)?.name
                            ? String((entity as Record<string, unknown>).name)
                            : JSON.stringify(entity);
                      return (
                        <span
                          key={entityText}
                          className="text-sm px-3 py-1.5 rounded-full bg-primary/10 text-primary font-medium"
                        >
                          {entityText}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

            {/* 标签 */}
            {displayMemory.tags && displayMemory.tags.length > 0 && (
              <div>
                <div className="text-xs font-bold text-muted-foreground uppercase mb-2">
                  {t("memoryDetailPanel.sectionTags")}
                </div>
                <div className="flex flex-wrap gap-1">
                  {displayMemory.tags.map((tag: string) => (
                    <Badge key={tag} variant="secondary" className="text-xs">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Memory ID */}
            {memoryId && (
              <div>
                <div className="text-xs font-bold text-muted-foreground uppercase mb-2">
                  {t("memoryDetailPanel.sectionMemoryId")}
                </div>
                <div className="flex items-center gap-2">
                  <code className="text-xs font-mono text-muted-foreground">{memoryId}</code>
                  <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={() => copyToClipboard(memoryId)}>
                    {copiedId === memoryId ? (
                      <Check className="h-3 w-3 text-green-600" />
                    ) : (
                      <Copy className="h-3 w-3 text-muted-foreground" />
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

  // 紧凑/默认模式
  const padding = compact ? "p-3" : "p-4";
  const titleSize = compact ? "text-sm" : "text-lg";

  return (
    <div
      className={`bg-card border-2 border-primary rounded-lg ${padding} sticky top-4 max-h-[calc(100vh-120px)] overflow-y-auto`}
    >
      <div className="flex justify-between items-start mb-4">
        <h3 className={`${titleSize} font-bold text-card-foreground`}>{memoryTypeTitle}</h3>
        <Button variant="ghost" size="sm" onClick={onClose} className={compact ? "h-6 w-6 p-0" : "h-8 w-8 p-0"}>
          <X className={compact ? "h-3 w-3" : "h-4 w-4"} />
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
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
                  onClick={() => copyToClipboard(memoryId)}
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
