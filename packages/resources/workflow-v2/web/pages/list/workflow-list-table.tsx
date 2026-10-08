// pages/list/workflow-list-table.tsx
// 列表页的表格与行操作：名称 / 状态 / 更新时间 / 操作（打开画布、重命名、删除）。
//
// 行操作的语义边界：**打开画布**是导航（`<Link>`，壳内跳转，冻结 §6.1 的路由不变），重命名与删除是
// 本页的动作（弹窗由页面装配）——表格只把目标对象交给回调，不自己发请求（§3.5 的「渲染组件不发请求」）。
//
// 画布深链的路由参数是 **上游 workflow ID**（`pages/canvas/canvas-host-page.tsx` 的文件头说明）：它同时
// 是一次性 code 的 `workflowId`、画布 URL 的 `workflow_id` 与票据 `claims.wf`，三者必须逐字一致，因此
// 这里不做任何 id 转换。

import { StatusBadge } from "@fenix/ui-components/config/StatusBadge";
import { Button } from "@fenix/ui-components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@fenix/ui-components/ui/table";
import { Link } from "@tanstack/react-router";
import { Pencil, SquareArrowOutUpRight, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { WorkflowV2WorkflowItem } from "../../api/workflows";
import { WORKFLOW_NS } from "../../i18n/namespace";
import { describeWorkflowStatus, resolveUpdatedAt } from "./workflow-list-model";

/** 操作列按钮的统一尺寸（三个动作在同一行，尺寸不一致会让列看起来在跳）。 */
const ROW_ACTION_SIZE = "xs";

/** `t` 的最小签名：格式函数不依赖 i18next 的泛型实例（包内不引入域外类型）。 */
type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 更新时间：相对时间走字典（`count` 由 i18next 插值），超过一周回退成日期串。 */
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
}

export function WorkflowListTable({ items, onRename, onDelete }: WorkflowListTableProps) {
  const { t } = useTranslation(WORKFLOW_NS);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-1/2">{t("list.column_name")}</TableHead>
          <TableHead className="w-32">{t("list.column_status")}</TableHead>
          <TableHead className="w-40">{t("list.table_modified")}</TableHead>
          <TableHead className="text-right">{t("list.column_actions")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => {
          const status = describeWorkflowStatus(item);
          return (
            <TableRow key={item.id}>
              <TableCell className="font-medium">
                {item.name}
                {status.version !== null ? (
                  <span className="ml-2 text-xs text-text-muted">{`v${status.version}`}</span>
                ) : null}
              </TableCell>
              <TableCell>
                <StatusBadge status={status.labelKey} label={t(status.labelKey)} tone={status.tone} />
              </TableCell>
              <TableCell className="text-text-muted">{formatUpdatedAt(item.updatedAt, t)}</TableCell>
              <TableCell>
                <div className="flex items-center justify-end gap-1">
                  <Button asChild size={ROW_ACTION_SIZE} variant="ghost">
                    <Link to="/agent/workflow/$id/edit" params={{ id: item.upstreamWorkflowId }}>
                      <SquareArrowOutUpRight />
                      {t("list.open_canvas")}
                    </Link>
                  </Button>
                  <Button size={ROW_ACTION_SIZE} variant="ghost" onClick={() => onRename(item)}>
                    <Pencil />
                    {t("list.rename")}
                  </Button>
                  <Button size={ROW_ACTION_SIZE} variant="ghost" onClick={() => onDelete(item)}>
                    <Trash2 />
                    {t("list.delete")}
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
