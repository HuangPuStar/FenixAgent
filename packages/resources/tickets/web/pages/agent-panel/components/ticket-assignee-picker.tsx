/**
 * 负责人选择器：`Popover` + `Command`（服务端搜索，`shouldFilter={false}`）+ 选择即提交。
 *
 * 三条来自合同的交互口径：
 * 1. **不做乐观更新**：选完就关弹层，界面上的负责人等下一次回填（成功）或**根本不变**（失败）——服务端才是
 *    唯一事实，先改后撤的中间态只会让人以为改成功了；
 * 2. 顶部固定「取消指派」（`assigneeId: null`，与「字段省略」严格区分），当前负责人打勾；
 * 3. 当前负责人**不在候选列表里**（离职、外部账号）时，触发器直接显示工单自带的 `assignee.name`：详情里
 *    已经有这份快照，不需要为它造占位符或额外请求。
 *
 * 候选取数在组件内（`useTicketMembers` 只在展开时请求）：它没有任何写动作，混进页面的写状态机只会让页面
 * 多背一份与它无关的状态。**例外是平台管理面**：那里的候选来自系统端点，由页面经 `members` 注入；此时
 * 内层 hook 以 `open: false` 挂载（不发任何请求），同一次渲染里仍然只有一份候选状态。
 */

import { Button } from "@fenix/ui-components/ui/button";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@fenix/ui-components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@fenix/ui-components/ui/popover";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { Check, ChevronsUpDown, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { webTicketDataSource } from "../../../api/ticket-data-source";
import type { TicketActor } from "../../../api/tickets";
import type { TicketMembersState } from "../../../hooks/use-ticket-members";
import { useTicketMembers } from "../../../hooks/use-ticket-members";
import { TICKETS_NS } from "../../../i18n/namespace";

/** 候选加载骨架行：盖住弹层刚打开到第一页返回之间的空白。固定三行、固定 key（纯装饰，不用下标做 key）。 */
const MEMBER_SKELETON_ROWS = ["first", "second", "third"] as const;

export interface TicketAssigneePickerProps {
  projectId: string;
  assignee: TicketActor | null;
  onSelect: (userId: string | null) => void;
  /** 有待确认的写、或**任何**写动作进行中（含本次指派）：不准改。 */
  disabled: boolean;
  /**
   * 候选状态的外部注入（平台管理面用，见文件头）。省略即在组件内按控制台面取数（默认路径）；
   * 注入时内层 hook 以 `open: false` 挂载：它不发请求，只是为了不违反 hook 调用规则而存在。
   */
  members?: TicketMembersState;
  /**
   * 弹层开合的对外通知：注入 `members` 的一方靠它决定「什么时候才去取候选」（候选只在展开时请求）。
   * 省略即弹层开合完全由组件自持（控制台面的默认路径）。
   */
  onOpenChange?: (open: boolean) => void;
}

export function TicketAssigneePicker({
  projectId,
  assignee,
  onSelect,
  disabled,
  members: injectedMembers,
  onOpenChange,
}: TicketAssigneePickerProps) {
  const { t } = useTranslation(TICKETS_NS);
  const [open, setOpen] = useState(false);
  const webMembers = useTicketMembers(projectId, webTicketDataSource, { open: open && injectedMembers === undefined });
  const members = injectedMembers ?? webMembers;
  const label = assignee === null ? t("list.unassigned") : assignee.name;

  const handleOpenChange = (next: boolean): void => {
    setOpen(next);
    onOpenChange?.(next);
  };

  const select = (userId: string | null): void => {
    handleOpenChange(false);
    onSelect(userId);
  };

  return (
    <Popover onOpenChange={handleOpenChange} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          aria-label={t("assignee.label")}
          className="max-w-56 justify-between"
          disabled={disabled}
          role="combobox"
          size="sm"
          variant="outline"
        >
          <span className="truncate">{label}</span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
        {/* shouldFilter=false：过滤在服务端（`q`），cmdk 再本地过滤一遍会把服务端返回的候选挡掉。 */}
        <Command shouldFilter={false}>
          <CommandInput
            aria-label={t("assignee.searchPlaceholder")}
            onValueChange={members.setQuery}
            placeholder={t("assignee.searchPlaceholder")}
            value={members.query}
          />
          <CommandList
            className="max-h-64 overflow-y-auto overscroll-contain"
            onWheel={(event) => event.stopPropagation()}
          >
            <CommandGroup>
              <CommandItem onSelect={() => select(null)} value="__unassigned__">
                <Check className={assignee === null ? "size-4 opacity-100" : "size-4 opacity-0"} />
                <span className="truncate">{t("assignee.clear")}</span>
              </CommandItem>
              {members.members.map((member) => (
                <CommandItem key={member.userId} onSelect={() => select(member.userId)} value={member.userId}>
                  <Check className={assignee?.id === member.userId ? "size-4 opacity-100" : "size-4 opacity-0"} />
                  <span className="truncate">{member.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          <MemberListFooter
            error={members.error}
            hasMore={members.hasMore}
            loading={members.loading}
            loadingMore={members.loadingMore}
            onLoadMore={members.loadMore}
            onRetry={members.retry}
            shown={members.members.length}
          />
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** 弹层底部：加载中骨架、失败重试、「加载更多」三者之一；候选为空时的空文案由 `CommandEmpty` 承担。 */
function MemberListFooter({
  loading,
  loadingMore,
  hasMore,
  error,
  shown,
  onLoadMore,
  onRetry,
}: {
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: Error | undefined;
  shown: number;
  onLoadMore: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation(TICKETS_NS);

  if (loading) {
    // 加载态用骨架而不是文案：本包字典没有通用的「加载中」，而为一个行内占位新增键会与 LoadedCount 那类
    // 计数文案一样很快过期；骨架不依赖语言，也不会在弹层里跳出一行突兀的灰字。
    return (
      <div className="flex flex-col gap-2 border-t p-2">
        {MEMBER_SKELETON_ROWS.map((row) => (
          <Skeleton className="h-5 w-full" key={`member-skeleton-${row}`} />
        ))}
      </div>
    );
  }

  if (error !== undefined) {
    return (
      <div className="flex flex-wrap items-center gap-2 border-t px-2 py-2 text-xs text-text-secondary" role="alert">
        <span>{t("assignee.loadFailed")}</span>
        {/* 服务端信封原文与固定文案并列：固定文案说明「哪一步失败」，原文才给出可定位的原因。 */}
        {error.message ? <span>{error.message}</span> : null}
        <Button onClick={onRetry} size="sm" type="button" variant="outline">
          <RefreshCw className="size-3.5" />
          {t("loadState.retry")}
        </Button>
      </div>
    );
  }

  if (shown === 0) {
    // 自己渲染而不是 `CommandEmpty`：那个组件的判据是「列表里一个 item 都没有」，而「取消指派」常驻，
    // 判据永远不成立——它会安静地什么都不显示，恰好在「搜不到人」时最该有反馈。
    return <div className="px-3 py-3 text-xs text-text-dim">{t("assignee.empty")}</div>;
  }

  if (!hasMore) return null;

  return (
    <div className="border-t p-2">
      <Button className="w-full" disabled={loadingMore} onClick={onLoadMore} size="sm" type="button" variant="ghost">
        {t("assignee.loadMore")}
      </Button>
    </div>
  );
}
