/**
 * FilePickerPanel — 会话附件选择面板（目录浏览 + 上传）。
 *
 * 来源：逐字复制 `packages/agent-runtime/web/components/chat/FilePickerPanel.tsx`（JSX 与类名不变）。
 * 纯化改动点：
 * - `ahooks` 的 `useRequest` 移除，改为内部 `useState` + `useRef` 管理请求生命周期
 *   （保留源语义：手动触发、loading/error 状态、上传成功回到文件所在目录）。
 * - `fsApi.listDir` / `uploadChatFiles` 直连改为 `listDir` / `uploadFiles` 回调注入；
 *   `envId` prop 随之删除（宿主在回调里闭包环境 ID）。
 * - 宿主 `ApiError` 改为结构判定（`isApiErrorLike`），包内不依赖宿主错误类。
 * - i18n 收敛到 `UI_COMPONENTS_NS`（键前缀 `chat.components.`）。
 */

import { ArrowLeft, ChevronRight, Folder, Loader2, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileTypeIcon } from "../../components/file-icon-helper";
import { cn } from "../../lib/cn";
import { UI_COMPONENTS_NS } from "../../lib/i18n";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";

/**
 * 文件条目。逐字复制宿主 `apps/web/src/types/index.ts` 的 `FileInfo`
 * （包内 `../types` 未收录文件系统域类型，集成阶段可上收）。
 */
export interface FileInfo {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
  modifiedAt: number;
}

/** 目录列表响应。逐字复制宿主 `FileListResponse`（`apps/web/src/types/index.ts`）。 */
export interface FileListResponse {
  entries: FileInfo[];
}

/** 上传响应。逐字复制宿主 `apps/web/src/api/fs.ts` 内部类型 `FileUploadResponse`（未导出）。 */
export interface FileUploadResponse {
  files: Array<{ name: string; path: string; size: number }>;
}

/** FilePickerPanel 属性。复制自源 `FilePickerPanel.tsx`，`envId` 由注入回调取代。 */
export interface FilePickerPanelProps {
  /**
   * 列出 workspace 指定目录（空字符串表示 workspace 根）。
   * 宿主注入示例：`(dir) => unwrap(fsApi.listDir(envId, dir || undefined))`。
   */
  listDir: (dirPath: string) => Promise<FileListResponse>;
  /** 上传文件到用户文件区域。宿主注入示例：`(files) => uploadChatFiles(envId, files)`。 */
  uploadFiles: (files: File[]) => Promise<FileUploadResponse>;
  onSelect: (file: FileInfo) => void;
  onClose: () => void;
  className?: string;
}

/**
 * 结构判定宿主 `ApiError`（`apps/web/src/api/request.ts` 的实例携带 `code`）。
 * 包内不 import 宿主错误类，仅按 `code` 存在性区分"服务端错误"与"未知错误"。
 */
function isApiErrorLike(error: unknown): error is { code?: string; message: string } {
  return typeof error === "object" && error !== null && "code" in error;
}

/** 读取错误文案，非 Error 时返回空串（调用方用 i18n 兜底）。 */
function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

/** 格式化文件体积。复制自源 `FilePickerPanel.tsx`；纯化改动点：无。 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 会话附件选择面板：面包屑目录浏览、搜索过滤、上传与体积校验。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/FilePickerPanel.tsx`；纯化改动点见文件头。
 */
