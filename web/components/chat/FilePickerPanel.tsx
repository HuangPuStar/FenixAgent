import { useRequest } from "ahooks";
import { ArrowLeft, ChevronRight, Folder, Loader2, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fileApi } from "../../src/api/files";
import { ApiError, unwrap } from "../../src/api/request";
import { FileTypeIcon } from "../../src/components/file-icon-helper";
import { cn } from "../../src/lib/utils";
import type { FileInfo } from "../../src/types";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export interface FilePickerPanelProps {
  envId: string;
  onSelect: (file: FileInfo) => void;
  onClose: () => void;
  className?: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilePickerPanel({ envId, onSelect, onClose, className }: FilePickerPanelProps) {
  const { t } = useTranslation("components");
  const [currentDir, setCurrentDir] = useState<string>("");
  const [dirStack, setDirStack] = useState<string[]>([]);
  const [searchFilter, setSearchFilter] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 目录列表加载
  const {
    data: dirData,
    loading: dirLoading,
    error: dirError,
    run: loadDir,
  } = useRequest((dirPath: string) => unwrap(fileApi.listDir(envId, dirPath || undefined)), { manual: true });

  const entries = dirData?.entries ?? [];
  const loadError = dirError ? (dirError instanceof ApiError ? dirError.message : t("filePicker.loadFailed")) : null;
  const error = uploadError || loadError;
  const loading = dirLoading;

  // mount 时加载根目录并重置状态
  useEffect(() => {
    setDirStack([]);
    setSearchFilter("");
    setUploadError(null);
    loadDir("");
    setCurrentDir("");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleEnterDir = useCallback(
    (dir: FileInfo) => {
      const relativePath = dir.path.endsWith("/") ? dir.path.slice(0, -1) : dir.path;
      setDirStack((prev) => [...prev, currentDir]);
      loadDir(relativePath);
      setCurrentDir(relativePath);
    },
    [currentDir, loadDir],
  );

  const handleGoBack = useCallback(() => {
    const prevDir = dirStack[dirStack.length - 1];
    setDirStack((stack) => stack.slice(0, -1));
    const target = prevDir || "";
    loadDir(target);
    setCurrentDir(target);
  }, [dirStack, loadDir]);

  // 文件上传
  const { run: runUpload, loading: uploadLoading } = useRequest(
    (formData: FormData) => unwrap(fileApi.upload(envId, formData)),
    {
      manual: true,
      onSuccess: () => {
        setUploadError(null);
        loadDir(currentDir);
      },
      onError: (err) => {
        if (err instanceof ApiError && (err as ApiError & { status?: number }).status === 413) {
          setUploadError(t("filePicker.uploadTooLarge"));
        } else {
          setUploadError(err.message || t("filePicker.uploadFailed"));
        }
      },
    },
  );

  const handleUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!e.target?.files?.length) {
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
      const files = e.target.files;

      // 客户端提前校验单文件大小
      const maxSize = 100 * 1024 * 1024;
      for (const file of Array.from(files)) {
        if (file.size > maxSize) {
          setUploadError(t("filePicker.fileTooLarge", { name: file.name, max: "100MB" }));
          if (fileInputRef.current) fileInputRef.current.value = "";
          return;
        }
      }

      const formData = new FormData();
      for (const file of Array.from(files)) {
        formData.append("files", file);
      }
      runUpload(formData);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [runUpload, t],
  );

  const handleItemClick = useCallback(
    (entry: FileInfo) => {
      if (entry.type === "dir") {
        handleEnterDir(entry);
      } else {
        onSelect(entry);
        onClose();
      }
    },
    [handleEnterDir, onSelect, onClose],
  );

  const filteredEntries = searchFilter
    ? entries.filter((e) => e.name.toLowerCase().includes(searchFilter.toLowerCase()))
    : entries;

  return (
    <div className={cn("flex flex-col", className)}>
      {/* 搜索 + 上传按钮 */}
      <div className="flex items-center gap-2 px-4 pb-2">
        <Input
          type="text"
          placeholder={t("filePicker.searchPlaceholder")}
          value={searchFilter}
          onChange={(e) => setSearchFilter(e.target.value)}
          className="flex-1 rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-sm"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadLoading}
          className="h-8 w-8 text-text-muted hover:text-brand hover:bg-brand/10"
          title={t("filePicker.uploadFile")}
        >
          <Upload className="h-4 w-4" />
        </Button>
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleUpload} />
      </div>

      {/* 面包屑（dirStack 非空时显示） */}
      {dirStack.length > 0 && (
        <div className="flex items-center gap-1 px-4 pb-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleGoBack}
            className="h-6 w-6 text-text-muted hover:text-text-primary"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="text-xs text-text-muted font-display">{currentDir || "/"}</span>
        </div>
      )}

      {/* 文件列表 */}
      <div className="max-h-80 overflow-y-auto px-2 pb-2">
        {(loading || uploadLoading) && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
          </div>
        )}
        {error && <div className="px-2 py-4 text-center text-sm text-status-error">{error}</div>}
        {!loading && !uploadLoading && !error && filteredEntries.length === 0 && (
          <div className="px-2 py-4 text-center text-sm text-text-muted">{t("filePicker.noFiles")}</div>
        )}
        {!loading &&
          !uploadLoading &&
          !error &&
          filteredEntries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => handleItemClick(entry)}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left hover:bg-surface-2 transition-colors group"
            >
              {entry.type === "dir" ? (
                <Folder className="h-4 w-4 text-brand flex-shrink-0" />
              ) : (
                <span className="h-4 w-4 flex-shrink-0 inline-flex items-center justify-center">
                  <FileTypeIcon filename={entry.name} />
                </span>
              )}
              <span className="flex-1 text-sm text-text-primary truncate font-display">{entry.name}</span>
              {entry.type === "file" && <span className="text-xs text-text-muted">{formatFileSize(entry.size)}</span>}
              {entry.type === "dir" && (
                <ChevronRight className="h-3.5 w-3.5 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
              )}
            </button>
          ))}
      </div>
    </div>
  );
}
