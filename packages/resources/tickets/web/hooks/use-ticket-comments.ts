/**
 * 评论区的编排层：倒序分页取数 + 新建/编辑两条写路径 + 草稿与冲突状态。
 *
 * **分页方向与渲染方向刻意相反**（方案 §12「大讨论串」）：接口按时间倒序给页（首屏 = 最新 30 条，
 * `nextCursor` 指向更早），首屏因此不必把 10,000 条评论全量读入再截断；渲染前把页序与页内都反转成
 * 时间正序，读者看到的仍是「上文在下文之前」的自然顺序。
 *
 * **草稿由本 hook 持有**（而不是评论区组件）：新建成功后要清空输入框、编辑成功后要退出编辑态，这两件事
 * 都发生在写终局，只有与写请求同层才能保证「失败保留草稿、成功才清理」；组件因此只剩渲染与上报。
 *
 * 三条与写路径共用的口径：
 * 1. 幂等键按动作表面各持一把（新建一把、编辑一把）：评论框常驻不重挂，同一界面会连发两个独立动作，
 *    共用一把键会让第二个动作命中服务端的「同键不同内容」校验；
 * 2. 202 上报给详情页唯一的待确认态（`onUncertain`），本 hook 不自己造第二套横幅；
 * 3. 评论编辑冲突**只保留草稿**（有草稿的动作），刷新由用户点「加载最新内容」触发——重载后评论版本变化，
 *    下一次提交的签名随之变化、自动换代，不需要任何「冲突后清键」的分支。
 */

import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { TicketComment, TicketCommentPage } from "../api/ticket-comments";
import type { TicketDataSource } from "../api/ticket-data-source";
import { TICKETS_NS } from "../i18n/namespace";
import { settleTicketWriteFailure } from "../lib/ticket-write-failure";
import type { IdempotencyKeyHolder, TicketWriteOutcome } from "../lib/ticket-write-outcome";
import { createIdempotencyKeyHolder, isUncertainAccepted, writeSignature } from "../lib/ticket-write-outcome";

/** 首屏与每次「加载更早」固定 30 条：服务端默认同值，显式传参避免两侧默认值各自漂移。 */
const COMMENT_PAGE_LIMIT = 30;

export interface TicketCommentsOptions {
  /**
   * 详情可用时才取评论。详情 404/403 时评论区根本不会渲染，为它再发一次注定失败的请求只会多一条 toast，
   * 那条 toast 还会把「这个工单不存在」的主结论挤到噪声里。
   */
  readonly enabled: boolean;
  /** 工单有待确认的写操作时为 true：新建与编辑入口一并禁用（方案 §9.6）。 */
  readonly blocked: boolean;
  /** 202 上报：待确认状态由详情页单点持有，评论区不自己造横幅。 */
  readonly onUncertain: (operationId: string) => void;
  /** 409 在途互斥（兜底通道）：详情快照里应带出在途 id，由页面刷新一次取回。 */
  readonly onOperationPending: () => void;
}

export interface TicketCommentsState {
  /** 时间正序（最新在最后），分页方向已在此吸收，组件按顺序渲染即可。 */
  comments: TicketComment[];
  loading: boolean;
  error: Error | undefined;
  /** 首屏重试（也是列表失败分支的「重试」入口）。 */
  retryFirst: () => void;
  /** 重载已加载深度（编辑冲突或核对结果之后），保持当前页数。 */
  reload: () => void;
  reloading: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => void;
  blocked: boolean;
  createDraft: string;
  setCreateDraft: (value: string) => void;
  creating: boolean;
  createComment: (body: string) => Promise<TicketWriteOutcome>;
  editing: { commentId: string; body: string } | null;
  beginEdit: (comment: TicketComment) => void;
  setEditingBody: (value: string) => void;
  cancelEdit: () => void;
  updating: boolean;
  submitEdit: () => Promise<TicketWriteOutcome>;
  /** 编辑冲突：草稿保留，等待用户点「加载最新内容」（重载成功后自动清除）。 */
  editConflict: boolean;
}

