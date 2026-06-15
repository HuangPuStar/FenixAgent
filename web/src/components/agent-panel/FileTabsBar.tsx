import { ChevronDown, FilePen, FilePlus, PanelLeft, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { NS } from "../../i18n";
import type { ChangedFile } from "../../lib/extract-changed-files";
import { cn } from "../../lib/utils";

/** 可见的 tab 数量上限，超出部分折叠到 +N popover 中（伪多 tab，避免横向滚动溢出） */
const MAX_VISIBLE_TABS = 5;

interface FileTabsBarProps {
  /** 当前打开的文件路径列表，顺序按最近使用倒序（最前是最新的） */
  openFiles: string[];
  /** 当前激活的文件路径；无激活文件时为 null */
  activeFile: string | null;
  /** 本次会话被 Agent 修改的文件列表，用于左侧 badge + popover */
  changedFiles: ChangedFile[];
  /** 文件树 popover 是否展开 */
  fileTreeOpen: boolean;
  /** 文件树 popover 开/关回调（受控） */
  onFileTreeOpenChange: (open: boolean) => void;
  /** 文件树 popover 内容（FileTreeTab 实例，由 ArtifactsPanel 持有 ref） */
  fileTreeContent: ReactNode;
  /** 选中某个 tab（点击 tab 或从 popover 中选） */
  onSelectFile: (path: string) => void;
  /** 关闭某个 tab（点击 tab 上的 ×） */
  onCloseFile: (path: string) => void;
  /** 在变更文件 popover 中点击文件时触发预览 */
  onPreviewChangedFile: (path: string) => void;
}

/**
 * FileTabsBar —— ArtifactsPanel 顶部的文件 tab 栏（VSCode 风格）。
 *
 * 布局从左到右：
 *   1. PanelLeft 按钮 → popover 弹出文件树（受控于 fileTreeOpen / onFileTreeOpenChange）
 *   2. 变更文件 badge（✎N） → popover 展示本次会话被 Agent 修改的文件，点击项可预览
 *   3. 文件 tab 列表：最近打开的文件（伪多 tab，最多 5 个可见，超出折叠到 +N popover）
 *
 * 关闭按钮 hover 才显示，避免视觉噪音；激活 tab 有 surface-2 背景区分。
 */
export function FileTabsBar({
  openFiles,
  activeFile,
  changedFiles,
  fileTreeOpen,
  onFileTreeOpenChange,
  fileTreeContent,
  onSelectFile,
  onCloseFile,
  onPreviewChangedFile,
}: FileTabsBarProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  const { t: tAgentPanel } = useTranslation(NS.AGENT_PANEL);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [changedOpen, setChangedOpen] = useState(false);

  // 前 MAX_VISIBLE_TABS 个直接展示；剩余折叠到 +N popover，避免 tab 栏横向溢出
  const visible = openFiles.slice(0, MAX_VISIBLE_TABS);
  const overflow = openFiles.slice(MAX_VISIBLE_TABS);

  return (
    <div className="flex items-center gap-1 h-10 px-2 border-b border-border/40 flex-shrink-0 bg-surface-1/50">
      {/* 1. 文件树按钮 + popover（受控展开/收起） */}
      <Popover open={fileTreeOpen} onOpenChange={onFileTreeOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "h-7 w-7 flex-shrink-0",
              fileTreeOpen
                ? "text-text-primary bg-surface-2/60"
                : "text-text-muted hover:text-text-primary hover:bg-surface-2/60",
            )}
            title={t("fileTree.showTree")}
            aria-label={t("fileTree.showTree")}
            aria-expanded={fileTreeOpen}
          >
            <PanelLeft className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          // 文件树需要足够空间展示层级结构，宽 384px (w-96)、高 480px
          sideOffset={4}
          className="w-96 p-0"
        >
          {/* 固定高度容器，让内部 FileTreeTab 自己管理滚动；pointer-events-auto 防止 portal 误吞事件 */}
          <div className="h-[480px] flex flex-col pointer-events-auto">{fileTreeContent}</div>
        </PopoverContent>
      </Popover>

      {/* 2. 变更文件 badge + popover（无变更时不渲染） */}
      {changedFiles.length > 0 && (
        <Popover open={changedOpen} onOpenChange={setChangedOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 gap-1.5 flex-shrink-0 text-text-muted hover:text-text-primary hover:bg-surface-2/60"
              title={tAgentPanel("changedFiles.title")}
            >
              <FilePen className="h-3.5 w-3.5 text-orange-400" />
              <span className="text-xs font-mono font-semibold">{changedFiles.length}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-1">
            <div className="px-2 py-1.5 text-[11px] uppercase tracking-widest text-text-muted font-semibold">
              {tAgentPanel("changedFiles.title")}
              <span className="ml-1.5 normal-case tracking-normal font-normal">({changedFiles.length})</span>
            </div>
            <div className="max-h-72 overflow-y-auto">
              {changedFiles.map(({ path, type }) => {
                const fileName = path.split("/").pop() ?? path;
                return (
                  <button
                    key={path}
                    type="button"
                    onClick={() => {
                      onPreviewChangedFile(path);
                      setChangedOpen(false);
                    }}
                    title={path}
                    className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left text-sm text-text-secondary hover:bg-surface-2 hover:text-text-primary rounded-md"
                  >
                    {type === "write" ? (
                      <FilePlus className="h-3.5 w-3.5 shrink-0 text-green-500" />
                    ) : (
                      <FilePen className="h-3.5 w-3.5 shrink-0 text-orange-400" />
                    )}
                    <span className="truncate">{fileName}</span>
                  </button>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      )}

      {/* 分隔符：左侧操作区与 tab 区视觉分隔（始终展示，让 toggle / 变更 badge 与 tab 列表视觉分组） */}
      <span className="chat-composer-divider mx-0.5" />

      {/* 3. 文件 tab 列表 + 折叠 */}
      <div className="flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto scrollbar-none">
        {visible.length === 0 && <span className="text-xs text-text-muted px-2">{t("fileTree.noTabsHint")}</span>}

        {visible.map((path) => {
          const fileName = path.split("/").pop() ?? path;
          const isActive = path === activeFile;
          return (
            <div
              key={path}
              role="button"
              tabIndex={0}
              onClick={() => onSelectFile(path)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectFile(path);
                }
              }}
              className={cn(
                "group flex items-center gap-1 px-2.5 h-7 rounded-md cursor-pointer text-xs whitespace-nowrap flex-shrink-0",
                isActive
                  ? "bg-surface-2 text-text-primary"
                  : "text-text-muted hover:bg-surface-2/60 hover:text-text-primary",
              )}
              title={path}
            >
              <span className="truncate max-w-[140px]">{fileName}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseFile(path);
                }}
                className="h-4 w-4 flex items-center justify-center rounded hover:bg-surface-3 opacity-0 group-hover:opacity-100 transition-opacity"
                aria-label={t("fileTree.closeTab")}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}

        {/* 超出上限的 tab 折叠到 +N popover */}
        {overflow.length > 0 && (
          <Popover open={overflowOpen} onOpenChange={setOverflowOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs gap-1 flex-shrink-0 text-text-muted hover:text-text-primary hover:bg-surface-2/60"
                title={t("fileTree.moreTabs", { count: overflow.length })}
              >
                +{overflow.length}
                <ChevronDown className="h-3 w-3" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 p-1">
              <div className="max-h-72 overflow-y-auto">
                {overflow.map((path) => {
                  const fileName = path.split("/").pop() ?? path;
                  const isActive = path === activeFile;
                  return (
                    <button
                      key={path}
                      type="button"
                      onClick={() => {
                        onSelectFile(path);
                        setOverflowOpen(false);
                      }}
                      title={path}
                      className={cn(
                        "w-full flex items-center justify-between gap-2 px-2 py-1.5 text-left text-sm rounded-md",
                        isActive
                          ? "bg-surface-2 text-text-primary"
                          : "text-text-secondary hover:bg-surface-2 hover:text-text-primary",
                      )}
                    >
                      <span className="truncate">{fileName}</span>
                      {isActive && <span className="h-1.5 w-1.5 rounded-full bg-brand flex-shrink-0" aria-hidden />}
                    </button>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>
    </div>
  );
}
