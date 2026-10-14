/**
 * 平台管理面的工单详情视图：完整工单（元信息、正文、附件、评论）与全部写入口。
 *
 * **与 `/agent/tickets/$projectId/$number` 的关系是「同一套业务、两种凭据」**：写状态机、冲突与待确认处置、
 * 评论倒序分页、标签全量提交、附件队列与失败分类全部复用同一批 hooks 与展示组件，差别只有三处：
 * 1. **数据源**：`systemTicketDataSource`（`/api/system/**` + 系统 master key），不是会话面；
 * 2. **归属坐标**：管理面的详情响应里没有组织/仓库（那是列表 join 出来的服务端字段），坐标由列表行带进来，
 *    与工单号一起构成这一屏的定位；
 * 3. **没有会话主体**：评论编辑入口不按「作者本人」判定（管理面不做原作者判定，凭据即判据），因此这里的
 *    每条评论都可编辑；写入者身份是**平台系统管理员**——服务端以系统托管租户为审计主体，界面把它如实呈现
 *    成「平台系统管理员」，不沿用身份目录里的账号名，也不冒充组织成员（见 `lib/platform-audit-author`）。
 *    附件同理：图源要带 `Authorization` 取字节，因此点击「打开」用 blob 预览而不是 `<img src>`（见
 *    `../hooks/use-platform-attachment-preview`）。
 *
 * 视图切换（列表 ⇄ 详情）由页面持有而不是路由：管理面是宿主 `/admin/tickets` 下的一块就地视图，列表的
 * 筛选与页码必须原样保留，走路由就得把筛选状态搬进 URL 才不丢。
 *
 * 四态与失败落点：加载中骨架；401（凭据失效）经 `onAuthFailure` 清 key 回门，本视图不再自己给结论页——
 * 门上已有明确提示，再画一个「无权限」反而像平台坏了；其余失败给重试与服务端 `message`。
 */

import { MessageResponse } from "@fenix/ui-components/chat/primitives/message";
import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { AlertTriangle, ArrowLeft, CircleCheck, CircleSlash, Pencil, RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SystemTicketSummary } from "../../../api/system-tickets";
import { systemTicketDataSource } from "../../../api/system-tickets";
import { useTicketAttachments } from "../../../hooks/use-ticket-attachments";
import { useTicketComments } from "../../../hooks/use-ticket-comments";
import { useTicketDetail } from "../../../hooks/use-ticket-detail";
import { useTicketLabels } from "../../../hooks/use-ticket-labels";
import { useTicketMembers } from "../../../hooks/use-ticket-members";
import { TICKETS_NS } from "../../../i18n/namespace";
import { toPlatformCommentView } from "../../../lib/platform-audit-author";
import { isNotFoundError, isUnauthorizedError } from "../../../lib/ticket-errors";
import {
  TicketAttachmentPicker,
  TicketAttachmentSection,
} from "../../agent-panel/components/ticket-attachment-section";
import { TicketCommentSection } from "../../agent-panel/components/ticket-comment-section";
import { TicketDetailMeta } from "../../agent-panel/components/ticket-detail-meta";
import { TicketFieldsDialog } from "../../agent-panel/components/ticket-fields-dialog";
import { TicketStateBadge } from "../../agent-panel/components/ticket-state-badge";
import { TicketWriteBanner } from "../../agent-panel/components/ticket-write-banner";
import { usePlatformAttachmentPreview } from "../hooks/use-platform-attachment-preview";
import { PlatformAttachmentPreview } from "./platform-attachment-preview";

/** 评论编辑入口的会话主体：管理面无会话用户，恒传 `null`；可见性由 `canEdit` 覆盖（见文件头第 3 条）。 */
const NO_VIEWER = null;

/**
 * 评论编辑入口的可见性：平台管理面对**每一条**评论开放。
 *
 * 控制台面的「只认作者本人」是界面侧的可见性收窄（服务端仍独立判定）；服务端的管理面评论编辑端点不做原作者
 * 判定（凭据即判据），因此这里不该照搬那条规则——照搬会让操作者无法改动组织成员写的评论，而他本来有权改。
 */
const ANY_COMMENT_EDITABLE = (): boolean => true;

export interface PlatformTicketDetailProps {
  /** 列表行：工单号 + 归属坐标（管理面的详情响应里没有坐标）。 */
  row: SystemTicketSummary;
  /** 返回列表（就地切回，列表的筛选与页码原样保留）。 */
  onBack: () => void;
  /** 凭据失效（401）时回门；由 `AdminTicketsPage` 接 `useAdminKeyGate().fail`。 */
  onAuthFailure: () => void;
}

