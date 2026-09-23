import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@fenix/ui-components/ui/sheet";
import { useTranslation } from "react-i18next";
import { type ParamDef, RunParamsDialog } from "./RunParamsDialog";
import { TriggerPanel } from "./TriggerPanel";
import { VersionPanel } from "./VersionPanel";

/**
 * 编辑器的五个浮层：版本管理 Sheet、触发器 Sheet、运行参数对话框、删除节点确认、发布确认。
 *
 * 它们与画布内容无关（不在 ReactFlow 子树里），只在特定状态下出现，因此与画布、工具栏分开。
 * **渲染顺序保持拆分前的原样**：Sheet 与确认弹窗的门控逻辑不同（删除确认刻意放在 Sheet 外层，
 * 避免被 outside-click 连带卸载），同屏出现时的层级依赖这个顺序，不要重排。
 *
 * 开关状态（`versionsSheetOpen` / `triggersSheetOpen` / `paramsDialogOpen` / `deleteConfirmNodeId` /
 * `publishConfirmOpen`）仍由编辑器持有：它们会被编辑器里别的动作联动（如「查看全部版本」同时关掉运行
 * 记录侧栏、删除确认由 Sheet 头部与画布删除两条入口触发），放在这里会割裂那条联动。
 *
 * 触发器 Sheet 当前没有打开入口（触发器的管理按钮已从工具栏移除，保留 Sheet 与 `TriggerPanel`），
 * 由 `__tests__/trigger-panel.test.tsx` 钉住它仍挂在编辑器的渲染树里。
 */
export interface WorkflowEditorOverlaysProps {
  workflowId?: string;
  versionsSheetOpen: boolean;
  setVersionsSheetOpen: (open: boolean) => void;
  triggersSheetOpen: boolean;
  setTriggersSheetOpen: (open: boolean) => void;
  /** 版本面板的发布动作与状态（与右下角发布按钮共用同一份） */
  handlePublish: () => Promise<void>;
  publishing: boolean;
  /** 运行参数：仅当工作流声明了 params 时该对话框才会挂载（与拆分前一致） */
  hasParams?: boolean;
  paramsDialogOpen: boolean;
  setParamsDialogOpen: (open: boolean) => void;
  params: Record<string, ParamDef>;
  onParamsSubmit: (values: Record<string, unknown>) => void;
  /** 删除节点确认：null 表示未在确认；按节点 id 传回给删除实现 */
  deleteConfirmNodeId: string | null;
  setDeleteConfirmNodeId: (nodeId: string | null) => void;
  handleDeleteNode: (nodeId: string) => void;
  publishConfirmOpen: boolean;
  setPublishConfirmOpen: (open: boolean) => void;
  /** 已发布的最新版本号，用于发布确认里的「当前 vN / 未发布」 */
  latestVersion: number | null;
}

export function WorkflowEditorOverlays({
  workflowId,
  versionsSheetOpen,
  setVersionsSheetOpen,
  triggersSheetOpen,
  setTriggersSheetOpen,
  handlePublish,
  publishing,
  hasParams,
  paramsDialogOpen,
  setParamsDialogOpen,
  params,
  onParamsSubmit,
  deleteConfirmNodeId,
  setDeleteConfirmNodeId,
  handleDeleteNode,
  publishConfirmOpen,
  setPublishConfirmOpen,
  latestVersion,
}: WorkflowEditorOverlaysProps) {
  const { t } = useTranslation("workflows");

  return (
    <>
      {/* 版本管理 Sheet */}
      <Sheet open={versionsSheetOpen} onOpenChange={setVersionsSheetOpen}>
        <SheetContent side="right" style={{ width: 360, maxWidth: 360, padding: 0 }}>
          <SheetHeader>
            <SheetTitle>{t("editor.version_management")}</SheetTitle>
          </SheetHeader>
          <div className="wf-sheet-body">
            <VersionPanel
              workflowId={workflowId}
              onClose={() => setVersionsSheetOpen(false)}
              onPublish={handlePublish}
              publishing={publishing}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* 触发器 Sheet */}
      <Sheet open={triggersSheetOpen} onOpenChange={setTriggersSheetOpen}>
        <SheetContent side="right" style={{ width: 360, maxWidth: 360, padding: 0 }}>
          <SheetHeader>
            <SheetTitle>{t("editor.trigger_title")}</SheetTitle>
          </SheetHeader>
          <div className="wf-sheet-body">
            <TriggerPanel workflowId={workflowId} onClose={() => setTriggersSheetOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>

      {/* 运行参数输入对话框 */}
      {hasParams && (
        <RunParamsDialog
          open={paramsDialogOpen}
          onOpenChange={setParamsDialogOpen}
          params={params}
          onSubmit={onParamsSubmit}
        />
      )}

      {/* 节点删除确认：放在顶层（与 Popover/Sheet 同级），生命周期独立于
          NodeConfigPopover，避免被 popover 的 outside-click 关闭连带卸载。 */}
      <ConfirmDialog
        open={deleteConfirmNodeId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteConfirmNodeId(null);
        }}
        title={t("editor.delete_node_tooltip")}
        description={t("editor.delete_node_confirm", { nodeId: deleteConfirmNodeId ?? "" })}
        variant="destructive"
        onConfirm={() => {
          if (deleteConfirmNodeId) {
            handleDeleteNode(deleteConfirmNodeId);
          }
          setDeleteConfirmNodeId(null);
        }}
      />

      {/* 发布确认弹窗 */}
      <ConfirmDialog
        open={publishConfirmOpen}
        onOpenChange={setPublishConfirmOpen}
        title={t("editor.publish_confirm_title")}
        description={t("editor.publish_confirm_desc", {
          latest: latestVersion ? `v${latestVersion}` : t("editor.no_published"),
        })}
        variant="default"
        onConfirm={async () => {
          setPublishConfirmOpen(false);
          await handlePublish();
        }}
      />
    </>
  );
}
