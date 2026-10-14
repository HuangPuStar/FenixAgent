/**
 * 单条评论：作者（含外部来源标注）、时间、Markdown 正文与编辑入口。
 *
 * 编辑入口的可见性由 `lib/ticket-permissions.ts` 的 `canEditComment` 判定（作者本人 + 归属账本核验通过），
 * 服务端仍会独立判定一次——前端隐藏只是不把用户引向一次注定 403 的往返。**规则可由调用方覆盖**（`canEdit`）：
 * 平台管理面不做原作者判定（凭据即判据），那里的每一条评论都可编辑。
 *
 * 正文复用 `MessageResponse mode="static"`（与工单正文同一条 Markdown 链路，原始 HTML 会被标签白名单剥离）；
 * 编辑态时用 `editor` 节点替换正文，而不是把输入框塞进另一个位置——用户的视点不该因为「改一条评论」而跳动。
 */

import { MessageResponse } from "@fenix/ui-components/chat/primitives/message";
import { Badge } from "@fenix/ui-components/ui/badge";
import { Button } from "@fenix/ui-components/ui/button";
import { Pencil } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TicketComment } from "../../../api/ticket-comments";
import { TICKETS_NS } from "../../../i18n/namespace";
import { canEditComment } from "../../../lib/ticket-permissions";
import { formatTicketTime } from "./ticket-format";

export interface TicketCommentItemProps {
  comment: TicketComment;
  /** 当前登录用户 id（会话投影）；`null` 表示拿不到稳定身份，此时不显示编辑入口。 */
  viewerUserId: string | null;
  /** 当前界面语言，用于时间格式化。 */
  locale: string;
  /** 编辑态：为真时用 `editor` 替换正文。 */
  editing: boolean;
  /** 编辑表单节点（由评论区装配，本组件只决定它出现的位置）。 */
  editor?: ReactNode;
  /** 编辑入口是否不可用（有待确认的写、或别的写动作进行中）。 */
  editDisabled: boolean;
  onEdit: (comment: TicketComment) => void;
  /**
   * 编辑入口的可见性规则；省略即控制台面的「作者本人 + 归属已核验」（见文件头）。
   * 平台管理面传 `() => true`：那一面的判据是系统凭据，服务端的评论编辑端点也不做原作者判定。
   */
  canEdit?: (comment: TicketComment) => boolean;
}

export function TicketCommentItem({
  comment,
  viewerUserId,
  locale,
  editing,
  editor,
  editDisabled,
  onEdit,
  canEdit,
}: TicketCommentItemProps) {
  const { t } = useTranslation(TICKETS_NS);
  const editable = canEdit === undefined ? canEditComment(comment, { userId: viewerUserId }) : canEdit(comment);

  return (
    <li className="rounded-md border border-border bg-surface-1 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-text-dim">
        <span className="font-medium text-text-primary">{comment.author.name}</span>
        {/* 归属没经受信记录核验时明说：外部自填的身份不能被当成既有事实（与详情页同一口径）。 */}
        {comment.author.source === "external" ? <Badge variant="outline">{t("detail.externalAuthor")}</Badge> : null}
        <span>{formatTicketTime(comment.providerUpdatedAt, locale)}</span>
        {editable ? (
          <Button
            aria-label={t("comment.edit")}
            className="ml-auto"
            disabled={editDisabled || editing}
            onClick={() => onEdit(comment)}
            size="sm"
            variant="ghost"
          >
            <Pencil className="size-3.5" />
            {t("comment.edit")}
          </Button>
        ) : null}
      </div>
      <div className="mt-2 min-w-0 text-sm">
        {editing && editor !== undefined ? editor : <MessageResponse mode="static">{comment.body}</MessageResponse>}
      </div>
    </li>
  );
}
