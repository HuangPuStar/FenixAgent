/**
 * `Table`：只读明细表，切片 1 的叶类型之一。
 *
 * 复用既有 `web/ui/table.tsx` 原语（含它自带的 `data-slot="table-container"` 横向滚动容器），
 * **不冒用 streamdown 的 `data-streamdown="table-wrapper"` 属性**：那套属性属于 streamdown 自己的
 * 表格 DOM，markdown 伴随表对它的后代选择器与全屏/复制按钮逻辑都不该落到自有表格上（§1.6）。
 *
 * 两处与消息区既有 CSS 的交互由伴随表 `UISpecBlock.css` 收口（该表未包 `@layer`、以 (0,1,1) 压过工具类）：
 * - 宽表宽度上限：markdown 的 `table { max-width: 100% }` 会把表格钉死在滚动容器宽度上；
 * - 列对齐：markdown 的 `th, td { text-align: left }` 会压过 `text-right` 工具类，故对齐用 `data-align`。
 *
 * 行列等长、上限、align 长度等**跨字段规则**在 `catalog.ts` / `parse.ts` 侧判定（§5.3）：校验不通过的
 * 元素由 `UISpecView` 就地占位，不会走到本组件。这里只消费判定结果，单元格一律作文本节点渲染。
 */

import type { z } from "zod/v4";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "../../../ui/table";
import type { uiSpecCatalog } from "../catalog";

export type TableViewProps = z.infer<typeof uiSpecCatalog.Table.props>;

/** 列对齐：`align` 缺省按全 `left`，长度不足的列同样落回 `left`（§5.3）。 */
const DEFAULT_ALIGN = "left";

export function TableView({ caption, columns, rows, align }: TableViewProps) {
  const alignment = columns.map((_, index) => align?.[index] ?? DEFAULT_ALIGN);

  return (
    <div data-slot="ui-spec-table" className="min-w-0">
      <Table>
        {caption ? <TableCaption className="text-left">{caption}</TableCaption> : null}
        <TableHeader>
          <TableRow>
            {columns.map((column, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 列只有位置身份（目录里的 columns 是字符串数组、允许同名），表格整体在 code 变化时重建、不重排，索引键不会引起元素错位。
              <TableHead key={index} data-align={alignment[index]}>
                {column}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, rowIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 同上——行没有 id，只有位置身份。
            <TableRow key={rowIndex}>
              {row.map((cell, cellIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 同上——单元格身份 = (行, 列) 位置。
                <TableCell key={cellIndex} data-align={alignment[cellIndex]}>
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
