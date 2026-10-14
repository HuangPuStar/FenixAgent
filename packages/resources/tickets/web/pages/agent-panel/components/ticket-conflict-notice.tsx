/**
 * 版本冲突提示：`write.conflict` 文案 + 「加载最新内容」按钮（字段编辑弹窗用）。
 *
 * 为什么「加载最新内容」必须是用户动作而不是自动刷新：标题/描述弹窗里**有草稿**。自动刷新会把用户正在改的
 * 东西换成别人的版本，用户不会知道自己的输入去了哪。无草稿的单值动作（指派、状态、标签）相反——刷新不会
 * 丢任何输入，因此那三条路径在各自的 hook 里自动刷新一次，不走本组件。
 */

import { Button } from "@fenix/ui-components/ui/button";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TICKETS_NS } from "../../../i18n/namespace";

export interface TicketConflictNoticeProps {
  onReload: () => void;
  /** 刷新请求进行中：按钮置灰（刷新本身失败由详情钩子统一提示）。 */
  reloading: boolean;
}

export function TicketConflictNotice({ onReload, reloading }: TicketConflictNoticeProps) {
  const { t } = useTranslation(TICKETS_NS);
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-1 px-3 py-2 text-xs text-text-secondary"
      role="alert"
    >
      <span>{t("write.conflict")}</span>
      <Button disabled={reloading} onClick={onReload} size="sm" type="button" variant="outline">
        <RefreshCw className="size-3.5" />
        {t("write.reload")}
      </Button>
    </div>
  );
}