/** 新评论前插到最新一页的页首（页内也是最新在前，与接口方向一致）。 */
function prependComment(pages: TicketCommentPage[], comment: TicketComment): TicketCommentPage[] {
  const head = pages[0];
  if (head === undefined) return [{ items: [comment], nextCursor: null }];
  return [{ ...head, items: [comment, ...head.items] }, ...pages.slice(1)];
}

/** 编辑成功后就地替换：整链重取只会浪费一次请求，还会让「已加载更早页」的深度抖动。 */
function replaceComment(pages: TicketCommentPage[], comment: TicketComment): TicketCommentPage[] {
  return pages.map((page) => ({
    ...page,
    items: page.items.map((item) => (item.commentId === comment.commentId ? comment : item)),
  }));
}

function findComment(pages: TicketCommentPage[], commentId: string): TicketComment | undefined {
  return pages.flatMap((page) => page.items).find((comment) => comment.commentId === commentId);
}

/**
 * 评论区编排层。
 *
 * `source` 是**依赖**而不是行为开关：控制台面与控制台管理面共用同一套取数、写状态机与失败分类，
 * 差别只在请求打到哪个协议面（见 `api/ticket-data-source`）。
 */
export function useTicketComments(
  projectId: string,
  number: string,
  source: TicketDataSource,
  options: TicketCommentsOptions,
): TicketCommentsState {
  const { t } = useTranslation(TICKETS_NS);
  /** `pages[0]` = 最新一页；页序与页内都是「最新在前」。 */
  const [pages, setPages] = useState<TicketCommentPage[]>([]);
  const [createDraft, setCreateDraft] = useState("");
  const [editing, setEditing] = useState<{ commentId: string; body: string } | null>(null);
  const [editConflict, setEditConflict] = useState(false);
  const blocked = options.blocked;

  const first = useRequest(async () => unwrap(source.comments.list(projectId, number, { limit: COMMENT_PAGE_LIMIT })), {
    ready: options.enabled,
    refreshDeps: [projectId, number, options.enabled],
    onSuccess: (page) => setPages([page]),
    onError: (err: Error) => {
      console.error("ticket comments load failed", err);
      toast.error(err.message || t("comment.loadFailed"));
    },
  });

  const older = useRequest(
    async (cursor: string) => unwrap(source.comments.list(projectId, number, { cursor, limit: COMMENT_PAGE_LIMIT })),
    {
      manual: true,
      onSuccess: (page) => setPages((prev) => [...prev, page]),
      onError: (err: Error) => {
        // 已加载的评论仍然可用，失败只提示（重试入口就是那颗按钮本身，点击即重取同一游标）。
        console.error("ticket comments load older failed", err);
        toast.error(err.message || t("comment.loadFailed"));
      },
    },
  );

  const reloadRequest = useRequest(
    async () => {
      // 按当前深度重取同样页数：游标用每页新返回值（期间有新评论到达时链条仍自洽）。
      const depth = Math.max(1, pages.length);
      const next: TicketCommentPage[] = [];
      let cursor: string | undefined;
      for (let index = 0; index < depth; index += 1) {
        const page = await unwrap(
          source.comments.list(projectId, number, {
            ...(cursor === undefined ? {} : { cursor }),
            limit: COMMENT_PAGE_LIMIT,
          }),
        );
        next.push(page);
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      return next;
    },
    {
      manual: true,
      onSuccess: (next) => {
        setPages(next);
        setEditConflict(false);
      },
      onError: (err: Error) => {
        console.error("ticket comments reload failed", err);
        toast.error(err.message || t("comment.loadFailed"));
      },
    },
  );

  // 换工单后清掉上一单的草稿与冲突：草稿跟着旧工单留在新页面上，用户会以为自己写错了地方。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 两个路由参数是刻意的重置触发信号，effect 体只用 setter。
  useEffect(() => {
    setPages([]);
    setCreateDraft("");
    setEditing(null);
    setEditConflict(false);
  }, [projectId, number]);

  const createHolder = useMemo(() => createIdempotencyKeyHolder(), []);
  const editHolder = useMemo(() => createIdempotencyKeyHolder(), []);

  const createRequest = useRequest(
    async (payload: { body: string; key: string }) =>
      unwrap(source.comments.create(projectId, number, { body: payload.body }, payload.key)),
    { manual: true },
  );
  const updateRequest = useRequest(
    async (payload: { commentId: string; body: string; expectedVersion: string; key: string }) =>
      unwrap(
        source.comments.update(
          projectId,
          number,
          payload.commentId,
          { body: payload.body, expectedVersion: payload.expectedVersion },
          payload.key,
        ),
      ),
    { manual: true },
  );

  const comments = useMemo(() => [...pages].reverse().flatMap((page) => [...page.items].reverse()), [pages]);
  const nextCursor = pages.at(-1)?.nextCursor ?? null;

  /** 评论写路径的失败终局：矩阵与详情写路径同一份（`lib/ticket-write-failure`），差异只在于无刷新权。 */
  const settleError = (
    error: unknown,
    failureMessageKey: string,
    onConflict: () => void,
    holder: IdempotencyKeyHolder,
  ): TicketWriteOutcome =>
    settleTicketWriteFailure(error, {
      t,
      holder,
      failureMessageKey,
      logLabel: "ticket comment write failed",
      onVersionConflict: onConflict,
      // 评论在别处被删或工单被换掉：列表已不代表真实内容，重载一次把自己对齐。
      onNotFound: () => reloadRequest.run(),
      onOperationPending: options.onOperationPending,
    });

  const createComment = async (body: string): Promise<TicketWriteOutcome> => {
    if (blocked) return "blocked";
    const key = createHolder.take(writeSignature([body]));
    try {
      const result = await createRequest.runAsync({ body, key });
      if (isUncertainAccepted(result)) {
        options.onUncertain(result.operationId);
        toast.warning(t("comment.createAccepted"));
        return "accepted";
      }
      createHolder.reset();
      setPages((prev) => prependComment(prev, result.comment));
      setCreateDraft("");
      toast.success(t("comment.created"));
      return "applied";
    } catch (error) {
      // 新建评论的签名里没有版本（服务端按时间追加，不存在「基于旧内容提交」这回事），版本冲突因而
      // 不是一个用户可处置的状态：只提示、草稿原样留在输入框里，用户直接再点一次即可。
      return settleError(error, "comment.createFailed", () => toast.error(t("write.conflict")), createHolder);
    }
  };

  const submitEdit = async (): Promise<TicketWriteOutcome> => {
    const draft = editing;
    if (draft === null) return "failed";
    if (blocked) return "blocked";
    const target = findComment(pages, draft.commentId);
    if (target === undefined) {
      toast.error(t("comment.updateFailed"));
      return "failed";
    }
    const key = editHolder.take(writeSignature([draft.body, target.version]));
    try {
      const result = await updateRequest.runAsync({
        commentId: draft.commentId,
        body: draft.body,
        expectedVersion: target.version,
        key,
      });
      if (isUncertainAccepted(result)) {
        options.onUncertain(result.operationId);
        toast.warning(t("comment.updateAccepted"));
        return "accepted";
      }
      editHolder.reset();
      setPages((prev) => replaceComment(prev, result.comment));
      setEditing(null);
      setEditConflict(false);
      toast.success(t("comment.updated"));
      return "applied";
    } catch (error) {
      return settleError(error, "comment.updateFailed", () => setEditConflict(true), editHolder);
    }
  };

  return {
    comments,
    loading: first.loading,
    error: first.error,
    retryFirst: first.refresh,
    reload: reloadRequest.run,
    reloading: reloadRequest.loading,
    hasOlder: nextCursor !== null,
    loadingOlder: older.loading,
    loadOlder: () => older.run(nextCursor ?? ""),
    blocked,
    createDraft,
    setCreateDraft,
    creating: createRequest.loading,
    createComment,
    editing,
    beginEdit: (comment: TicketComment) => {
      setEditing({ commentId: comment.commentId, body: comment.body });
      setEditConflict(false);
    },
    setEditingBody: (value: string) => setEditing((prev) => (prev === null ? prev : { ...prev, body: value })),
    cancelEdit: () => {
      setEditing(null);
      setEditConflict(false);
    },
    updating: updateRequest.loading,
    submitEdit,
    editConflict,
  };
}
