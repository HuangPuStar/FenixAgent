/**
 * 可指派成员候选的取数层：服务端搜索（300ms 防抖）+ 页码翻页 + 只在选择器展开时拉取。
 *
 * 三条与后端形状绑定的口径：
 * 1. 候选**只**来自 `GET /web/ticket-projects/:projectId/members`：服务端已把组织成员收窄成
 *    `{ userId, name }`。界面不得自己拼组织成员列表——那条路会把邮箱、账号状态这类字段带进浏览器，
 *    而「候选里能出现谁」是授权判定，不是渲染细节。
 * 2. 分页是 `page` / `pageSize` + `total`，不是游标（以 F1 冻结的 `TicketProjectMemberPage` 为准；
 *    前端合同 §6.1 的「游标翻页 / `nextCursor`」是端点冻结前的旧口径）：`hasMore` 由「已加载条数 < total」
 *    派生，翻页用「已加载页数 + 1」而不是自增游标栈。
 * 3. 关键词变化**回到第一页并丢弃已翻的页**：候选必须与当前关键词严格对应，否则用户会在「搜索 A 的结果」
 *    里选中一个与 A 无关的人。首屏失败同样清空列表（错误分支优先于空态），避免旧结果冒充新结果。
 *
 * 只在展开时取数（`open`）：详情页默认不打开选择器，没必要为它多打一次请求。收起不清关键词与列表，
 * 重新展开即按同一关键词拉第一页。
 */

import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { TicketProjectMember, TicketProjectMemberPage } from "../api/ticket-projects";
import { ticketProjectsApi } from "../api/ticket-projects";
import { TICKETS_NS } from "../i18n/namespace";

/** 服务端默认 20、上限 100：一页 20 条足够铺满弹层，其余由「加载更多成员」显式请求。 */
const MEMBER_PAGE_SIZE = 20;

/** 搜索防抖窗口（与工单列表同款）：输入即时上屏，请求 300ms 后触发。 */
const MEMBER_SEARCH_DEBOUNCE_MS = 300;

export interface TicketMembersOptions {
  /** 选择器是否展开：候选只在展开时请求。 */
  readonly open: boolean;
}

export interface TicketMembersState {
  /** 已加载的候选（跨页累积，按服务端排序）。 */
  members: TicketProjectMember[];
  /** 首屏取数中（含关键词变化后的重取）。 */
  loading: boolean;
  /** 首屏失败：界面显示错误态 + 重试（「加载更多」失败只提示，不占这个字段）。 */
  error: Error | undefined;
  retry: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  /** 输入框的值（即时）与它的防抖副本由 hook 持有，组件只上报。 */
  query: string;
  setQuery: (value: string) => void;
}

export function useTicketMembers(projectId: string, options: TicketMembersOptions): TicketMembersState {
  const { t } = useTranslation(TICKETS_NS);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [pages, setPages] = useState<TicketProjectMemberPage[]>([]);

  const fetchPage = async (params: { q: string; page: number }) =>
    unwrap(
      ticketProjectsApi.members(projectId, {
        q: params.q.trim() || undefined,
        page: params.page,
        pageSize: MEMBER_PAGE_SIZE,
      }),
    );

  // 首屏与「加载更多」各持一个 request 实例：共用一个实例时后发请求会把先发的 promise 挂起（ahooks 的
  // 取消语义），且两处失败会挤同一个 `error`——「加载更多」失败会把已经加载好的列表整个换成错误态。
  const first = useRequest(async (q: string) => fetchPage({ q, page: 1 }), {
    manual: true,
    onBefore: () => setPages([]),
    onSuccess: (page) => setPages([page]),
    onError: (err: Error) => {
      console.error("ticket members load failed", err);
    },
  });
  const more = useRequest(async (params: { q: string; page: number }) => fetchPage(params), {
    manual: true,
    onSuccess: (page) => setPages((prev) => [...prev, page]),
    onError: (err: Error) => {
      // 已加载的候选仍然可用：只补一条即时提示，不把列表换成错误态。
      console.error("ticket members load more failed", err);
      // 服务端 `message` 优先上屏（它才是可定位的失败原因），字典文案只在它是空串时兜底。
      toast.error(err.message || t("assignee.loadFailed"));
    },
  });

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), MEMBER_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const runFirst = first.run;
  // 展开时拉第一页；打开期间关键词变化回到第一页。收起时不发请求（防抖回调可能在收起后才到）。
  useEffect(() => {
    if (!options.open) return;
    runFirst(debouncedQuery);
  }, [options.open, debouncedQuery, runFirst]);

  const members = pages.flatMap((page) => page.items);
  const total = pages.at(-1)?.total ?? 0;

  return {
    members,
    loading: first.loading,
    error: first.error,
    retry: () => runFirst(debouncedQuery),
    hasMore: members.length < total,
    loadingMore: more.loading,
    loadMore: () => {
      // 首屏取数中不发「加载更多」：它会把首屏 promise 挂起，页面停在空列表上。
      if (first.loading || more.loading) return;
      more.run({ q: debouncedQuery, page: pages.length + 1 });
    },
    query,
    setQuery,
  };
}
