/**
 * 工单列表的编排层：项目上下文 + 列表两条取数、筛选与游标翻页。
 *
 * 只做取数与状态，不渲染任何东西、不 import UI 组件（组件层拿它返回的纯数据与回调），因此筛选/翻页
 * 逻辑可以在没有界面的用例里断言。
 *
 * 三条与后端形状绑定的口径：
 * 1. 组织未开通（`state === "unconfigured"`）时**不发列表请求**（`ready`）。「不发请求」是关闭语义的
 *    硬要求，不能靠「先请求、拿 404 再降级」实现。
 * 2. 暂停（`state === "paused"`）**不阻断读取**：暂停只拦写路径（写请求由服务端以 503 拒绝），列表
 *    照常展示，因此这里只按 `unconfigured` 与「默认项目缺失」判 ready。
 * 3. 列表行没有页级 `syncStatus`/`syncedAt`，只有行级字段；「索引已降级」由 {@link useTicketList} 的
 *    `syncDegraded` 从行集合派生，不为迎合旧版页面模型虚构服务端字段。
 *
 * 筛选与分页**不落 URL**：`/agent/tickets` 只表达「当前组织的默认项目」，筛选是会话内状态；工单详情
 * 的稳定链接由显式 `projectId` + 工单号承载。
 */

import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { TicketProjectState } from "../api/ticket-projects";
import { ticketProjectsApi } from "../api/ticket-projects";
import type { TicketStateFilter, TicketSummary } from "../api/tickets";
import { ticketApi } from "../api/tickets";
import { TICKETS_NS } from "../i18n/namespace";

/** 服务端默认与上限分别是 30 / 100；显式传值，避免默认值在两侧各自漂移。 */
const TICKET_PAGE_LIMIT = 30;

/** 搜索防抖窗口（与任务列表同款）：输入即时上屏，请求 300ms 后触发。 */
const SEARCH_DEBOUNCE_MS = 300;

export function useTicketList() {
  const { t } = useTranslation(TICKETS_NS);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<TicketStateFilter>("all");
  /** 游标栈：栈为空 = 第一页；栈顶 = 当前页游标（后端游标只向前，回退靠栈）。 */
  const [cursorStack, setCursorStack] = useState<string[]>([]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // 筛选变化回到第一页。effect 体只调 setCursorStack，两个依赖是刻意的触发信号（规则看不到「依赖变化
  // 即重置」的意图），移除会让筛选后仍停留在旧页游标上。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖是刻意的重置触发信号。
  useEffect(() => {
    setCursorStack([]);
  }, [debouncedQuery, stateFilter]);

  const {
    data: overview,
    loading: projectsLoading,
    error: projectsError,
    refresh: refreshProjects,
  } = useRequest(async () => unwrap(ticketProjectsApi.overview()), {
    onError: (err: Error) => {
      // 只上屏字典文案：`err.message` 是后端信封原文，进 console 供排障，不上屏。
      console.error("ticket projects load failed", err);
      toast.error(t("toast.projectsLoadFailed"));
    },
  });

  const state: TicketProjectState | null = overview?.state ?? null;
  const projectId = overview?.defaultProjectId ?? null;
  const listReady = projectId !== null && state !== null && state !== "unconfigured";
  const cursor = cursorStack.at(-1);

  const {
    data: page,
    loading,
    error: listError,
    refresh: refreshList,
  } = useRequest(
    async () =>
      unwrap(
        ticketApi.list(projectId ?? "", {
          q: debouncedQuery.trim() || undefined,
          state: stateFilter === "all" ? undefined : stateFilter,
          cursor,
          limit: TICKET_PAGE_LIMIT,
        }),
      ),
    {
      ready: listReady,
      refreshDeps: [projectId, cursor, debouncedQuery, stateFilter],
      onError: (err: Error) => {
        // 列表失败的主反馈是页面里持久的 `role="alert"` 分支（带重试），这条 toast 只补一个即时信号。
        console.error("ticket list load failed", err);
        toast.error(t("toast.loadFailed"));
      },
    },
  );

  const items: TicketSummary[] = page?.items ?? [];
  const nextCursor = page?.nextCursor ?? null;

  return {
    state,
    projectId,
    items,
    nextCursor,
    /** 行级索引新鲜度派生的整体降级标记：任一行 `stale` 即视为索引未同步到最新。 */
    syncDegraded: items.some((item) => item.syncStatus === "stale"),
    query,
    setQuery,
    stateFilter,
    setStateFilter,
    pageIndex: cursorStack.length,
    hasPrevPage: cursorStack.length > 0,
    goPrevPage: () => setCursorStack((stack) => stack.slice(0, -1)),
    goNextPage: () => setCursorStack((stack) => (nextCursor ? [...stack, nextCursor] : stack)),
    loading,
    projectsLoading,
    /** 列表失败（页面据此走持久错误分支）；项目总览失败另有 `projectsError`。 */
    error: listError,
    projectsError,
    refresh: () => {
      refreshList();
      refreshProjects();
    },
  };
}
