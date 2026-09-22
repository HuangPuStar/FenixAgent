import { Badge } from "@fenix/ui-components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { Calendar, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { hindsightApi } from "../../../api/hindsight";
import { type HindsightFailure, toHindsightFailure } from "../failure";
import type { MemoryDetail } from "../types";
import { HindsightFailureNotice } from "./HindsightFailureNotice";

interface MemoryDetailModalProps {
  memoryId: string | null;
  onClose: () => void;
}

/** 内存详情弹窗 — 简化版，点击表格行/时间线条目时弹出 */
export function MemoryDetailModal({ memoryId, onClose }: MemoryDetailModalProps) {
  const { t } = useTranslation(NS.HINDSIGHT);
  const [memory, setMemory] = useState<MemoryDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<HindsightFailure | null>(null);

  // 加载记忆详情
  useEffect(() => {
    if (!memoryId) return;

    const loadMemory = async () => {
      setLoading(true);
      setFailure(null);
      setMemory(null);

      try {
        const data = await hindsightApi.getMemory(memoryId);
        setMemory(data);
      } catch (err) {
        console.error("Error loading memory:", err);
        setFailure(toHindsightFailure(err));
      } finally {
        setLoading(false);
      }
    };

    loadMemory();
  }, [memoryId]);

  const isOpen = memoryId !== null;

  // 根据类型确定标题
  const getMemoryTypeTitle = () => {
    if (memory?.type === "observation") return t("memoryDetailModal.typeObservation");
    if (memory?.type === "world") return t("memoryDetailModal.typeWorldFact");
    if (memory?.type === "experience") return t("memoryDetailModal.typeExperience");
    return t("memoryDetailModal.defaultTitle");
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{memory ? getMemoryTypeTitle() : t("memoryDetailModal.defaultTitle")}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <Spinner className="flex py-20" />
        ) : failure ? (
          failure.kind === "forbidden" ? (
            // 授权失败不给「Error: Cannot resolve bank ID」这类回显，改走统一的无权限文案（无重试）。
            <div className="flex flex-col items-center justify-center py-20 text-center" role="alert">
              <HindsightFailureNotice failure={failure} />
            </div>
          ) : (
            <div className="flex items-center justify-center py-20">
              <div className="text-center text-destructive">
                <div className="text-sm">{t("memoryDetailModal.errorPrefix", { message: failure.detail })}</div>
              </div>
            </div>
          )
        ) : memory ? (
          <div className="flex-1 overflow-y-auto space-y-4 pr-2">
            {/* 文本 */}
            <div>
              <div className="text-xs font-bold text-muted-foreground uppercase mb-2">
                {t("memoryDetailModal.sectionText")}
              </div>
              <p className="text-sm text-foreground leading-relaxed">{memory.text}</p>
            </div>

            {/* 上下文 */}
            {memory.context && (
              <div>
                <div className="text-xs font-bold text-muted-foreground uppercase mb-1">
                  {t("memoryDetailModal.sectionContext")}
                </div>
                <div className="text-sm text-foreground">{memory.context}</div>
              </div>
            )}

            {/* 日期 */}
            {memory.occurred_start && (
              <div>
                <div className="text-xs font-bold text-muted-foreground uppercase mb-2">
                  {t("memoryDetailModal.sectionOccurred")}
                </div>
                <div className="flex items-center gap-2 text-sm text-foreground">
                  <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <span>
                    {new Date(memory.occurred_start).toLocaleString()}
                    {memory.occurred_end && memory.occurred_end !== memory.occurred_start && (
                      <>
                        <span className="text-muted-foreground mx-1">→</span>
                        {new Date(memory.occurred_end).toLocaleString()}
                      </>
                    )}
                  </span>
                </div>
              </div>
            )}

            {memory.mentioned_at && (
              <div>
                <div className="text-xs font-bold text-muted-foreground uppercase mb-2">
                  {t("memoryDetailModal.sectionMentioned")}
                </div>
                <div className="flex items-center gap-2 text-sm text-foreground">
                  <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <span>{new Date(memory.mentioned_at).toLocaleString()}</span>
                </div>
              </div>
            )}

            {/* 实体 */}
            {memory.entities && memory.entities.length > 0 && (
              <div>
                <div className="text-xs font-bold text-muted-foreground uppercase mb-2 flex items-center gap-1">
                  <Users className="w-3 h-3" />
                  {t("memoryDetailModal.sectionEntities")}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {memory.entities.map((entity: string) => (
                    <span key={entity} className="px-2 py-0.5 bg-primary/10 text-primary rounded text-xs">
                      {entity}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* 标签 */}
            {memory.tags && memory.tags.length > 0 && (
              <div>
                <div className="text-xs font-bold text-muted-foreground uppercase mb-2">
                  {t("memoryDetailModal.sectionTags")}
                </div>
                <div className="flex flex-wrap gap-1">
                  {memory.tags.map((tag: string) => (
                    <Badge key={tag} variant="secondary" className="text-xs">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* ID */}
            <div>
              <div className="text-xs font-bold text-muted-foreground uppercase mb-1">
                {t("memoryDetailModal.sectionMemoryId")}
              </div>
              <code className="text-xs font-mono text-muted-foreground break-all">{memory.id}</code>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
