/**
 * 详情页的元信息区：作者、负责人（可改）、标签（可改）、时间与同步新鲜度。
 *
 * 「负责人」与「标签」是两块**可写**元信息，都长在工单快照上，因此它们与页头动作共享同一份禁用口径
 * （有待确认的写、或别的写动作进行中即整片禁用）——把禁用条件写在各自组件里会让「同一时刻只允许一笔写」
 * 在新增入口时重新长一遍判断。
 *
 * 标签 chips 与编辑区是同一个组件（`TicketLabelsEditor`）：chips 永远显示服务端事实，编辑区只承载勾选草稿，
 * 两者的状态都来自 `use-ticket-labels`，拆成两个组件反而要在父子间同步一份草稿。
 */

import { Badge } from "@fenix/ui-components/ui/badge";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TicketDetail } from "../../../api/tickets";
import type { TicketLabelsState } from "../../../hooks/use-ticket-labels";
import { TICKETS_NS } from "../../../i18n/namespace";
import { TicketAssigneePicker } from "./ticket-assignee-picker";
import { formatTicketTime } from "./ticket-format";
import { TicketLabelsEditor } from "./ticket-labels-editor";

export interface TicketDetailMetaProps {
  ticket: TicketDetail;
  projectId: string;
  /** 当前界面语言，用于时间格式化。 */
  locale: string;
  /** 有待确认的写、或别的写动作进行中：所有写入口禁用。 */
  disabled: boolean;
  onAssign: (userId: string | null) => void;
  labels: TicketLabelsState;
  labelsOpen: boolean;
  onLabelsOpenChange: (open: boolean) => void;
}

export function TicketDetailMeta({
  ticket,
  projectId,
  locale,
  disabled,
  onAssign,
  labels,
  labelsOpen,
  onLabelsOpenChange,
}: TicketDetailMetaProps) {
  const { t } = useTranslation(TICKETS_NS);
  return (
    <>
      <dl className="mt-4 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
        <Fact label={t("detail.authorLabel")}>
          {ticket.author.name}
          {ticket.author.source === "external" ? (
            <Badge className="ml-2" variant="outline">
              {t("detail.externalAuthor")}
            </Badge>
          ) : null}
        </Fact>
        <Fact label={t("detail.assigneeLabel")}>
          <TicketAssigneePicker
            assignee={ticket.assignee}
            disabled={disabled}
            onSelect={onAssign}
            projectId={projectId}
          />
        </Fact>
        <Fact label={t("detail.updatedAtLabel")}>{formatTicketTime(ticket.providerUpdatedAt, locale)}</Fact>
      </dl>
      <p className="mt-2 text-xs text-text-dim">
        {t("detail.syncedAtLabel", { time: formatTicketTime(ticket.syncedAt, locale) })}
      </p>

      {/* 归属未经受信记录核验时必须明说：外部自填的身份不能被当成既有事实（方案 §7）。 */}
      {ticket.author.source === "external" ? (
        <div
          className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-1 px-3 py-2 text-xs text-text-secondary"
          role="status"
        >
          <Badge variant="outline">{t("detail.externalAuthor")}</Badge>
          <span>{t("detail.externalAuthorHint")}</span>
        </div>
      ) : null}

      <div className="mt-4">
        <p className="text-xs text-text-dim">{t("detail.labelsLabel")}</p>
        <div className="mt-1">
          <TicketLabelsEditor
            current={ticket.labels}
            disabled={disabled}
            labels={labels}
            onOpenChange={onLabelsOpenChange}
            open={labelsOpen}
          />
        </div>
      </div>
    </>
  );
}

/** 元信息单元：`dt` 弱化、`dd` 用正文色，刻度与 `AppHeader` 的副标题一致。 */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-text-dim">{label}</dt>
      <dd className="mt-1 flex flex-wrap items-center text-text-primary">{children}</dd>
    </div>
  );
}
