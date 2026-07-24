"use client";

import DOMPurify from "dompurify";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { kbApi } from "@/src/api/knowledge-bases";
import { unwrap } from "@/src/api/request";
import { NS } from "@/src/i18n";
import type { KnowledgeChunkListResponse, KnowledgeResourceInfo } from "@/src/types/knowledge";

interface ChunkDetailSheetProps {
  open: boolean;
  onClose: () => void;
  kbId: string;
  resource: KnowledgeResourceInfo;
}

/** 切片文本展示模式：全文 / 省略（3 行截断） */
type TextMode = "full" | "ellipse";

/**
 * 切片详情全屏 Sheet（参照 RAGFlow chunk-result 页面设计）。
 *
 * 布局：左侧 40% 文档预览 + 右侧 60% 切片列表。
 * 右侧包含：工具栏（全文/省略切换、搜索）、切片卡片（序号 + 启用开关 + 内容 + 关键词标签）、分页。
 *
 * 切片数据通过 kbApi.listChunks 分页拉取，支持关键词搜索。
 */
export function ChunkDetailSheet({ open, onClose, kbId, resource }: ChunkDetailSheetProps) {
  const { t } = useTranslation(NS.KNOWLEDGE);
  const [data, setData] = useState<KnowledgeChunkListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [textMode, setTextMode] = useState<TextMode>("ellipse");
  const pageSize = 20;

  // ── 拉取切片列表 ──
  const fetchChunks = useCallback(
    async (p: number, kw?: string) => {
      setLoading(true);
      try {
        const result = await unwrap(
          kbApi.listChunks({ kbId, resourceId: resource.id }, { page: p, pageSize, keyword: kw?.trim() || undefined }),
        );
        setData(result);
      } catch (err) {
        console.error("Failed to fetch chunks", err);
        toast.error(t("chunk.fetchFailed"));
      } finally {
        setLoading(false);
      }
    },
    [kbId, resource.id, t],
  );

  // Sheet 打开时重置并拉取第一页
  useEffect(() => {
    if (open) {
      setPage(1);
      setKeyword("");
      setSearchInput("");
      setTextMode("ellipse");
      fetchChunks(1);
    }
  }, [open, fetchChunks]);

  const handleSearch = () => {
    setPage(1);
    setKeyword(searchInput);
    fetchChunks(1, searchInput);
  };

  const handleClearSearch = () => {
    setKeyword("");
    setSearchInput("");
    setPage(1);
    fetchChunks(1);
  };

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
    fetchChunks(newPage, keyword);
  };

  // 切换单个切片启用/禁用：调 RAGFlow PATCH 接口，乐观更新本地状态
  const handleToggleEnabled = async (chunkId: string, enabled: boolean) => {
    if (!data) return;
    // 乐观更新
    setData({
      ...data,
      items: data.items.map((c) => (c.id === chunkId ? { ...c, enabled } : c)),
    });
    try {
      await unwrap(kbApi.switchChunk({ kbId, resourceId: resource.id, chunkId }, { enabled }));
    } catch (err) {
      console.error("Failed to switch chunk", err);
      toast.error(t("chunk.toggleFailed"));
      // 回滚
      setData({
        ...data,
        items: data.items.map((c) => (c.id === chunkId ? { ...c, enabled: !enabled } : c)),
      });
    }
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const hasKeyword = keyword.trim().length > 0;

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full sm:max-w-full p-0 flex flex-col gap-0">
        {/* ── 顶部 Header：文件名（Sheet 右上角自带 X 关闭按钮，无需重复添加） ── */}
        <SheetHeader className="px-6 py-4 border-b border-[#e8edf4] shrink-0 bg-gradient-to-r from-[#fafbfc] to-white pr-12">
          <SheetTitle className="text-[16px] font-bold text-[#0f172a] truncate">{resource.sourceName}</SheetTitle>
          <p className="text-[12px] text-[#94a3b8] mt-0.5">
            {data ? t("chunk.totalCount", { count: data.total }) : ""}
            {hasKeyword && (
              <span className="ml-2 inline-flex items-center gap-1 text-[#6366f1]">
                · {t("chunk.searchFor", { keyword })}
                <button type="button" className="hover:text-[#4f46e5]" onClick={handleClearSearch}>
                  <X className="h-3 w-3" />
                </button>
              </span>
            )}
          </p>
        </SheetHeader>

        {/* ── 主体：双栏布局，左预览右切片 ── */}
        <div className="flex-1 flex min-h-0">
          {/* 左侧：文档预览（40%） */}
          <div className="w-[40%] flex flex-col border-r border-[#e8edf4] min-h-0 bg-white">
            {/* 预览头部 */}
            <div className="px-5 py-4 border-b border-[#eef2f6] shrink-0">
              <h3 className="text-[13px] font-bold text-[#0f172a]">{t("chunk.docPreview")}</h3>
              <p className="text-[11px] text-[#94a3b8] mt-0.5">
                {resource.sourceName} · {t("chunk.chunkCount", { count: resource.chunkCount ?? 0 })}
              </p>
            </div>
            {/* 预览内容 */}
            <div className="flex-1 min-h-0 overflow-hidden">
              {/* 预览组件异步加载 */}
              <SuspensePreviewContent resource={resource} kbId={kbId} />
            </div>
          </div>

          {/* 右侧：切片列表（60%） */}
          <div className="flex-1 flex flex-col min-h-0 bg-[#fafbfd]">
            {/* 工具栏 */}
            <div className="flex items-center gap-3 px-5 py-3 border-b border-[#eef2f6] shrink-0 bg-white">
              {/* 全文 / 省略 切换 */}
              <div className="flex items-center rounded-lg border border-[#e2e8f0] overflow-hidden shrink-0">
                <button
                  type="button"
                  className={`px-3 py-1.5 text-[11px] font-medium transition-colors ${
                    textMode === "ellipse" ? "bg-[#6366f1] text-white" : "text-[#64748b] hover:bg-[#f1f5f9]"
                  }`}
                  onClick={() => setTextMode("ellipse")}
                >
                  {t("chunk.ellipse")}
                </button>
                <button
                  type="button"
                  className={`px-3 py-1.5 text-[11px] font-medium transition-colors ${
                    textMode === "full" ? "bg-[#6366f1] text-white" : "text-[#64748b] hover:bg-[#f1f5f9]"
                  }`}
                  onClick={() => setTextMode("full")}
                >
                  {t("chunk.fullText")}
                </button>
              </div>

              {/* 搜索框 */}
              <div className="relative flex-1 max-w-[260px]">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#94a3b8]" />
                <Input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                  placeholder={t("chunk.searchPlaceholder")}
                  className="h-8 pl-9 pr-3 text-[12px] rounded-lg border-[#e2e8f0] focus-visible:ring-[#6366f1]"
                />
              </div>

              <span className="ml-auto text-[11px] text-[#94a3b8] shrink-0">
                {data ? `${data.total} ${t("chunk.chunksUnit")}` : ""}
              </span>
            </div>

            {/* 切片列表 */}
            <div className="flex-1 overflow-auto px-5 py-4 space-y-3 min-h-0">
              {loading && <ChunkListSkeleton />}

              {!loading && data && data.items.length === 0 && (
                <div className="flex flex-col items-center justify-center py-20 gap-2">
                  <Search className="h-8 w-8 text-[#cbd5e1]" />
                  <p className="text-[13px] text-[#94a3b8]">{hasKeyword ? t("chunk.noMatch") : t("chunk.empty")}</p>
                </div>
              )}

              {!loading &&
                data?.items.map((chunk) => (
                  <div
                    key={chunk.id}
                    className="relative rounded-xl border border-[#eef2f6] bg-white p-4 shadow-sm transition-shadow hover:shadow-md"
                  >
                    {/* 卡片头部：序号 + 状态徽章 */}
                    <div className="flex items-center justify-between mb-2.5">
                      <span className="text-[11px] font-bold text-[#6366f1] tabular-nums">#{chunk.chunkIndex}</span>
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                            chunk.enabled ? "bg-emerald-50 text-emerald-600" : "bg-gray-100 text-gray-400"
                          }`}
                        >
                          {chunk.enabled ? t("chunk.enabled") : t("chunk.disabled")}
                        </span>
                        <Switch
                          checked={chunk.enabled}
                          onCheckedChange={(v) => handleToggleEnabled(chunk.id, v)}
                          className="scale-75"
                        />
                      </div>
                    </div>

                    {/* 内容预览（全文 / 省略模式）。
                        RAGFlow 切片内容可能包含 HTML（表格、视频标签、富文本），
                        用 DOMPurify 清洗后渲染，与 RAGFlow chunk-card 行为一致。 */}
                    <div
                      className={`text-[12px] text-[#475569] leading-relaxed break-words [&_video]:max-w-full [&_video]:rounded-lg [&_img]:max-w-full [&_img]:rounded-lg [&_table]:w-full [&_a]:text-[#6366f1] [&_a]:underline ${
                        textMode === "ellipse" ? "line-clamp-3" : ""
                      }`}
                      // biome-ignore lint/security/noDangerouslySetInnerHtml: DOMPurify 已清洗
                      dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(chunk.content) }}
                    />

                    {/* 关键词标签 */}
                    {chunk.importantKeywords.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2.5">
                        {chunk.importantKeywords.map((kw) => (
                          <span
                            key={`${chunk.id}-${kw}`}
                            className="inline-flex items-center rounded-md bg-[#f0f4ff] px-2 py-0.5 text-[10px] font-medium text-[#6366f1]"
                          >
                            {kw}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
            </div>

            {/* 分页器 */}
            {data && data.total > 0 && (
              <div className="flex items-center justify-between px-5 py-3 border-t border-[#eef2f6] shrink-0 bg-white">
                <span className="text-[11px] text-[#94a3b8]">
                  {data.total} {t("chunk.chunksUnit")} · {t("chunk.pageOf", { page, total: totalPages })}
                </span>
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-7 p-0 rounded-lg"
                    disabled={page <= 1}
                    onClick={() => handlePageChange(page - 1)}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <span className="text-[11px] font-medium text-[#64748b] tabular-nums min-w-[40px] text-center">
                    {page}/{totalPages}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-7 p-0 rounded-lg"
                    disabled={page >= totalPages}
                    onClick={() => handlePageChange(page + 1)}
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * 异步加载文档预览内容组件。
 * 用 React.lazy 避免首屏加载 mammoth 等重依赖。
 */
function SuspensePreviewContent({ resource, kbId }: { resource: KnowledgeResourceInfo; kbId: string }) {
  // 使用动态 import 延迟加载预览组件，减少首屏 bundle
  const [PreviewContent, setPreviewContent] = useState<React.ComponentType<{
    resource: KnowledgeResourceInfo;
    kbId: string;
  }> | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // 动态导入预览组件（包含 mammoth 等重依赖）
    import("@/components/knowledge/ResourcePreviewContent")
      .then((mod) => {
        if (!cancelled) setPreviewContent(() => mod.ResourcePreviewContent);
      })
      .catch((err) => {
        console.error("Failed to load preview content", err);
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadError) {
    return <div className="flex-1 flex items-center justify-center text-text-muted text-sm p-4">预览加载失败</div>;
  }

  if (!PreviewContent) {
    return (
      <div className="p-6 space-y-3">
        <Skeleton className="h-4 w-full rounded-md" />
        <Skeleton className="h-4 w-[85%] rounded-md" />
        <Skeleton className="h-4 w-[70%] rounded-md" />
      </div>
    );
  }

  return <PreviewContent resource={resource} kbId={kbId} />;
}

/** 切片列表骨架屏 */
function ChunkListSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 4 }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders, index is stable
        <div key={`skeleton-${i}`} className="rounded-xl border border-[#eef2f6] bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between mb-2.5">
            <Skeleton className="h-3 w-8 rounded" />
            <Skeleton className="h-3 w-12 rounded" />
          </div>
          <Skeleton className="h-3 w-full rounded mb-1.5" />
          <Skeleton className="h-3 w-[90%] rounded mb-1.5" />
          <Skeleton className="h-3 w-[60%] rounded" />
        </div>
      ))}
    </div>
  );
}
