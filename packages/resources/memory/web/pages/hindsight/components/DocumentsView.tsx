import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { Badge } from "@fenix/ui-components/ui/badge";
import { Button } from "@fenix/ui-components/ui/button";
import { Input } from "@fenix/ui-components/ui/input";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@fenix/ui-components/ui/table";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useRequest } from "ahooks";
import { Loader2, Search, Trash2, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { hindsightApi } from "../../../api/hindsight";
import { toHindsightFailure } from "../failure";
import { HindsightFailureNotice } from "./HindsightFailureNotice";

const PAGE_SIZE = 20;

export function DocumentsView() {
  const { t } = useTranslation(NS.HINDSIGHT);

  // 筛选与分页（列表数据本身由下面的 `useRequest` 持有，不再手写 `documents` / `total` / `loading`）
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);

  // 上传中标记
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** 文档列表取数：检索词 / 页码变化即重查（等价于改造前那个依赖 `[search, page]` 的 `useEffect`）。 */
  const {
    data: documentsPage,
    loading,
    error: documentsError,
    refresh: refreshDocuments,
  } = useRequest(
    () =>
      hindsightApi.listDocuments({
        q: search || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
    {
      refreshDeps: [search, page],
      onError: (err) => {
        console.error("Failed to load documents:", err);
        toast.error(err instanceof Error ? err.message : t("documents.loadFailed"));
      },
    },
  );

  const documents = documentsPage && Array.isArray(documentsPage.items) ? documentsPage.items : [];
  const total = typeof documentsPage?.total === "number" ? documentsPage.total : 0;
  // 失败态是独立分支（下面的 `[role="alert"]` 块）：`documents` 在失败时为 `[]`，
  // 若不给它分支，界面会渲染成「暂无文档」——把取数失败伪装成空数据（§3.4 禁止）。
  const documentsFailure = documentsError ? toHindsightFailure(documentsError, t("documents.loadFailed")) : null;

  const totalPages = Math.ceil(total / PAGE_SIZE);

  /** 搜索时重置分页 */
  const handleSearch = () => {
    setPage(0);
    // page 是列表请求的 refreshDeps，变更即触发重查
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
      refreshDocuments();
    } catch (err) {
      console.error("Failed to upload document:", err);
      toast.error(err instanceof Error ? err.message : t("documents.uploadFailed"));
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
      refreshDocuments();
    } catch (err) {
      console.error("Failed to delete document:", err);
      toast.error(err instanceof Error ? err.message : t("documents.deleteFailed"));
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
          <Spinner size="sm" className="flex py-12" />
        ) : documentsFailure ? (
          <HindsightFailureNotice
            failure={documentsFailure}
            titleKey="documents.loadFailed"
            retryKey="documents.retry"
            onRetry={refreshDocuments}
            className="py-12"
          />
        ) : documents.length === 0 ? (
          <EmptyState className="py-12" title={t("documents.noDocuments")} />
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
                        <Badge key={tag} variant="outline" className="text-3xs px-1 py-0">
                          {tag}
                        </Badge>
                      ))}
                      {doc.tags.length > 3 && (
                        <Badge variant="outline" className="text-3xs px-1 py-0">
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
