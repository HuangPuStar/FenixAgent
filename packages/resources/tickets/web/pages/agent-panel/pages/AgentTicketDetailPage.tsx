/**
 * 工单详情页：标题、状态与写入口、元信息（负责人 / 标签）、正文、评论区，以及关闭确认与字段编辑弹窗。
 *
 * props 由宿主路由壳用 `Route.useParams()` 读好后传入（URL 显式带 `projectId`）：包内不认识宿主 route id，
 * 跨包契约只剩这一个 props 形状。`number` 是字符串——外部数字 ID 在协议里不退化，本页也不做数值转换。
 *
 * **页面是唯一持有写状态机的地方**（`useTicketDetail`），评论与标签的写路径都汇进它：同一工单只允许一笔
 * 未确认的写（方案 §9.6），两个横幅或两套禁用口径会立刻自相矛盾。三块写入口共享一个 `writeDisabled`：
 * 「有待确认的写」或「任一写动作进行中」都禁用——这条聚合放在页面而不是各组件里，新增入口时才不会漏一处。
 *
 * 正文渲染用 `MessageResponse mode="static"`（前端规范 §6.1 指定的唯一 Markdown 链路）。2026-10-12 核实：
 * `packages/ui-components/web/chat/primitives/message.tsx:311-320` 确有 `mode` prop，渲染经 streamdown +
 * `rehype-sanitize` 标签白名单，未注册的原始 HTML 标签会被剥离（该文件内的注释即「XSS 安全默认」），
 * 因此工单正文里的原始 HTML **不会**被执行。若日后该组件放开原始 HTML，本页必须退回纯文本渲染。
 *
 * 四态各自落点：加载中骨架；无权限与「不存在」都**不给重试**（前者是持久授权状态，后者重试也不会变），
 * 其余失败给重试；成功态里另给手动刷新入口，用户不必为此离开页面。
 */

import { MessageResponse } from "@fenix/ui-components/chat/primitives/message";
import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { AppHeader } from "@fenix/ui-components/layout/app-header";
import { AppPage } from "@fenix/ui-components/layout/app-page";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { useOrgSession } from "@fenix/web-runtime/contexts/org-session";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, CircleCheck, CircleSlash, Pencil, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useTicketAttachments } from "../../../hooks/use-ticket-attachments";
import { useTicketComments } from "../../../hooks/use-ticket-comments";
import { useTicketDetail } from "../../../hooks/use-ticket-detail";
import { useTicketLabels } from "../../../hooks/use-ticket-labels";
import { TICKETS_NS } from "../../../i18n/namespace";
import { isNotFoundError, isUnauthorizedError } from "../../../lib/ticket-errors";
import { TicketAttachmentPicker, TicketAttachmentSection } from "../components/ticket-attachment-section";
import { TicketCommentSection } from "../components/ticket-comment-section";
import { TicketDetailMeta } from "../components/ticket-detail-meta";
import { TicketFieldsDialog } from "../components/ticket-fields-dialog";
import { TicketStateBadge } from "../components/ticket-state-badge";
import { TicketWriteBanner } from "../components/ticket-write-banner";

export interface AgentTicketDetailPageProps {
  /** 路由段 `$projectId`：所有工单资源 URL 都显式带项目，历史链接不随默认项目切换漂移。 */
  projectId: string;
  /** 路由段 `$number`：外部数字 ID 按字符串承载。 */
  number: string;
}

