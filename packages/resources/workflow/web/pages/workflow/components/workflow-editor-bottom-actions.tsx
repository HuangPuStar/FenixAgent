import { Popover, PopoverContent, PopoverTrigger } from "@fenix/ui-components/ui/popover";
import { Download, List, RefreshCw, Rocket, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WfMeta } from "../yaml-utils";
import { PopoverHeader } from "./PopoverHeader";
import { VersionIndicator } from "./VersionIndicator";
import { WorkflowMetaPopover } from "./WorkflowMetaPopover";

/**
 * 画布右下角的动作组：文件导入导出、工作流元数据、运行记录开关、版本指示器、发布、刷新草稿。
 *
 * 从 `WorkflowEditor.tsx` 抽出（它是编辑器渲染里最大的一块）。这里只有「按钮按下时通知谁」，
 * 没有取数：导入用的隐藏 `<input type="file">` 与文件菜单是同一个单元（同一个 ref、同一次点击链条），
 * 所以一起放在本组件里，不留在编辑器根部。
 *
 * 三个纯 UI 开关（文件菜单、元数据弹层）自持；需要跨组件协作的状态（运行记录侧栏、版本管理 Sheet、
 * 发布确认弹窗）仍由编辑器持有，经回调注入。
 */
export interface WorkflowEditorBottomActionsProps {
  workflowId?: string;
  /** 运行中 / 版本预览态下的只读 */
  readOnly: boolean;
  previewVersion: number | null;
  /** 已发布的最新版本号（无发布记录时显示「未发布」） */
  latestVersion: number | null;
  publishing: boolean;
  isRunMode: boolean;
  isRunDone: boolean;
  runSheetOpen: boolean;
  meta: WfMeta;
  updateMeta: (updates: Partial<WfMeta>) => void;
  handleFileImport: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleExportYaml: () => void;
  onToggleRunSheet: () => void;
  onViewAllVersions: () => void;
  onPreviewVersion: (version: number) => Promise<void>;
  onBackToDraft: () => Promise<void>;
  onPublishRequest: () => void;
  onRefreshDraft: () => Promise<void>;
}

export function WorkflowEditorBottomActions({
  workflowId,
  readOnly,
  previewVersion,
  latestVersion,
  publishing,
  isRunMode,
  isRunDone,
  runSheetOpen,
  meta,
  updateMeta,
  handleFileImport,
  handleExportYaml,
  onToggleRunSheet,
  onViewAllVersions,
  onPreviewVersion,
  onBackToDraft,
  onPublishRequest,
  onRefreshDraft,
}: WorkflowEditorBottomActionsProps) {
  const { t } = useTranslation("workflows");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [filePopoverOpen, setFilePopoverOpen] = useState(false);
  const [metaPopoverOpen, setMetaPopoverOpen] = useState(false);

  return (
    <div className="wf-bottom-actions">
      <input
        ref={fileInputRef}
        type="file"
        accept=".yaml,.yml"
        onChange={handleFileImport}
        style={{ display: "none" }}
      />

      {/* 文件操作菜单 */}
      <Popover open={filePopoverOpen} onOpenChange={setFilePopoverOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="wf-meta-trigger-btn" title={t("editor.tooltip_file_menu")}>
            <Upload size={14} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={16}
          className="wf-meta-popover"
          style={{ width: 180 }}
        >
          <PopoverHeader title={t("editor.file_menu_title")} />
          <div className="flex flex-col gap-0.5 py-1">
            <button
              type="button"
              className="wf-dropdown-item"
              onClick={() => {
                fileInputRef.current?.click();
                setFilePopoverOpen(false);
              }}
            >
              <Upload size={14} />
              <span>{t("editor.import_yaml")}</span>
            </button>
            <button
              type="button"
              className="wf-dropdown-item"
              onClick={() => {
                handleExportYaml();
                setFilePopoverOpen(false);
              }}
            >
              <Download size={14} />
              <span>{t("editor.export_yaml")}</span>
            </button>
          </div>
        </PopoverContent>
      </Popover>

      {/* 工作流元数据 Popover（齿轮） */}
      <WorkflowMetaPopover
        open={metaPopoverOpen}
        onOpenChange={setMetaPopoverOpen}
        readOnly={readOnly}
        meta={meta}
        updateMeta={updateMeta}
      />

      {/* 运行记录侧栏开关：原来用 Popover 浮窗，与 run mode 下的右侧栏重复。
          统一为开关侧栏，运行状态/历史/事件/输出都在侧栏里。 */}
      <button
        type="button"
        className={`wf-meta-trigger-btn ${runSheetOpen ? "active" : ""}`}
        title={t("editor.tooltip_run_history")}
        onClick={onToggleRunSheet}
      >
        <List size={14} />
      </button>

      {/* 版本指示器 */}
      <VersionIndicator
        workflowId={workflowId}
        latestVersion={latestVersion}
        previewVersion={previewVersion}
        onPreview={onPreviewVersion}
        onBackToDraft={onBackToDraft}
        onViewAll={onViewAllVersions}
      />

      {/* 发布按钮：复用 handlePublish，ConfirmDialog 二次确认 */}
      {workflowId && (
        <button
          type="button"
          className="wf-meta-trigger-btn"
          disabled={!workflowId || publishing || readOnly}
          title={t("editor.tooltip_publish")}
          onClick={onPublishRequest}
          style={{
            width: 32,
            background: publishing ? "#d1d5db" : "#22c55e",
            color: "#fff",
            borderColor: publishing ? "#d1d5db" : "#22c55e",
          }}
        >
          <Rocket size={14} />
        </button>
      )}

      {/* 刷新草稿 */}
      {workflowId && (
        <button
          type="button"
          className="wf-meta-trigger-btn"
          disabled={isRunMode && !isRunDone}
          title={t("editor.tooltip_refresh")}
          onClick={onRefreshDraft}
        >
          <RefreshCw size={14} />
        </button>
      )}
    </div>
  );
}
