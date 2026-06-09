import { Loader2, Search, Trash2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { hindsightApi } from "@/src/api/hindsight";
import { NS } from "@/src/i18n";

import type { DocumentItem } from "../types";

const PAGE_SIZE = 20;

export function DocumentsView() {
  const { t } = useTranslation(NS.HINDSIGHT);

  // 列表状态
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  // 筛选与分页
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);

  // 上传中标记
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  /** 加载文档列表 */
  const loadDocuments = useCallback(async () => {
    setLoading(true);
    try {
      const res = await hindsightApi.listDocuments({
        q: search || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setDocuments(res.items);
      setTotal(res.total);
    } catch (err) {
      console.error("Failed to load documents:", err);
      toast.error(err instanceof Error ? err.message : "Failed to load documents");
    } finally {
      setLoading(false);
    }
  }, [search, page]);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  /** 搜索时重置分页 */
  const handleSearch = () => {
    setPage(0);
    // loadDocuments 会因 page 变化自动触发
  };

  /** 清空搜索 */
  const handleClearSearch = () => {
    setSearch("");
    setPage(0);
  };

  /** 上传文档 */
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      await hindsightApi.uploadDocument(file);
      toast.success(t("documents.uploadSuccess"));
      loadDocuments();
    } catch (err) {
      console.error("Failed to upload document:", err);
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      // 重置 file input，允许重复选择同一文件
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  /** 删除文档 */
  const handleDelete = async (id: string) => {
    try {
      await hindsightApi.deleteDocument(id);
      toast.success(t("documents.delete"));
      loadDocuments();
    } catch (err) {
      console.error("Failed to delete document:", err);
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* 工具栏：搜索 + 上传 */}
      <div className="flex items-center gap-3 px-4 py-3 border-b">
        {/* 搜索框 */}
        <div className="flex items-center gap-1 flex-1 max-w-sm">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("documents.search")}
              className="pl-8 h-8"
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            />
          </div>
          {search && (
            <Button variant="ghost" size="icon-xs" onClick={handleClearSearch}>
              <X className="size-3.5" />
            </Button>
          )}
        </div>

        {/* 上传按钮 */}
        <Button variant="outline" size="sm" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
          {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
          {t("documents.upload")}
        </Button>
        <input ref={fileInputRef} type="file" className="hidden" onChange={handleUpload} />
      </div>

      {/* 总数 */}
      <div className="px-4 py-2 text-xs text-muted-foreground border-b">
        {t("documents.totalCount", { count: total })}
      </div>

      {/* 文档表格 */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : documents.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
            {t("documents.noDocuments")}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[35%]">{t("documents.title")}</TableHead>
                <TableHead className="w-[15%]">{t("memories.createdAt")}</TableHead>
                <TableHead className="w-[10%]">{t("documents.chunks")}</TableHead>
                <TableHead className="w-[10%]">{t("documents.memoryUnits")}</TableHead>
                <TableHead className="w-[20%]">{t("memories.tags")}</TableHead>
                <TableHead className="w-[10%] text-right">{t("documents.delete")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {documents.map((doc) => (
                <TableRow key={doc.document_id}>
                  {/* 标题 */}
                  <TableCell>
                    <p className="truncate whitespace-nowrap">{doc.title}</p>
                  </TableCell>
                  {/* 创建时间 */}
                  <TableCell className="text-xs text-muted-foreground">
                    {doc.created_at ? new Date(doc.created_at).toLocaleDateString() : "—"}
                  </TableCell>
                  {/* 分块数 */}
                  <TableCell className="text-xs">{doc.chunk_count}</TableCell>
                  {/* 记忆单元数 */}
                  <TableCell className="text-xs">{doc.memory_unit_count}</TableCell>
                  {/* 标签 */}
                  <TableCell>
                    <div className="flex flex-wrap gap-0.5">
                      {doc.tags.slice(0, 3).map((tag) => (
                        <Badge key={tag} variant="outline" className="text-[10px] px-1 py-0">
                          {tag}
                        </Badge>
                      ))}
                      {doc.tags.length > 3 && (
                        <Badge variant="outline" className="text-[10px] px-1 py-0">
                          +{doc.tags.length - 3}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  {/* 删除 */}
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon-xs" onClick={() => handleDelete(doc.document_id)}>
                      <Trash2 className="size-3.5 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-2 border-t text-sm">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            {t("common:previous", { defaultValue: "Previous" })}
          </Button>
          <span className="text-muted-foreground text-xs">
            {page + 1} / {totalPages}
          </span>
          <Button variant="outline" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>
            {t("common:next", { defaultValue: "Next" })}
          </Button>
        </div>
      )}
    </div>
  );
}
