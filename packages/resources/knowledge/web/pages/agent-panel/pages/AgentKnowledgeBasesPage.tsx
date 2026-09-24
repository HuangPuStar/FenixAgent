// web/pages/agent-panel/pages/AgentKnowledgeBasesPage.tsx
// 知识库页面的**壳**：路由 `?kbId=` 的读写、两个整页态（加载骨架 / 无权限）、工作区与各弹窗的装配。
// 页面本身不持有业务状态——详情域在 `use-knowledge-base-detail`、列表与建档域在
// `use-knowledge-base-catalog`（§3.5 第二层），两侧的可见部分各自成组件（`knowledge-base-detail-view`
// 与 `components/` 下的三个弹窗族）。
//
// 2026-09-23 §4.8 拆分：本文件此前 1243 行，把两个域的状态、详情视图、四处确认、导入弹窗、
// 创建 / 编辑表单与错误码映射各自拆了出去；DOM 结构、类名、i18n key、请求与事件顺序未动。

import { AgentMasterDetailWorkspace } from "@fenix/ui-components/components/agent-master-detail-workspace";
import { AppHeader } from "@fenix/ui-components/layout/app-header";
import { AppPage } from "@fenix/ui-components/layout/app-page";
import { Button } from "@fenix/ui-components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { useOrgSession } from "@fenix/web-runtime/contexts/org-session";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Cpu, Download, Plus } from "lucide-react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ResourcePreviewDialog } from "../../../components/knowledge/ResourcePreviewDialog";
import { ChunkDetailSheet } from "../../../src/pages/agent-panel/components/ChunkDetailSheet";
import { EmbeddingModelManager } from "../../../src/pages/agent-panel/components/EmbeddingModelManager";
import { KnowledgeBaseFormDialog } from "../components/knowledge-base-form-dialog";
import { KnowledgeConfirmDialogs } from "../components/knowledge-confirm-dialogs";
import { KnowledgeImportDialog } from "../components/knowledge-import-dialog";
import { AgentKnowledgeAccessDenied, isKnowledgeAccessDenied } from "./agent-knowledge-access-denied";
import { AgentKnowledgeDirectory } from "./agent-knowledge-directory";
import { KnowledgeBaseDetailView } from "./knowledge-base-detail-view";
import { useKnowledgeBaseCatalog } from "./use-knowledge-base-catalog";
import { useKnowledgeBaseDetail } from "./use-knowledge-base-detail";
import "./AgentKnowledgeBasesPage.css";
import "./agent-knowledge.css";

