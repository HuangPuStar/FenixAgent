// pages/list/workflow-list-page.tsx
// 列表页：`/agent/workflow` 渲染的页面（设计 §6.2 的「列表页」行）。职责是**编排**：
// ① 取数（列表 + 租户 App 绑定，二者同批）；② 分派视图状态（骨架 / 空 / 失败+重试 / 无权限 / 上游未就绪 /
// 表格）；③ 装配四个动作（新建 → 打开画布、重命名、删除确认、初始化工作流空间）与结果提示；④ 分页。
//
// 列表与绑定**必须一起判**：未绑定租户 App 时列表可能仍有历史记录，但那些工作流在上游没有归属、打开必然
// 失败——渲染成表格比空表更糟（用户点开才发现坏掉）。因此绑定探测失败与列表取数失败同处理：这一屏没准备好。
//
// 未绑定态的「初始化工作流空间」是这一屏**唯一的自愈入口**（`POST /org-app`，幂等）：没有它，未绑定的组织
// 只能永久停在这一屏（重试只重新探测，改变不了未绑定这个事实）。它同样只经 `list.refresh()` 收口——绑定与
// 列表是同一次取数的两半，界面上不能一半新一半旧。
//
// 刷新失败按「整屏失败 + 重试」处理（与画布宿主页同款）：瞬时失败不静默吞掉，也不把上一次的数据继续当作
// 当前事实——用户手里的重试就是恢复动作。
//
// 动作语义：新建成功后直接进画布（新工作流一定是空画布，停在列表上没有可看的信息，旧列表页的「创建并编辑」
// 同款）；初始化失败留在弹窗里（保住已填的名称并给行内提示）；重命名失败留在弹窗里保住输入；删除的
// **三种结局**（删掉 / 被上游策略拒绝 / 请求失败）分别给提示，被拒绝时记录仍在列表里，不刷新也不假装删掉了
// （冻结 §4.3）。

import { Button } from "@fenix/ui-components/ui/button";
import { Pagination } from "@fenix/ui-components/ui/pagination";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useNavigate } from "@tanstack/react-router";
import { useRequest } from "ahooks";
import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { createOrgApp, fetchOrgAppBinding } from "../../api/canvas-session";
import {
  createWorkflow,
  deleteWorkflow,
  fetchWorkflows,
  updateWorkflow,
  type WorkflowV2WorkflowItem,
} from "../../api/workflows";
import { WORKFLOW_NS } from "../../i18n/namespace";
import {
  WorkflowCreateDialog,
  type WorkflowCreateFormValues,
  WorkflowDeleteDialog,
  WorkflowRenameDialog,
  type WorkflowRenameFormValues,
} from "./workflow-list-dialogs";
import {
  deleteRefusalKey,
  initializeErrorKey,
  LIST_I18N_SCOPE,
  LIST_PAGE_SIZE,
  resolveDeleteOutcome,
  resolveListViewState,
} from "./workflow-list-model";
import { WorkflowListSkeleton, WorkflowListStatusView } from "./workflow-list-status-views";
import { WorkflowListTable } from "./workflow-list-table";

/**
 * 页面级提示：删除的三种结局 + 初始化失败。删除被上游拒绝时**记录仍在**，所以这条提示是用户唯一的解释来源
 * （页面上没有 toast：本包不依赖宿主 `<Toaster>`，提示必须落在页面里）。
 *
 * 初始化（一键动作，没有弹窗承载失败）同样落在这里：点击即发请求，失败后按钮旁边的状态块必须能解释发生了什么。
 */
type ListNotice =
  | { readonly kind: "deleted"; readonly name: string }
  | { readonly kind: "delete_refused"; readonly strategyKey: string }
  | { readonly kind: "delete_failed" }
  /** 初始化失败：文案按**稳定错误码**取字典键（`initializeErrorKey`），不带上屏的服务端原文。 */
  | { readonly kind: "initialize_failed"; readonly messageKey: string };