export function FilePickerPanel({ listDir, uploadFiles, onSelect, onClose, className }: FilePickerPanelProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const [currentDir, setCurrentDir] = useState<string>("");
  const [dirStack, setDirStack] = useState<string[]>([]);
  const [searchFilter, setSearchFilter] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── 目录列表加载（替代 ahooks useRequest 的 manual 模式）──
  const [dirData, setDirData] = useState<FileListResponse | null>(null);
  const [dirLoading, setDirLoading] = useState(false);
  const [dirError, setDirError] = useState<unknown>(null);
  // 竞态保护：只接受最后一次请求的结果（快速切换目录时丢弃过期响应）
  const requestSeqRef = useRef(0);
  // 回调存 ref：宿主传入内联函数时 loadDir 身份仍稳定，避免 mount effect 反复重置面板状态
  const listDirRef = useRef(listDir);
  const uploadFilesRef = useRef(uploadFiles);
  useEffect(() => {
    listDirRef.current = listDir;
    uploadFilesRef.current = uploadFiles;
  }, [listDir, uploadFiles]);

  const loadDir = useCallback(async (dirPath: string) => {
    const seq = ++requestSeqRef.current;
    setDirLoading(true);
    setDirError(null);
    try {
      const data = await listDirRef.current(dirPath);
      if (seq !== requestSeqRef.current) return;
      setDirData(data);
    } catch (error) {
      if (seq !== requestSeqRef.current) return;
      setDirData(null);
      setDirError(error);
    } finally {
      if (seq === requestSeqRef.current) setDirLoading(false);
    }
  }, []);

  const entries = dirData?.entries ?? [];
  const loadError = dirError
    ? isApiErrorLike(dirError)
      ? dirError.message
      : t("chat.components.filePicker.loadFailed")
    : null;
  const error = uploadError || loadError;
  const loading = dirLoading;

  // mount 时加载根目录并重置状态
  useEffect(() => {
    setDirStack([]);
    setSearchFilter("");
    setUploadError(null);
    void loadDir("");
    setCurrentDir("");
  }, [loadDir]);

  const handleEnterDir = useCallback(
    (dir: FileInfo) => {
      const relativePath = dir.path.endsWith("/") ? dir.path.slice(0, -1) : dir.path;
      setDirStack((prev) => [...prev, currentDir]);
      void loadDir(relativePath);
      setCurrentDir(relativePath);
    },
    [currentDir, loadDir],
  );

  const handleGoBack = useCallback(() => {
    const prevDir = dirStack[dirStack.length - 1];
    setDirStack((stack) => stack.slice(0, -1));
    const target = prevDir || "";
    void loadDir(target);
    setCurrentDir(target);
  }, [dirStack, loadDir]);

  // ── 上传（替代 ahooks useRequest 的 manual 模式）──
  const [uploadLoading, setUploadLoading] = useState(false);

  // Chat 上传固定进入用户文件区域；当前浏览目录仅用于选择已有文件。
  const runUpload = useCallback(
    async (files: File[]) => {
      setUploadLoading(true);
      try {
        const uploaded = await uploadFilesRef.current(files);
        setUploadError(null);
        const uploadedPath = uploaded.files[0]?.path ?? "";
        const targetDir = uploadedPath.includes("/") ? uploadedPath.slice(0, uploadedPath.lastIndexOf("/")) : "";
        setDirStack([]);
        setCurrentDir(targetDir);
        await loadDir(targetDir);
      } catch (err) {
        if (isApiErrorLike(err) && err.code === "payload_too_large") {
          setUploadError(t("chat.components.filePicker.uploadTooLarge"));
        } else {
          setUploadError(readErrorMessage(err) || t("chat.components.filePicker.uploadFailed"));
        }
      } finally {
        setUploadLoading(false);
      }
    },
    [loadDir, t],
  );

  const handleUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!e.target?.files?.length) {
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
      const files = Array.from(e.target.files);

      // 客户端提前校验单文件大小
      const maxSize = 100 * 1024 * 1024;
      for (const file of files) {
        if (file.size > maxSize) {
          setUploadError(t("chat.components.filePicker.fileTooLarge", { name: file.name, max: "100MB" }));
          if (fileInputRef.current) fileInputRef.current.value = "";
          return;
        }
      }

      // 校验总上传量，超过 100MB 全局限制时给出明确提示
      const totalSize = files.reduce((sum, f) => sum + f.size, 0);
      if (totalSize > maxSize) {
        const sizeStr =
          totalSize > 1024 * 1024 * 1024
            ? `${(totalSize / (1024 * 1024 * 1024)).toFixed(1)} GB`
            : `${(totalSize / (1024 * 1024)).toFixed(1)} MB`;
        setUploadError(t("chat.components.filePicker.totalTooLarge", { total: sizeStr, max: "100MB" }));
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }

      void runUpload(files);
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
      <div className="flex items-center gap-2 px-4 py-2">
        <Input
          type="text"
          placeholder={t("chat.components.filePicker.searchPlaceholder")}
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
          title={t("chat.components.filePicker.uploadFile")}
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
          <div className="px-2 py-4 text-center text-sm text-text-muted">{t("chat.components.filePicker.noFiles")}</div>
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
