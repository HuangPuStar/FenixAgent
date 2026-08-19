// web/src/pages/admin/components/ObserverFlatTable.tsx
// 全部观察平坦表（id / source / 各角色 id / openTime），便于与树视图对照（docs/arch/21 §5）。
// 数据来自 utils.mergeFlatRows（byOrg + byEntity 去重合并）。

import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ObserverNames } from "../../../api/observer";
import { type FlatRow, name } from "../utils";

interface ObserverFlatTableProps {
  rows: FlatRow[];
  names: ObserverNames;
}

function Cell({ roleKey, value, names }: { roleKey: keyof ObserverNames; value: string | null; names: ObserverNames }) {
  if (!value) return <TableCell className="text-xs text-text-muted">—</TableCell>;
  // name(id)：展示可读名称，原始 id 以弱化小字跟随，便于与树视图对照
  const display = name(names, roleKey, value);
  return (
    <TableCell className="text-xs">
      <span className="font-mono text-text-primary">{display}</span>
      {display !== value ? <span className="ml-1 font-mono text-[10px] text-text-muted">{value}</span> : null}
    </TableCell>
  );
}

export function ObserverFlatTable({ rows, names }: ObserverFlatTableProps) {
  const { t } = useTranslation("observer");
  if (rows.length === 0) return null;

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("flat.id")}</TableHead>
            <TableHead>{t("flat.source")}</TableHead>
            <TableHead>{t("flat.organizationId")}</TableHead>
            <TableHead>{t("flat.userId")}</TableHead>
            <TableHead>{t("flat.agentConfigId")}</TableHead>
            <TableHead>{t("flat.instanceId")}</TableHead>
            <TableHead>{t("flat.machineId")}</TableHead>
            <TableHead>{t("flat.openTime")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="font-mono text-xs">{row.id}</TableCell>
              <TableCell>
                <Badge variant="outline" className="text-[10px]">
                  {t(`source.${row.source}`, { defaultValue: row.source })}
                </Badge>
              </TableCell>
              <Cell roleKey="organizationId" value={row.organizationId} names={names} />
              <Cell roleKey="userId" value={row.userId} names={names} />
              <Cell roleKey="agentConfigId" value={row.agentConfigId} names={names} />
              <Cell roleKey="instanceId" value={row.instanceId} names={names} />
              <Cell roleKey="machineId" value={row.machineId} names={names} />
              <TableCell className="text-xs text-text-muted">
                {row.openTime ? new Date(row.openTime).toLocaleString() : "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