export function AgentTicketDetailPage({ projectId, number }: AgentTicketDetailPageProps) {
  const { t, i18n } = useTranslation(TICKETS_NS);
  const session = useOrgSession();
  const detail = useTicketDetail(projectId, number);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  /** 每次打开递增：`FormDialog` 在自身组件体里建 `useForm`，只改 `open` 会让上一次的输入留到下一次。 */
  const [fieldsFormKey, setFieldsFormKey] = useState(0);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);

  const comments = useTicketComments(projectId, number, {
    blocked: detail.blocked,
    // 详情拿到之前不取评论：404/403 时评论区不会渲染，为它多发一次注定失败的请求只会多一条 toast。
    enabled: detail.data !== undefined,
    onUncertain: detail.reportUncertain,
    // 兜底通道：本次写被服务端以「已有在途变更」拒绝时，刷新详情把快照里的 pendingOperationId 取回来。
    onOperationPending: detail.refresh,
  });
  const labels = useTicketLabels(projectId, number, {
    applyTicket: detail.applyTicket,
    blocked: detail.blocked,
    enabled: labelsOpen,
    reloadLatest: detail.reloadLatest,
    reportUncertain: detail.reportUncertain,
    ticket: detail.data,
  });

  // 附件与评论同层装配（附件区挂在详情页，输入框旁的入口经 props 注入评论表单）。
  const attachments = useTicketAttachments(projectId, number, {
    enabled: detail.data !== undefined,
    onUncertain: detail.reportUncertain,
  });

  if (detail.loading && !detail.data) {
    return (
      <AppPage busy>
        <BackToListLink />
        <AppHeader subtitle={t("subtitle")} title={`#${number}`} />
        <div className="mt-4 flex flex-col gap-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </AppPage>
    );
  }

  if (detail.error) {
    const unauthorized = isUnauthorizedError(detail.error);
    const notFound = isNotFoundError(detail.error);
    // 三条失败路径都不给同一个界面：无权限与「不存在或无权访问」是持久结论（重试只会再拿一次同样的
    // 状态码），其余失败才保留重试入口。
    const title = unauthorized
      ? t("loadState.unauthorizedTitle")
      : notFound
        ? t("loadState.notFoundTitle")
        : t("loadState.failed");
    const description = unauthorized
      ? t("loadState.unauthorizedHint")
      : notFound
        ? t("loadState.notFoundHint")
        : undefined;
    return (
      <AppPage>
        <BackToListLink />
        <AppHeader subtitle={t("subtitle")} title={`#${number}`} />
        <EmptyState
          action={
            unauthorized || notFound
              ? undefined
              : {
                  label: t("loadState.retry"),
                  icon: <RefreshCw className="size-3.5" />,
                  onClick: detail.refresh,
                  disabled: detail.loading,
                }
          }
          description={description}
          icon={<AlertTriangle className="size-6" />}
          role="alert"
          title={title}
          tone="danger"
        />
      </AppPage>
    );
  }

  const data = detail.data;
  if (!data) return null;

  const busy = detail.busy || comments.creating || comments.updating || labels.saving;
  const writeDisabled = detail.blocked || busy;

  const openFieldsDialog = (): void => {
    setFieldsFormKey((key) => key + 1);
    setFieldsOpen(true);
  };

  return (
    <AppPage busy={busy}>
      <BackToListLink />
      <AppHeader
        actions={
          <>
            <TicketStateBadge state={data.state} />
            <Button disabled={detail.loading} onClick={detail.refresh} variant="outline">
              <RefreshCw className="size-4" />
              {t("action.refresh")}
            </Button>
            <Button disabled={writeDisabled} onClick={openFieldsDialog} variant="outline">
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
          </>
        }
        subtitle={data.title}
        title={`#${data.issueNumber}`}
      />

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
        <p className="mt-3 text-xs text-status-warning" role="status">
          {t("sync.degraded")}
        </p>
      ) : null}

      <TicketDetailMeta
        disabled={writeDisabled}
        labels={labels}
        labelsOpen={labelsOpen}
        locale={i18n.language}
        onAssign={(userId) => {
          void detail.assign(userId);
        }}
        onLabelsOpenChange={setLabelsOpen}
        projectId={projectId}
        ticket={data}
      />

      <section className="mt-4 min-w-0 rounded-md border border-border bg-surface-1 p-4">
        <MessageResponse mode="static">{data.body}</MessageResponse>
      </section>

      {/* 附件是工单级的（上游端点以工单号为坐标），因此列表放在评论区之外、之上：贴着评论渲染会让读者
          以为附件属于紧邻的那条评论。上传入口则贴着输入框（见下），两者共享同一个 hook 实例。 */}
      <TicketAttachmentSection attachments={attachments} locale={i18n.language} />

      <TicketCommentSection
        attachmentPicker={
          <TicketAttachmentPicker
            // 与其它写入口同口径禁用：有待确认的写或有写在途时不再开第二笔（附件写入同样落一条在途操作）。
            // 上传本身不计入 `busy`：它不该让整页进入遮罩态，用户在上传期间仍可阅读与滚动。
            disabled={writeDisabled || attachments.uploading}
            onSelect={attachments.addFiles}
          />
        }
        busy={busy}
        comments={comments}
        locale={i18n.language}
        // 粘贴图片与「添加附件」是同一条队列；这里不按 `uploading` 禁用（粘贴的是新内容，队列排得下），
        // 而「有待确认的写 / 评论提交中」由输入框自身的 `disabled` 拦住（禁用的 textarea 不触发粘贴事件）。
        onPasteFiles={attachments.addFiles}
        viewerUserId={session.userId}
      />

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
            // 任何终局都关确认框：结论已由 toast 给出（冲突时详情钩子还会自动刷新一次），
            // 重试入口是页头那颗「关闭工单」——留着一个停留在「确认中」的确认框只会挡住信息。
            await detail.changeState("closed");
            setCloseConfirmOpen(false);
          })();
        }}
        onOpenChange={setCloseConfirmOpen}
        open={closeConfirmOpen}
        title={t("state.closeTitle")}
      />
    </AppPage>
  );
}

/** 返回列表：用 `<Link>` 而不是命令式跳转，键盘与中键行为由路由接管。 */
function BackToListLink() {
  const { t } = useTranslation(TICKETS_NS);
  return (
    <Link className="inline-flex w-fit items-center gap-1.5 text-xs text-brand hover:underline" to="/agent/tickets">
      <ArrowLeft className="size-3.5" />
      {t("action.back")}
    </Link>
  );
}