export function AgentKnowledgeBasesPage() {
  const { t } = useTranslation(NS.KNOWLEDGE);
  // 管理权限与「是否本人知识库」都取自 `@fenix/web-runtime` 的 org/session 契约（§1.6 T7）：
  // 实现方是身份包的 `OrgProvider`，契约的 context 实例唯一，故与宿主挂载的是同一份；
  // 本包不依赖平台实现，也不另建组织/会话状态。`isOwner` 已是判定结果，不再比角色字符串。
  const { isOwner } = useOrgSession();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { kbId?: string };
  const kbId = typeof search.kbId === "string" && search.kbId ? search.kbId : null;
  const pushKbId = useCallback(
    (id: string | null) => {
      void navigate({
        to: "/agent/knowledge-bases",
        // 本页不拥有路由定义（`useSearch({ strict: false })`），search 按「不透明键值袋」处理：
        // 显式标注参数类型，否则 TanStack 推断不出而落成隐式 any（TS7006）。
        search: (previous: Record<string, unknown>) => {
          const next = { ...previous };
          if (id) next.kbId = id;
          else delete next.kbId;
          return next;
        },
      });
    },
    [navigate],
  );

  const detail = useKnowledgeBaseDetail({ kbId, pushKbId });
  // 列表域删掉当前选中项时清空路由参数与详情域：两处状态同在一次提交里落下，不会出现
  // 「kbId 已清空、详情还在场」的中间帧（判定详情域已有 `?kbId=` 兜底，这里是显式的同步清空）。
  const handleKnowledgeBaseDeleted = useCallback(() => {
    pushKbId(null);
    detail.clear();
  }, [pushKbId, detail.clear]);
  const catalog = useKnowledgeBaseCatalog({
    kbId,
    onKnowledgeBaseDeleted: handleKnowledgeBaseDeleted,
    onKnowledgeBaseUpdated: detail.applyUpdated,
  });

  // 权限控制：owner 有管理权限
  const canManage = isOwner;

  // 加载中骨架屏
  if (catalog.loading) {
    return (
      <AppPage className="agent-knowledge-page" busy>
        <div className="knowledge-page-header-skeleton">
          <div>
            <Skeleton className="h-7 w-28 rounded-lg" />
            <Skeleton className="mt-2 h-3.5 w-56 rounded-md" />
          </div>
          <Skeleton className="h-9 w-65 rounded-lg" />
        </div>
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => `kb-skeleton-${i}`).map((placeholderKey) => (
            <div
              key={placeholderKey}
              className="knowledge-base-card-skeleton rounded-2xl bg-white ring-1 ring-inset ring-slate-200/80 overflow-hidden"
            >
              <div className="h-1 w-full bg-slate-200" />
              <div className="flex items-center gap-4 p-5 pt-4">
                <Skeleton className="h-14 w-14 rounded-2xl" />
                <div className="flex-1 space-y-2.5">
                  <Skeleton className="h-4 w-3/4 rounded-md" />
                  <Skeleton className="h-3 w-1/2 rounded-md" />
                  <Skeleton className="h-5 w-20 rounded-full" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </AppPage>
    );
  }

  // 无权限（401/403，request 层归一为 UNAUTHORIZED）整页接管：此时列表、目录、详情以及顶部的
  // 创建/导入入口都会被同一守卫拒绝，渲染半个页面只会让用户看到一堆点了没反应的按钮。
  // 判定与原因说明见 agent-knowledge-access-denied.tsx。
  if (isKnowledgeAccessDenied(catalog.listError)) {
    return (
      <AppPage className="agent-knowledge-page">
        <AgentKnowledgeAccessDenied />
      </AppPage>
    );
  }

  return (
    <AppPage className="agent-knowledge-page" busy>
      <AppHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          canManage ? (
            <>
              <Button onClick={catalog.openCreateDialog}>
                <Plus />
                {t("btn.create")}
              </Button>
              <Button onClick={() => catalog.setModelDialogOpen(true)} variant="outline">
                <Cpu />
                {t("toolbar.embeddingModels")}
              </Button>
              <Button onClick={catalog.openImportDialog} variant="outline">
                <Download />
                {t("toolbar.importRagflow")}
              </Button>
            </>
          ) : undefined
        }
      />

      <AgentMasterDetailWorkspace
        className="knowledge-workspace flex-1"
        index={
          <AgentKnowledgeDirectory
            items={catalog.items}
            selectedId={kbId}
            loading={catalog.loading}
            error={catalog.listError}
            canManage={canManage}
            onRetry={catalog.refresh}
            onSelect={detail.handleSelect}
            onDelete={catalog.requestDelete}
          />
        }
      >
        <KnowledgeBaseDetailView
          kbId={kbId}
          detail={detail.selectedDetail}
          resources={detail.resources}
          loading={detail.detailLoading}
          error={detail.detailError}
          tab={detail.tab}
          options={catalog.options}
          canManage={detail.canManageDetail}
          uploading={detail.uploading}
          deletingResourceId={detail.deletingResourceId}
          reparsingResourceId={detail.reparsingResourceId}
          fileInputRef={detail.fileInputRef}
          onTabChange={detail.setTab}
          onRetry={detail.reload}
          onEdit={() => catalog.openEditDialog(detail.selectedDetail)}
          onDelete={() => catalog.requestDelete(catalog.selectedItem)}
          onFilesSelected={detail.handleFilesSelected}
          onOpenChunks={detail.setSelectedChunkResource}
          onToggleEnabled={detail.toggleResourceEnabled}
          onReparse={detail.requestReparse}
          onPreview={detail.setPreviewResource}
          onDeleteResource={detail.requestDeleteResource}
        />
      </AgentMasterDetailWorkspace>

      {/* 向量模型管理弹窗 */}
      <Dialog open={catalog.modelDialogOpen} onOpenChange={catalog.setModelDialogOpen}>
        <DialogContent className="knowledge-model-dialog">
          <DialogHeader className="knowledge-model-dialog__header">
            <DialogTitle className="knowledge-model-dialog__title">
              <span className="knowledge-model-dialog__icon">
                <Cpu />
              </span>
              {t("toolbar.embeddingModelManager")}
            </DialogTitle>
            <DialogDescription>{t("toolbar.embeddingModelDescription")}</DialogDescription>
          </DialogHeader>
          <div className="knowledge-model-dialog__body">
            <EmbeddingModelManager canManage={canManage} inDialog onModelsChanged={catalog.refreshFormOptions} />
          </div>
        </DialogContent>
      </Dialog>

      {/* ===== 创建/编辑弹窗 ===== */}
      <KnowledgeBaseFormDialog
        open={catalog.formOpen}
        onOpenChange={catalog.setFormOpen}
        editing={catalog.editingItem !== null}
        saving={catalog.saving}
        name={catalog.formName}
        onNameChange={catalog.setFormName}
        description={catalog.formDescription}
        onDescriptionChange={catalog.setFormDescription}
        embeddingModel={catalog.formEmbeddingModel}
        onEmbeddingModelChange={catalog.setFormEmbeddingModel}
        parseMethod={catalog.formParseMethod}
        onParseMethodChange={catalog.setFormParseMethod}
        chunkMethod={catalog.formChunkMethod}
        onChunkMethodChange={catalog.setFormChunkMethod}
        pipeline={catalog.formPipeline}
        onPipelineChange={catalog.setFormPipeline}
        options={catalog.options}
        optionsFailed={catalog.formOptionsFailed}
        optionsError={catalog.formOptionsError}
        onRetryOptions={catalog.refreshFormOptions}
        onSubmit={catalog.submitForm}
      />

      <KnowledgeConfirmDialogs
        deleteKnowledgeBase={{
          open: catalog.confirmOpen,
          onOpenChange: catalog.setConfirmOpen,
          target: catalog.deleteTarget,
          onConfirm: catalog.confirmDelete,
        }}
        deleteResource={{
          open: detail.resourceDeleteConfirmOpen,
          onOpenChange: detail.setResourceDeleteConfirmOpen,
          target: detail.resourceDeleteTarget,
          onConfirm: detail.confirmDeleteResource,
        }}
        overwriteUpload={{
          open: detail.overwriteConfirmOpen,
          onOpenChange: detail.setOverwriteConfirmOpen,
          names: detail.overwriteNames,
          onConfirm: detail.confirmOverwriteUpload,
        }}
        reparse={{
          open: detail.reparseConfirmOpen,
          onOpenChange: detail.setReparseConfirmOpen,
          target: detail.reparseTarget,
          deleteOld: detail.reparseDeleteOld,
          onDeleteOldChange: detail.setReparseDeleteOld,
          onConfirm: detail.confirmReparse,
        }}
      />

      {detail.previewResource && kbId && (
        <ResourcePreviewDialog
          open={detail.previewResource !== null}
          onOpenChange={(open) => {
            if (!open) detail.setPreviewResource(null);
          }}
          resource={detail.previewResource}
          kbId={kbId}
        />
      )}

      {/* 切片详情 Sheet */}
      {detail.selectedChunkResource && kbId && (
        <ChunkDetailSheet
          open={detail.selectedChunkResource !== null}
          onClose={() => detail.setSelectedChunkResource(null)}
          kbId={kbId}
          resource={detail.selectedChunkResource}
        />
      )}

      {/* ===== 导入知识库弹窗 ===== */}
      <KnowledgeImportDialog
        open={catalog.importDialogOpen}
        onOpenChange={catalog.setImportDialogOpen}
        loading={catalog.importLoading}
        items={catalog.unassociatedList}
        importingId={catalog.importingRemoteId}
        onRequestImport={catalog.requestImport}
        rename={{
          open: catalog.renameDialogOpen,
          onOpenChange: catalog.setRenameDialogOpen,
          target: catalog.renameTarget,
          value: catalog.renameValue,
          onValueChange: catalog.setRenameValue,
          onConfirm: catalog.confirmRename,
          onCancel: catalog.cancelRename,
        }}
      />
    </AppPage>
  );
}
