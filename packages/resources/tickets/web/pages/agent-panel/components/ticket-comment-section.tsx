/**
 * 评论区的装配外壳：标题、新建表单、列表、「加载更早」与空/失败态。
 *
 * 取数与写编排全在 `use-ticket-comments`（页面注入），本组件只做渲染与上报——评论区是「三个动作都能在
 * happy-dom 下真实驱动」的那一块（新建、编辑、加载更早都是内联控件，不经覆盖层），因此它必须保持**纯受控**：
 * 草稿、编辑目标、冲突提示都来自 hook，组件自己不持有第二份状态（双份状态必然在成功/失败两条路径上分叉）。
 *
 * 时间顺序：hook 已把「最新在前」的分页翻成时间正序，这里按数组顺序渲染即可；「加载更早的评论」按钮因此
 * 在列表**上方**——它拉回来的内容会出现在按钮下方的上方位置，按钮位置与它拉取的方向一致。
 */

import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { AlertTriangle, ChevronUp, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TicketCommentsState } from "../../../hooks/use-ticket-comments";
import { TICKETS_NS } from "../../../i18n/namespace";
import { TicketCommentComposer } from "./ticket-comment-composer";
import { TicketCommentItem } from "./ticket-comment-item";

export interface TicketCommentSectionProps {
  comments: TicketCommentsState;
  /** 当前登录用户 id；评论编辑入口只认作者（三.17）。 */
  viewerUserId: string | null;
  /** 当前界面语言，用于时间格式化。 */
  locale: string;
  /** 别的写动作进行中：评论区的写入口一并禁用（同一工单同一时刻只允许一笔写）。 */
  busy: boolean;
  /** 附件选择入口节点，透传给新建表单（附件挂工单，编辑评论时不出现）。 */
  attachmentPicker?: ReactNode;
}

export function TicketCommentSection({
  comments,
  viewerUserId,
  locale,
  busy,
  attachmentPicker,
}: TicketCommentSectionProps) {
  const { t } = useTranslation(TICKETS_NS);
  const writeDisabled = busy || comments.blocked;
  const editing = comments.editing;

  return (
    <section className="mt-6">
      <h2 className="text-sm font-medium text-text-primary">{t("comment.sectionTitle")}</h2>
      <div className="mt-3">
        <TicketCommentComposer
          attachmentPicker={attachmentPicker}
          disabled={writeDisabled}
          mode="create"
          onChange={comments.setCreateDraft}
          onSubmit={() => {
            void comments.createComment(comments.createDraft);
          }}
          submitting={comments.creating}
          value={comments.createDraft}
        />
      </div>

      {comments.loading ? (
        <div className="mt-4 flex flex-col gap-2">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : comments.error !== undefined ? (
        <EmptyState
          action={{
            label: t("loadState.retry"),
            icon: <RefreshCw className="size-3.5" />,
            onClick: comments.retryFirst,
          }}
          // 说明行放服务端信封原文，与标题的固定文案分工：标题给出「哪一步失败」，说明给出「为什么」。
          description={comments.error?.message || t("comment.loadFailed")}
          icon={<AlertTriangle className="size-6" />}
          role="alert"
          title={t("comment.loadFailed")}
          tone="danger"
        />
      ) : comments.comments.length === 0 ? (
        <EmptyState className="py-6" title={t("comment.empty")} />
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {comments.hasOlder ? (
            <Button
              className="w-fit"
              disabled={comments.loadingOlder}
              onClick={comments.loadOlder}
              size="sm"
              variant="outline"
            >
              <ChevronUp className="size-3.5" />
              {t("comment.loadMore")}
            </Button>
          ) : null}
          <ol className="flex flex-col gap-3">
            {comments.comments.map((comment) => {
              const isEditing = editing !== null && editing.commentId === comment.commentId;
              return (
                <TicketCommentItem
                  comment={comment}
                  editDisabled={writeDisabled}
                  editing={isEditing}
                  editor={
                    isEditing && editing !== null ? (
                      <TicketCommentComposer
                        disabled={writeDisabled}
                        errorMessage={comments.editConflict ? t("write.conflict") : undefined}
                        mode="edit"
                        onCancel={comments.cancelEdit}
                        onChange={comments.setEditingBody}
                        onReload={comments.reload}
                        onSubmit={() => {
                          void comments.submitEdit();
                        }}
                        reloading={comments.reloading}
                        submitting={comments.updating}
                        value={editing.body}
                      />
                    ) : undefined
                  }
                  key={comment.commentId}
                  locale={locale}
                  onEdit={comments.beginEdit}
                  viewerUserId={viewerUserId}
                />
              );
            })}
          </ol>
        </div>
      )}
    </section>
  );
}
