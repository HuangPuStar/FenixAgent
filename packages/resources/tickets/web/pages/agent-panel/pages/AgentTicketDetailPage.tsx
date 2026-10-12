/**
 * 工单详情页：标题、状态、编号、作者（含外部来源标注）、负责人、正文、时间与返回列表。
 *
 * props 由宿主路由壳用 `Route.useParams()` 读好后传入（URL 显式带 `projectId`）：包内不认识宿主 route id，
 * 跨包契约只剩这一个 props 形状。`number` 是字符串——外部数字 ID 在协议里不退化，本页也不做数值转换。
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
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { AppHeader } from "@fenix/ui-components/layout/app-header";
import { AppPage } from "@fenix/ui-components/layout/app-page";
import { Badge } from "@fenix/ui-components/ui/badge";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { unwrap } from "@fenix/web-runtime/api/request";
import { Link } from "@tanstack/react-router";
import { useRequest } from "ahooks";
import { AlertTriangle, ArrowLeft, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ticketApi } from "../../../api/tickets";
import { TICKETS_NS } from "../../../i18n/namespace";
import { isNotFoundError, isUnauthorizedError } from "../../../lib/ticket-errors";
import { formatTicketTime } from "../components/ticket-format";
import { TicketStateBadge } from "../components/ticket-state-badge";

export interface AgentTicketDetailPageProps {
  /** 路由段 `$projectId`：所有工单资源 URL 都显式带项目，历史链接不随默认项目切换漂移。 */
  projectId: string;
  /** 路由段 `$number`：外部数字 ID 按字符串承载。 */
  number: string;
}

export function AgentTicketDetailPage({ projectId, number }: AgentTicketDetailPageProps) {
  const { t, i18n } = useTranslation(TICKETS_NS);

  const { data, loading, error, refresh } = useRequest(async () => unwrap(ticketApi.get(projectId, number)), {
    refreshDeps: [projectId, number],
    onError: (err: Error) => {
      // 只上屏字典文案：`ApiError.message` 是后端信封原文，只进 console（§9.3）。
      console.error("ticket detail load failed", err);
      toast.error(t("toast.detailLoadFailed"));
    },
  });

  if (loading && !data) {
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

  if (error) {
    const unauthorized = isUnauthorizedError(error);
    const notFound = isNotFoundError(error);
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
                  onClick: refresh,
                  disabled: loading,
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

  if (!data) return null;

  return (
    <AppPage>
      <BackToListLink />
      <AppHeader
        actions={
          <>
            <TicketStateBadge state={data.state} />
            <Button disabled={loading} onClick={refresh} variant="outline">
              <RefreshCw className="size-4" />
              {t("action.refresh")}
            </Button>
          </>
        }
        subtitle={data.title}
        title={`#${data.issueNumber}`}
      />

      {data.syncStatus === "stale" ? (
        <p className="mt-3 text-xs text-status-warning" role="status">
          {t("sync.degraded")}
        </p>
      ) : null}

      <dl className="mt-4 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
        <Fact label={t("detail.authorLabel")}>{data.author.name}</Fact>
        <Fact label={t("detail.assigneeLabel")}>
          {data.assignee === null ? t("list.unassigned") : data.assignee.name}
        </Fact>
        <Fact label={t("detail.updatedAtLabel")}>{formatTicketTime(data.providerUpdatedAt, i18n.language)}</Fact>
      </dl>
      <p className="mt-2 text-xs text-text-dim">
        {t("detail.syncedAtLabel", { time: formatTicketTime(data.syncedAt, i18n.language) })}
      </p>

      {/* 归属未经受信记录核验时必须明说：外部自填的身份不能被当成既有事实（方案 §7）。 */}
      {data.author.source === "external" ? (
        <div
          className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-1 px-3 py-2 text-xs text-text-secondary"
          role="status"
        >
          <Badge variant="outline">{t("detail.externalAuthor")}</Badge>
          <span>{t("detail.externalAuthorHint")}</span>
        </div>
      ) : null}

      <section className="mt-4 min-w-0 rounded-md border border-border bg-surface-1 p-4">
        <MessageResponse mode="static">{data.body}</MessageResponse>
      </section>
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

/** 元信息单元：`dt` 弱化、`dd` 用正文色，刻度与 `AppHeader` 的副标题一致。 */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-text-dim">{label}</dt>
      <dd className="mt-1 text-text-primary">{children}</dd>
    </div>
  );
}
