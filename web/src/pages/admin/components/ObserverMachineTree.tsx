// web/src/pages/admin/components/ObserverMachineTree.tsx
// machine 树（byEntity）：每行 machineId + 计数，展开列出名下全部 leaf。
// 行可点击 → 拓扑反查：把该 machine 承载的 leaf 在归属树中高亮。

import { Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import type { ObserverMachineTree as ObserverMachineTreeView, ObserverNames } from "../../../api/observer";
import { cn } from "../../../lib/utils";
import { name } from "../utils";

interface ObserverMachineTreeProps {
  machines: ObserverMachineTreeView[];
  selectedMachineId: string | null;
  onSelectMachine: (machineId: string | null) => void;
  names: ObserverNames;
}

export function ObserverMachineTree({ machines, selectedMachineId, onSelectMachine, names }: ObserverMachineTreeProps) {
  const { t } = useTranslation("observer");
  if (machines.length === 0) return null;

  return (
    <ul className="space-y-1">
      {machines.map((machine) => {
        const selected = machine.machineId === selectedMachineId;
        // name(id)：machine 名称优先展示，原始 id 弱化跟随
        const display = name(names, "machineId", machine.machineId);
        return (
          <li key={machine.machineId} className="rounded-md">
            <div
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent",
                selected && "bg-brand/10 ring-1 ring-brand/40",
              )}
            >
              <Server className="size-3.5 text-text-muted" />
              <button
                type="button"
                onClick={() => onSelectMachine(selected ? null : machine.machineId)}
                className="flex flex-1 items-center gap-2 text-left"
                title={t("tree.selectMachine")}
              >
                <span className="font-mono text-text-primary">{display}</span>
                {display !== machine.machineId ? (
                  <span className="font-mono text-[10px] text-text-muted">{machine.machineId}</span>
                ) : null}
                <Badge variant="secondary" className="text-[10px]">
                  {machine.count}
                </Badge>
              </button>
            </div>
            <ul className="ml-4 border-l border-border pl-2">
              {machine.leaves.map((leaf) => (
                <li key={leaf.id} className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1 text-xs">
                  <span className="font-mono text-text-primary">{leaf.id}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {t(`source.${leaf.source}`, { defaultValue: leaf.source })}
                  </Badge>
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}
