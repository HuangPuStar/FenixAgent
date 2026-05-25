import { ArrowLeft, ChevronRight, File, Folder, Loader2, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fileApi } from "@/src/api/sdk";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import type { FileInfo } from "../types";

interface FilePickerDialogProps {
  open: boolean;
  envId: string;
  onClose: () => void;
  onSelect: (file: FileInfo) => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilePickerDialog({ open, envId, onClose, onSelect }: FilePickerDialogProps) {
  const { t } = useTranslation("components");
  const [entries, setEntries] = useState<FileInfo[]>([]);
  const [currentDir, setCurrentDir] = useState<string>("");
  const [dirStack, setDirStack] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadDirectory = useCallback(
    async (dirPath: string) => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await fileApi.listDir({ id: envId }, dirPath ? { path: dirPath } : undefined);
      if (err) {
        setError(err.message ?? t("filePicker.loadFailed"));
      } else {
        setEntries(data?.entries ?? []);
        setCurrentDir(dirPath);
      }
      setLoading(false);
    },
    [envId, t],
  );

  useEffect(() => {
    if (open) {
      setDirStack([]);
      setSearchFilter("");
      loadDirectory("");
    }
  }, [open, loadDirectory]);

  const handleEnterDir = useCallback(
    (dir: FileInfo) => {
      const relativePath = dir.path.endsWith("/") ? dir.path.slice(0, -1) : dir.path;
      setDirStack((prev) => [...prev, currentDir]);
      loadDirectory(relativePath);
    },
    [currentDir, loadDirectory],
  );

  const handleGoBack = useCallback(() => {
    const prevDir = dirStack[dirStack.length - 1];
    setDirStack((stack) => stack.slice(0, -1));
    loadDirectory(prevDir || "");
  }, [dirStack, loadDirectory]);

  const handleUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      setLoading(true);
      setError(null);
      const formData = new FormData();
      for (const file of Array.from(files)) {
        formData.append("files", file);
      }
      const { error: uploadErr } = await fileApi.upload({ id: envId, path: "user" }, formData);
      if (uploadErr) {
        setError(uploadErr.message ?? t("filePicker.uploadFailed"));
      } else {
        await loadDirectory(currentDir);
      }
      setLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [envId, currentDir, loadDirectory, t],
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
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-lg rounded-2xl border-border bg-surface-1 p-0 shadow-2xl overflow-hidden">
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle className="font-display text-lg font-semibold text-text-primary">
            {t("filePicker.title")}
          </DialogTitle>
        </DialogHeader>
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
            className="h-8 w-8 text-text-muted hover:text-brand hover:bg-brand/10"
            title={t("filePicker.uploadFile")}
          >
            <Upload className="h-4 w-4" />
          </Button>
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleUpload} />
        </div>

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

        <div className="max-h-80 overflow-y-auto px-2 pb-2">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
            </div>
          )}
          {error && <div className="px-2 py-4 text-center text-sm text-status-error">{error}</div>}
          {!loading && !error && filteredEntries.length === 0 && (
            <div className="px-2 py-4 text-center text-sm text-text-muted">{t("filePicker.noFiles")}</div>
          )}
          {!loading &&
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
                  <File className="h-4 w-4 text-text-muted flex-shrink-0" />
                )}
                <span className="flex-1 text-sm text-text-primary truncate font-display">{entry.name}</span>
                {entry.type === "file" && <span className="text-xs text-text-muted">{formatFileSize(entry.size)}</span>}
                {entry.type === "dir" && (
                  <ChevronRight className="h-3.5 w-3.5 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
                )}
              </button>
            ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