/** 提示条配色按语义分档；色值来自主题 token，不新造类名。 */
const NOTICE_TONES: Record<ListNotice["kind"], string> = {
  deleted: "border-border-subtle bg-surface-1 text-text-secondary",
  delete_refused: "border-warning-border bg-warning-bg text-warning-text",
  delete_failed: "border-status-error/40 bg-surface-1 text-status-error",
  initialize_failed: "border-status-error/40 bg-surface-1 text-status-error",
};

/** 提示条：成功用 `role="status"`（不打断读屏），拒绝与失败用 `role="alert"`。 */
function ListNoticeBar({ notice, onDismiss }: { readonly notice: ListNotice; readonly onDismiss: () => void }) {
  const { t } = useTranslation(WORKFLOW_NS);
  let text: string;
  if (notice.kind === "deleted") text = t("list.delete_success", { name: notice.name });
  else if (notice.kind === "delete_refused") text = t(notice.strategyKey);
  else if (notice.kind === "initialize_failed") text = t(notice.messageKey);
  else text = t("list.delete_failed");

  return (
    <div
      role={notice.kind === "deleted" ? "status" : "alert"}
      className={`flex items-start justify-between gap-2 rounded-lg border px-3 py-2 text-xs ${NOTICE_TONES[notice.kind]}`}
    >
      <span>{text}</span>
      <Button variant="ghost" size="icon-xs" aria-label={t("list.notice_dismiss")} onClick={onDismiss}>
        <X />
      </Button>
    </div>
  );
}

