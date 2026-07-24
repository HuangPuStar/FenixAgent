"use client";

import { Loader2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { kbApi } from "@/src/api/knowledge-bases";
import { NS } from "@/src/i18n";
import type { KnowledgeResourceInfo } from "@/src/types/knowledge";
import { ResourcePreviewContent } from "../knowledge/ResourcePreviewContent";
import { Button } from "../ui/button";

interface CitationPreviewPanelProps {
  resourceId: string;
  kbId: string;
  onClose?: () => void;
}

/**
 * 引用预览内容面板（无固定定位，嵌入父容器使用）。
 * 由 ChatRoute 作为右侧 overlay 的内容渲染。
 */
export function CitationPreviewPanel({ resourceId, kbId, onClose }: CitationPreviewPanelProps) {
  const { t } = useTranslation(NS.KNOWLEDGE);
  const [resource, setResource] = useState<KnowledgeResourceInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadResource = useCallback(async () => {
    if (!resourceId || !kbId) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await kbApi.listResources({ id: kbId });
      if (!resp.success || !resp.data) {
        setError(resp.error?.message ?? t("preview.loadError"));
        return;
      }
      const found = resp.data.find((r) => r.id === resourceId);
      if (!found) {
        setError(t("preview.resourceNotFound", "资源不存在或已被删除"));
        return;
      }
      setResource(found);
    } catch (err) {
      console.error("Failed to load resource for citation", err);
      setError(t("preview.loadError"));
    } finally {
      setLoading(false);
    }
  }, [resourceId, kbId, t]);

  useEffect(() => {
    loadResource();
  }, [loadResource]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
        <h3 className="truncate flex-1 min-w-0 text-[15px] font-semibold">
          {resource?.sourceName ?? t("preview.title", { name: "" })}
        </h3>
        {onClose && (
          <Button variant="ghost" size="sm" onClick={onClose} title={t("preview.close")}>
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 flex flex-col">
        {loading && (
          <div className="flex-1 flex items-center justify-center gap-3 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
            <span className="text-sm">{t("preview.loading", "加载中...")}</span>
          </div>
        )}
        {error && !loading && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground p-6">
            <p className="text-sm">{error}</p>
            <Button variant="outline" size="sm" onClick={loadResource}>
              {t("preview.retry", "重试")}
            </Button>
          </div>
        )}
        {resource && !loading && !error && <ResourcePreviewContent resource={resource} kbId={kbId} />}
      </div>
    </div>
  );
}
