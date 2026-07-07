import { FilePen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { FileTypeIcon } from "@/src/components/file-icon-helper";
import { NS } from "../../i18n";
import type { ChangedFile } from "../../lib/extract-changed-files";

interface ChangedFilesSectionProps {
  /** 变更文件列表，已去重排序 */
  files: ChangedFile[];
}

/**
 * 在 ArtifactsPanel 文件树上方展示本次会话中被 Agent 修改的文件列表。
 * 文件图标按扩展名使用 react-file-icon 渲染，操作类型通过小圆点指示：
 * · edit（修改）橙色，· write（新建/覆盖）绿色。
 * 只显示文件名，hover title 展示完整路径。
 * 无变更时不渲染（返回 null）。
 */
export function ChangedFilesSection({ files }: ChangedFilesSectionProps) {
  const { t } = useTranslation(NS.AGENT_PANEL);

  // 没有变更文件时不渲染，保持界面简洁
  if (files.length === 0) return null;

  return (
    // shrink-0 防止被下方 flex-1 文件树压缩到不可见；无 border 风格，靠间距与文件树分隔
    <div className="shrink-0">
      {/* 标题行 */}
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="text-base font-semibold text-text-primary flex items-center gap-1.5">
          <FilePen className="h-4 w-4" />
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
              className="flex items-center gap-1.5 px-3 py-1 text-base text-text-muted hover:bg-surface-2 cursor-default"
            >
              {/* 文件类型图标 + 操作类型小圆点 */}
              <span className="relative inline-flex flex-shrink-0">
                <span className="h-4 w-4 inline-flex items-center justify-center">
                  <FileTypeIcon filename={fileName} />
                </span>
                <span
                  className={`absolute -right-0.5 -bottom-0.5 w-2 h-2 rounded-full border border-surface-1 ${
                    type === "write" ? "bg-green-500" : "bg-orange-400"
                  }`}
                />
              </span>
              <span className="truncate">{fileName}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