export function WorkflowListPage() {
  const { t } = useTranslation(WORKFLOW_NS);
  const navigate = useNavigate();

  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<WorkflowV2WorkflowItem | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkflowV2WorkflowItem | null>(null);
  const [notice, setNotice] = useState<ListNotice | null>(null);
  // 表单重置计数器：每次打开递增，`FormDialog` 的 `key` 随之变化 = 重挂载 = 全新表单实例（§4.3）。
  const [formKey, setFormKey] = useState(0);

  const list = useRequest(
    async () => {
      const [workflowPage, binding] = await Promise.all([
        unwrap(fetchWorkflows({ page, size: LIST_PAGE_SIZE })),
        unwrap(fetchOrgAppBinding()),
      ]);
      return { workflowPage, binding };
    },
    { refreshDeps: [page] },
  );

  const state = resolveListViewState({
    loading: list.loading,
    error: list.error,
    binding: list.data?.binding ?? null,
    items: list.data?.workflowPage.items ?? [],
    total: list.data?.workflowPage.total ?? 0,
  });

  // 删掉本页最后一条后页码会停在空页：退回上一页，而不是显示「暂无工作流」（那会谎报「一条都没有」）。
  useEffect(() => {
    if (state.kind === "empty" && page > 1) setPage((current) => Math.max(1, current - 1));
  }, [state.kind, page]);

  const create = useRequest(
    (values: WorkflowCreateFormValues) =>
      unwrap(createWorkflow({ name: values.name.trim(), desc: values.desc.trim() || undefined })),
    {
      manual: true,
      onSuccess: (created) => {
        setCreateOpen(false);
        setCreateError(null);
        // 画布深链的参数是上游 workflow ID（`pages/canvas/canvas-host-page.tsx` 的入参语义）。
        void navigate({ to: "/agent/workflow/$id/edit", params: { id: created.upstreamWorkflowId } });
      },
      onError: (error) => {
        // `ApiError.message` 是后端信封原文，只进日志；上屏走字典文案（§9.3）。
        console.error(t("list.create_error"), error);
        setCreateError(t("list.create_error"));
      },
    },
  );

  // 初始化工作流空间（未绑定态的自愈入口）——一键动作：点击即发请求，没有表单也没有弹窗，展示名由服务端取
  // 组织名称，因此这里的入参只有「没有入参」这一种形态。成功要**同批**重取列表与绑定：两者本来就来自同一个
  // 取数函数，`list.refresh()` 一次把两件事都做掉；只刷列表会留下「绑定已通、列表还是未绑定那批」的半新界面。
  const initialize = useRequest(() => unwrap(createOrgApp()), {
    manual: true,
    onSuccess: () => {
      setNotice(null);
      list.refresh();
    },
    onError: (error) => {
      // `ApiError.message` 是后端信封原文（含上游措辞），只进日志；上屏按稳定错误码取字典键（§9.3）。
      console.error(t("list.initialize_failed"), error);
      setNotice({ kind: "initialize_failed", messageKey: initializeErrorKey(error) });
    },
  });

  const rename = useRequest(
    (target: WorkflowV2WorkflowItem, values: WorkflowRenameFormValues) =>
      unwrap(updateWorkflow(target.id, { name: values.name.trim() })),
    {
      manual: true,
      onSuccess: () => {
        setRenameTarget(null);
        setRenameError(null);
        list.refresh();
      },
      onError: (error) => {
        console.error(t("list.rename_failed"), error);
        setRenameError(t("list.rename_failed"));
      },
    },
  );

  const remove = useRequest((target: WorkflowV2WorkflowItem) => unwrap(deleteWorkflow(target.id)), {
    manual: true,
    onSuccess: (result, params) => {
      const [target] = params;
      setDeleteTarget(null);
      const outcome = resolveDeleteOutcome(result);
      if (outcome.kind === "deleted") {
        setNotice({ kind: "deleted", name: target.name });
        list.refresh();
        return;
      }
      // 上游策略拒绝（首发审核中 / 需先下架）：本地行还在，刷新只会把同一行原样取回来，因此只给原因。
      setNotice({ kind: "delete_refused", strategyKey: deleteRefusalKey(outcome.strategy) });
    },
    onError: (error) => {
      console.error(t("list.delete_failed"), error);
      setDeleteTarget(null);
      setNotice({ kind: "delete_failed" });
    },
  });

  const totalPages = Math.max(1, Math.ceil((state.kind === "ready" ? state.total : 0) / LIST_PAGE_SIZE));
  // 上游未就绪与无权限时创建必然失败（409 `ORG_APP_NOT_BOUND` / 401）：置灰而不是让用户点出一个错误弹窗，
  // 原因由下方的状态块给出。取数中不禁用——绑定状态还没到，不拿「还没问」当「不能建」。
  const createDisabled = state.kind === "blocked" || state.kind === "unauthorized";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center justify-end">
        <Button
          size="sm"
          disabled={createDisabled}
          onClick={() => {
            setCreateError(null);
            setFormKey((key) => key + 1);
            setCreateOpen(true);
          }}
        >
          <Plus />
          {t("list.create")}
        </Button>
      </div>

      {notice !== null ? <ListNoticeBar notice={notice} onDismiss={() => setNotice(null)} /> : null}

      {state.kind === "ready" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <WorkflowListTable
            items={state.items}
            onRename={(item) => {
              setRenameError(null);
              setFormKey((key) => key + 1);
              setRenameTarget(item);
            }}
            onDelete={setDeleteTarget}
          />
          <Pagination
            page={page}
            totalPages={totalPages}
            total={state.total}
            pageSize={LIST_PAGE_SIZE}
            onPageChange={setPage}
            translationPrefix={LIST_I18N_SCOPE}
            t={t}
          />
        </div>
      ) : state.kind === "loading" ? (
        <WorkflowListSkeleton />
      ) : (
        <WorkflowListStatusView
          state={state}
          onRetry={list.refresh}
          onInitialize={() => {
            void initialize.run();
          }}
          initializing={initialize.loading}
        />
      )}

      <WorkflowCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={create.run}
        loading={create.loading}
        formKey={formKey}
        errorText={createError}
      />
      <WorkflowRenameDialog
        target={renameTarget}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
        onSubmit={(values) => renameTarget && rename.run(renameTarget, values)}
        loading={rename.loading}
        formKey={formKey}
        errorText={renameError}
      />
      <WorkflowDeleteDialog
        target={deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onConfirm={() => deleteTarget && remove.run(deleteTarget)}
        loading={remove.loading}
      />
    </div>
  );
}
