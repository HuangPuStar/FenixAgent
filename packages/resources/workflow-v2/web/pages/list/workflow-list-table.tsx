// pages/list/workflow-list-table.tsx
// 列表页的表格与行操作：名称 / 状态 / 最后修改 / 操作（打开、日志、更多）。
//
// 表格形态对齐仓内列表页的标准写法（`task/web/.../agent-tasks-registry.tsx` 的表结构 + `ui/table` 原语）：
// 外层一层带边框圆角、横向可滚动的容器，表头用低对比小字，行操作收在一列右对齐。差异只有一处——这里全部用
// 主题 token（`text-text-muted` / `bg-muted/40`），不照抄参照页的 `slate-*` 硬编码色与页面级 CSS。
//
// 行操作**只有三个可见项**：打开（导航到画布）、日志（发布记录弹窗，弹窗由页面装配）、更多（下拉承载发布 /
// 重命名 / 删除）。收拢的理由是这一行此前会同时出现五个文字按钮，发布与删除这类**写动作**混在导航与查看之间，
// 误点代价不同却长得一样。表格仍只把目标对象交给回调，不自己发请求（§3.5 的「渲染组件不发请求」）。
//
// 画布深链的路由参数是 **上游 workflow ID**（`pages/canvas/canvas-host-page.tsx` 的文件头说明）：它同时是
// 一次性的 code 的 `workflowId`、画布 URL 的 `workflow_id` 与票据 `claims.wf`，三者必须逐字一致，因此这里
// 不做任何 id 转换。发布与日志走**本地主键**（`api/workflow-publish.ts` 的身份口径）。

import { StatusBadge } from "@fenix/ui-components/config/StatusBadge";
import { Button } from "@fenix/ui-components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@fenix/ui-components/ui/dropdown-menu";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@fenix/ui-components/ui/table";
import { Link } from "@tanstack/react-router";
import { MoreHorizontal, Pencil, ScrollText, SquareArrowOutUpRight, Trash2, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { WorkflowV2WorkflowItem } from "../../api/workflows";
import { WORKFLOW_NS } from "../../i18n/namespace";
import { describeWorkflowStatus, resolveUpdatedAt } from "./workflow-list-model";
import { PUBLISH_ACTION_LABEL_KEYS } from "./workflow-publish-model";

/** 行内动作按钮的统一尺寸（同一行的动作都用它，尺寸不一致会让列看起来在跳）。 */
const ROW_ACTION_SIZE = "xs";

/** 表头单元格：低对比小字（参照页的写法，色值改用主题 token）。 */
const HEAD_CELL_CLASS = "px-3 text-xs font-medium text-text-muted";

/** 数据单元格的横向留白与纵向节奏。 */
const BODY_CELL_CLASS = "px-3 py-2.5";

/** `t` 的最小签名：格式函数不依赖 i18next 的泛型实例（包内不引入域外类型）。 */
type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 最后修改：相对时间走字典（`count` 由 i18next 插值），超过一周回退成日期串。 */
function formatUpdatedAt(iso: string, t: Translate): string {
  const view = resolveUpdatedAt(iso, Date.now());
  if (view.kind === "date") return new Date(view.iso).toLocaleDateString();
  return t(view.key, { count: view.count });
}

export interface WorkflowListTableProps {
  readonly items: readonly WorkflowV2WorkflowItem[];
  /** 重命名入口（装配由页面负责，表格不持有弹窗状态）。 */
  readonly onRename: (item: WorkflowV2WorkflowItem) => void;
  readonly onDelete: (item: WorkflowV2WorkflowItem) => void;
  /** 发布入口（本地主键寻址；页面负责调接口与提示）。 */
  readonly onPublish: (item: WorkflowV2WorkflowItem) => void;
  /** 日志入口（上游发布记录弹窗；弹窗由页面装配）。 */
  readonly onOpenLogs: (item: WorkflowV2WorkflowItem) => void;
  /**
   * 正在发布的行（本地主键）；非 null 时**所有**发布项置灰。
   *
   * 串行是刻意的：并发发布同一 workflow 会撞上「版本未自增」，并发发布不同 workflow 也只会让审计里出现两条
   * 互相穿插的版本推进——控制台的发布是用户主动的一次动作，不值得为并发再引入队列。
   */
  readonly publishingId: string | null;
}

export function WorkflowListTable({
  items,
  onRename,
  onDelete,
  onPublish,
  onOpenLogs,
  publishingId,
}: WorkflowListTableProps) {
  const { t } = useTranslation(WORKFLOW_NS);
  const publishBusy = publishingId !== null;

  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader className="bg-muted/40">
          <TableRow>
            <TableHead className={HEAD_CELL_CLASS}>{t("list.column_name")}</TableHead>
            <TableHead className={`w-32 ${HEAD_CELL_CLASS}`}>{t("list.column_status")}</TableHead>
            <TableHead className={`w-40 ${HEAD_CELL_CLASS}`}>{t("list.table_modified")}</TableHead>
            <TableHead className={`w-56 text-right ${HEAD_CELL_CLASS}`}>{t("list.column_actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const status = describeWorkflowStatus(item);
            const publishing = publishingId === item.id;
            return (
              <TableRow key={item.id}>
                <TableCell className={`font-medium ${BODY_CELL_CLASS}`}>
                  {item.name}
                  {status.version !== null ? (
                    <span className="ml-2 text-xs text-text-muted">{`v${status.version}`}</span>
                  ) : null}
                </TableCell>
                <TableCell className={BODY_CELL_CLASS}>
                  <StatusBadge status={status.labelKey} label={t(status.labelKey)} tone={status.tone} />
                </TableCell>
                <TableCell className={`text-text-muted ${BODY_CELL_CLASS}`}>
                  {formatUpdatedAt(item.updatedAt, t)}
                </TableCell>
                <TableCell className={BODY_CELL_CLASS}>
                  <div className="flex items-center justify-end gap-1">
                    <Button asChild size={ROW_ACTION_SIZE} variant="ghost">
                      <Link to="/agent/workflow/$id/edit" params={{ id: item.upstreamWorkflowId }}>
                        <SquareArrowOutUpRight />
                        {t("list.open")}
                      </Link>
                    </Button>
                    <Button size={ROW_ACTION_SIZE} variant="ghost" onClick={() => onOpenLogs(item)}>
                      <ScrollText />
                      {t("list.log")}
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        {/* 图标触发器：可访问名由 `aria-label` 给（可见文案只有省略号）。 */}
                        <Button size="icon-xs" variant="ghost" aria-label={t("list.more_actions")}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {/* 发布是本行唯一的写动作，因此留在菜单首项并自带进行中态。 */}
                        <DropdownMenuItem disabled={publishBusy} onClick={() => onPublish(item)}>
                          {publishing ? <Spinner size="xs" label={t("publish.action_publishing")} /> : <Upload />}
                          {t(publishing ? PUBLISH_ACTION_LABEL_KEYS.busy : PUBLISH_ACTION_LABEL_KEYS.idle)}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onRename(item)}>
                          <Pencil />
                          {t("list.rename")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => onDelete(item)}>
                          <Trash2 />
                          {t("list.delete")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
