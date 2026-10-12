/**
 * 待确认横幅：该工单有一笔写还没终结时，常驻在页面顶部，并提供唯一的「核对结果」入口。
 *
 * **不轮询**（延续 T02 决策 D3）：核对是用户的显式动作，服务端状态不会因为多问几次而更快确定；轮询还会在
 * 用户离开页面前一直占用连接。按钮在请求中置灰（`write.checking`），失败只把结论行换成 `write.checkFailed`，
 * 不改变页面的主状态——横幅本身仍代表「有一笔未确认的写」这个事实。
 *
 * 终态（成功/失败）不在这里呈现：结论一出来待确认态就解除了，横幅随之卸载，那两种结论由详情钩子改用
 * toast 告知（见 `use-ticket-detail.resolveOperation`）。
 */

import { Button } from "@fenix/ui-components/ui/button";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TicketResolution } from "../../../hooks/use-ticket-detail";
import { TICKETS_NS } from "../../../i18n/namespace";

/** 结论行文案：每个非终态都有自己的一句，用户据此决定「继续等」还是「找运维」。 */
const RESOLUTION_KEYS: Record<Exclude<TicketResolution, null>, string> = {
  pending: "write.statusPending",
  dispatching: "write.statusPending",
  uncertain: "write.statusUncertain",
  needs_review: "write.statusNeedsReview",
  checkFailed: "write.checkFailed",
};

export interface TicketWriteBannerProps {
  resolution: TicketResolution;
  resolving: boolean;
  onResolve: () => void;
}

export function TicketWriteBanner({ resolution, resolving, onResolve }: TicketWriteBannerProps) {
  const { t } = useTranslation(TICKETS_NS);
  return (
    <div
      className="mt-3 flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface-1 px-3 py-2"
      role="status"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text-primary">{t("write.uncertainTitle")}</p>
        <p className="mt-0.5 text-xs text-text-secondary">{t("write.uncertainHint")}</p>
        {resolution === null ? null : <p className="mt-1 text-xs text-text-dim">{t(RESOLUTION_KEYS[resolution])}</p>}
      </div>
      <Button disabled={resolving} onClick={onResolve} size="sm" variant="outline">
        <RefreshCw className="size-3.5" />
        {resolving ? t("write.checking") : t("write.check")}
      </Button>
    </div>
  );
}
