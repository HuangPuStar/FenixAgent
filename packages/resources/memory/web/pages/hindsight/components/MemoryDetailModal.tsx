import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { hindsightApi } from "../../../api/hindsight";
import { type HindsightFailure, toHindsightFailure } from "../failure";
import { memoryTypeTitle } from "../memory-type-title";
import type { MemoryDetail } from "../types";
import { HindsightFailureNotice } from "./HindsightFailureNotice";
import { MemoryDetailBody } from "./MemoryDetailBody";

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

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{memory ? memoryTypeTitle(t, memory.type) : t("memoryDetail.defaultTitle")}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <Spinner className="flex py-20" />
        ) : failure ? (
          failure.kind === "forbidden" ? (
            // 授权失败不给「Error: Cannot resolve bank ID」这类回显，改走统一的无权限文案（无重试）。
            <HindsightFailureNotice failure={failure} className="py-20" />
          ) : (
            // 通用失败：单行原因 + `role="alert"`，与其它失败块同走库的 EmptyState 骨架。
            <EmptyState
              tone="danger"
              role="alert"
              className="py-20"
              title={t("memoryDetailModal.errorPrefix", { message: failure.detail })}
            />
          )
        ) : memory ? (
          <MemoryDetailBody
            memory={memory}
            variant="modal"
            labels={{
              text: t("memoryDetailModal.sectionText"),
              context: t("memoryDetailModal.sectionContext"),
              occurred: t("memoryDetailModal.sectionOccurred"),
              mentioned: t("memoryDetailModal.sectionMentioned"),
              entities: t("memoryDetailModal.sectionEntities"),
              tags: t("memoryDetailModal.sectionTags"),
              memoryId: t("memoryDetailModal.sectionMemoryId"),
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
