/**
 * 工单状态角标：列表表格与详情页共用的唯一渲染处。
 *
 * 文案取本包字典的 `status.*`（键的 owner 是本包），不在这里拼中英文；配色走 `Badge` 的语义档
 * （进行中用主色档、已关闭用弱化档）而不是自定义色值——角标是全站复用最广的一类元素，一旦允许逐处
 * 微调就会出现同一种状态在三个包长得不一样的局面。
 *
 * 状态取值集合与后端 `state: "open" | "closed"` 对齐，因此这里用三元而非查表：新增状态时类型先报错，
 * 不会静默回退成某一种颜色。
 */

import { Badge } from "@fenix/ui-components/ui/badge";
import { useTranslation } from "react-i18next";
import type { TicketState } from "../../../api/tickets";
import { TICKETS_NS } from "../../../i18n/namespace";

export interface TicketStateBadgeProps {
  state: TicketState;
}

export function TicketStateBadge({ state }: TicketStateBadgeProps) {
  const { t } = useTranslation(TICKETS_NS);
  return (
    <Badge variant={state === "open" ? "default" : "secondary"}>
      {state === "open" ? t("status.open") : t("status.closed")}
    </Badge>
  );
}
