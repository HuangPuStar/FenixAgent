import { FilePen, FilePlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NS } from "../../i18n";
import type { ChangedFile } from "../../lib/extract-changed-files";

interface ChangedFilesSectionProps {
  /** 变更文件列表，已去重排序 */
  files: ChangedFile[];
}

/**
 * 在 ArtifactsPanel 文件树下方展示本次会话中被 Agent 修改的文件列表。
 * edit（修改）显示橙色图标，write（新建/覆盖）显示绿色图标。
 * 只显示文件名，hover title 展示完整路径。
 * 无变更时不渲染（返回 null）。
 */
export function ChangedFilesSection({ files }: ChangedFilesSectionProps) {
  const { t } = useTranslation(NS.AGENT_PANEL);

  // 没有变更文件时不渲染，保持界面简洁
  if (files.length === 0) return null;

  return (
    // shrink-0 防止被上方 flex-1 文件树压缩到不可见
    <div className="border-t border-border shrink-0">
      {/* 标题行 */}
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="text-xs text-text-primary flex items-center gap-1">
          <FilePen className="h-3 w-3" />
          {t("changedFiles.title")}
        </span>
        {/* 文件数徽章 */}
        <span className="text-xs text-text-muted bg-surface-2 px-1.5 py-0.5 rounded-full leading-none">
          {t("changedFiles.count", { count: files.length })}
        </span>
      </div>

      {/* 文件列表，最多显示 10 条，超出可滚动 */}
      <ul className="pb-2 max-h-[160px] overflow-y-auto">
        {files.map(({ path, type }) => {
          const fileName = path.split("/").pop() ?? path;
          return (
            <li
              key={path}
              title={path}
              className="flex items-center gap-1.5 px-3 py-0.5 text-xs text-text-muted hover:bg-surface-2 cursor-default"
            >
              {/* edit 橙色（修改已有文件），write 绿色（新建/覆盖） */}
              {type === "write" ? (
                <FilePlus className="h-3 w-3 shrink-0 text-green-500" />
              ) : (
                <FilePen className="h-3 w-3 shrink-0 text-orange-400" />
              )}
              <span className="truncate">{fileName}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