export function PlatformTicketDetail({ row, onBack, onAuthFailure }: PlatformTicketDetailProps) {
  const { t, i18n } = useTranslation(TICKETS_NS);
  const projectId = row.projectId;
  const number = row.issueNumber;
  const detail = useTicketDetail(projectId, number, systemTicketDataSource);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  /** 每次打开递增：`FormDialog` 在自身组件体里建 `useForm`，只改 `open` 会让上一次的输入留到下一次。 */
  const [fieldsFormKey, setFieldsFormKey] = useState(0);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [assigneeOpen, setAssigneeOpen] = useState(false);

  const comments = useTicketComments(projectId, number, systemTicketDataSource, {
    blocked: detail.blocked,
    // 详情拿到之前不取评论：404 时评论区不会渲染，为它多发一次注定失败的请求只会多一条 toast。
    enabled: detail.data !== undefined,
    onUncertain: detail.reportUncertain,
    onOperationPending: detail.refresh,
  });
  const labels = useTicketLabels(projectId, number, systemTicketDataSource, {
    applyTicket: detail.applyTicket,
    blocked: detail.blocked,
    enabled: labelsOpen,
    reloadLatest: detail.reloadLatest,
    reportUncertain: detail.reportUncertain,
    ticket: detail.data,
  });
  // 候选只在选择器展开时取（与控制台面同口径）：管理面的成员名录来自系统端点，不能靠选择器自己去取。
  const members = useTicketMembers(projectId, systemTicketDataSource, { open: assigneeOpen });

  const attachments = useTicketAttachments(projectId, number, systemTicketDataSource, {
    enabled: detail.data !== undefined,
    onUncertain: detail.reportUncertain,
  });
  // 附件「打开」：图片走带凭据的 blob 预览，其余直接下载（见 hook 文件头）。
  const preview = usePlatformAttachmentPreview(projectId, number);

  /**
   * 评论作者投影：平台审计主体呈现为「平台系统管理员」。
   *
   * 投影**只换展示名与来源标记**，不动内容与版本（投影函数见 `lib/platform-audit-author`，识别口径与已知边界
   * 也写在那里）。映射结果是一份新的数组，函数引用原样透传，因此评论区仍是同一个状态对象在驱动。
   */
  const platformAuthorLabel = t("admin.platformAuthor");
  const commentItems = useMemo(
    () => comments.comments.map((comment) => toPlatformCommentView(comment, platformAuthorLabel)),
    [comments.comments, platformAuthorLabel],
  );
  const commentsView = { ...comments, comments: commentItems };

  /**
   * 读数失败一律先看凭据：401/403 意味着 master key 失效（或被撤销），此时清 key 回门才是可行动的处置。
   * 写路径的 401 不在这里——它由 `lib/ticket-write-failure` 归类成 toast（`permission.denied`），
   * 页面拿不到该错误对象；凭据失效后任何一次读数（含本页的刷新）都会把界面带回门。
   */
  const authFailure =
    [detail.error, comments.error, attachments.error, labels.catalogError].find(isUnauthorizedError) ?? null;

  useEffect(() => {
    if (authFailure !== null) onAuthFailure();
  }, [authFailure, onAuthFailure]);

  if (detail.loading && !detail.data) {
    return (
      <PageShell>
        <BackToListButton onBack={onBack} />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </PageShell>
    );
  }

  if (detail.error !== undefined) {
    // 401 已交给门：这一帧不渲染结论页，避免闪出一个「凭据问题」的界面再被门替换掉。
    if (authFailure !== null) return null;
    const notFound = isNotFoundError(detail.error);
    return (
      <PageShell>
        <BackToListButton onBack={onBack} />
        <EmptyState
          action={{
            label: t("loadState.retry"),
            icon: <RefreshCw className="size-3.5" />,
            onClick: detail.refresh,
            disabled: detail.loading,
          }}
          description={
            notFound ? t("loadState.notFoundHint") : t("loadState.failed", { message: detail.error.message })
          }
          icon={<AlertTriangle className="size-6" />}
          role="alert"
          title={notFound ? t("loadState.notFoundTitle") : t("admin.detailLoadFailedTitle")}
          tone="danger"
        />
      </PageShell>
    );
  }

  const data = detail.data;
  if (data === undefined) return null;

  const busy = detail.busy || comments.creating || comments.updating || labels.saving;
  const writeDisabled = detail.blocked || busy;

  return (
    <PageShell busy={busy}>
      <BackToListButton onBack={onBack} />

      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-text-primary">
            <span>#{data.issueNumber}</span>
            <span className="truncate">{data.title}</span>
            <TicketStateBadge state={data.state} />
          </h1>
          {/* 归属坐标：管理面独有的一行。没有它，两个组织的同名工单号无法区分。 */}
          <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary">
            <span>
              <span className="text-text-dim">{t("admin.columnOrganization")}</span> {row.organizationName}
            </span>
            <span>
              <span className="text-text-dim">{t("admin.columnRepository")}</span>{" "}
              {`${row.projectOwner}/${row.projectName}`}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={detail.loading} onClick={detail.refresh} variant="outline">
            <RefreshCw className="size-4" />
            {t("action.refresh")}
          </Button>
          <Button
            disabled={writeDisabled}
            onClick={() => {
              setFieldsFormKey((key) => key + 1);
              setFieldsOpen(true);
            }}
            variant="outline"
          >
            <Pencil className="size-4" />
            {t("action.edit")}
          </Button>
          {data.state === "open" ? (
            <Button disabled={writeDisabled} onClick={() => setCloseConfirmOpen(true)} variant="outline">
              <CircleSlash className="size-4" />
              {t("action.close")}
            </Button>
          ) : (
            <Button
              disabled={writeDisabled}
              onClick={() => {
                // 重开不确认：恢复「进行中」是可逆的低风险动作，且点击意图明确（少一次点击）。
                void detail.changeState("open");
              }}
              variant="outline"
            >
              <CircleCheck className="size-4" />
              {t("action.reopen")}
            </Button>
          )}
        </div>
      </header>

      {detail.pendingOperationId === null ? null : (
        <TicketWriteBanner
          onResolve={() => {
            void detail.resolveOperation();
          }}
          resolution={detail.resolution}
          resolving={detail.resolving}
        />
      )}

      {data.syncStatus === "stale" ? (
        <p className="text-xs text-status-warning" role="status">
          {t("sync.degraded")}
        </p>
      ) : null}

      <TicketDetailMeta
        disabled={writeDisabled}
        labels={labels}
        labelsOpen={labelsOpen}
        locale={i18n.language}
        members={members}
        onAssign={(userId) => {
          void detail.assign(userId);
        }}
        onAssigneeOpenChange={setAssigneeOpen}
        onLabelsOpenChange={setLabelsOpen}
        projectId={projectId}
        ticket={data}
      />

      <section className="min-w-0 rounded-md border border-border bg-surface-1 p-4">
        <MessageResponse mode="static">{data.body}</MessageResponse>
      </section>

      {/* 缩略图需要可内联的图源，而管理面的凭据是 `Authorization` 头（`<img src>` 带不上）：
          不渲染预览，附件行与下载按钮不受影响（下载走带凭据的 Blob）。 */}
      <TicketAttachmentSection
        attachments={attachments}
        locale={i18n.language}
        number={number}
        onOpen={preview.open}
        projectId={projectId}
        thumbnailUrlFor={() => undefined}
      />

      <TicketCommentSection
        attachmentPicker={
          <TicketAttachmentPicker
            // 与其它写入口同口径禁用；上传本身不计入 `busy`（它不该让整页进入遮罩态）。
            disabled={writeDisabled || attachments.uploading}
            onSelect={attachments.addFiles}
          />
        }
        busy={busy}
        canEdit={ANY_COMMENT_EDITABLE}
        comments={commentsView}
        locale={i18n.language}
        onPasteFiles={attachments.addFiles}
        viewerUserId={NO_VIEWER}
      />

      {preview.target === null ? null : (
        <PlatformAttachmentPreview
          errorMessage={preview.errorMessage}
          name={preview.target.name}
          onClose={preview.close}
          onRetry={preview.retry}
          status={preview.status}
          url={preview.objectUrl}
        />
      )}

      {/* 弹窗重置靠 `key`（父级每次打开换一个）：只改 `open` 不会重建 `FormDialog` 内部的表单实例。 */}
      <TicketFieldsDialog
        conflict={detail.fieldsConflict}
        disabled={writeDisabled}
        key={`fields-${fieldsFormKey}`}
        onOpenChange={setFieldsOpen}
        onReload={detail.reloadLatest}
        onSubmit={detail.submitFields}
        open={fieldsOpen}
        reloading={detail.loading}
        submitting={detail.busy}
        ticket={data}
      />

      <ConfirmDialog
        confirmLabel={t("action.close")}
        description={t("state.closeDescription")}
        loading={detail.busy}
        onConfirm={() => {
          void (async () => {
            // 任何终局都关确认框：结论已由 toast 给出（冲突时详情钩子还会自动刷新一次），重试入口是页头
            // 那颗「关闭工单」——留着一个停留在「确认中」的确认框只会挡住信息。
            await detail.changeState("closed");
            setCloseConfirmOpen(false);
          })();
        }}
        onOpenChange={setCloseConfirmOpen}
        open={closeConfirmOpen}
        title={t("state.closeTitle")}
      />
    </PageShell>
  );
}

/** 管理面页容器：与列表视图同一套留白与最大宽度，切换视图时页面骨架不跳。 */
function PageShell({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  return (
    <div className="min-h-screen bg-background p-6">
      <div aria-busy={busy} className="mx-auto flex max-w-6xl flex-col gap-6">
        {children}
      </div>
    </div>
  );
}

/** 返回列表：就地切回（不是路由跳转），因此是按钮而不是 `<Link>`。 */
function BackToListButton({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation(TICKETS_NS);
  return (
    <button
      className="inline-flex w-fit items-center gap-1.5 text-xs text-brand hover:underline"
      onClick={onBack}
      type="button"
    >
      <ArrowLeft className="size-3.5" />
      {t("action.back")}
    </button>
  );
}
