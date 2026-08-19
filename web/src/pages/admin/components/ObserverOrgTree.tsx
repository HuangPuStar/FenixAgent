// web/src/pages/admin/components/ObserverOrgTree.tsx
// 归属树（organizationId → userId → agentConfigId → instanceId → leafId，docs/arch/21 §5）。
// 叶子行显示 source badge 与 machineId；拓扑反查时高亮 machine 承载的 leaf。
// 使用原生 <details> 逐层钻取，保持键盘可访问性（open 属性默认展开层级）。

import { Bot, Building2, Cpu, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import type {
  ObserverAgentNode,
  ObserverInstanceNode,
  ObserverLeaf,
  ObserverNames,
  ObserverOrgNode,
  ObserverUserNode,
} from "../../../api/observer";
import { cn } from "../../../lib/utils";
import { name } from "../utils";

interface ObserverOrgTreeProps {
  orgs: ObserverOrgNode[];
  /** 拓扑反查高亮：machine 承载的 leaf id 集合。 */
  highlightedLeafIds: Set<string>;
  /** 各角色 id → 可读名称（name(id) 展示）。 */
  names: ObserverNames;
}

/** 节点主标题：可读名称 + 原始 id 弱化小字跟随。 */
function NodeTitle({ display, id }: { display: string; id: string }) {
  return (
    <span className="min-w-0">
      <span className="font-mono text-text-primary">{display}</span>
      {display !== id ? <span className="ml-1 font-mono text-[10px] text-text-muted">{id}</span> : null}
    </span>
  );
}

function LeafRow({ leaf, highlighted, names }: { leaf: ObserverLeaf; highlighted: Set<string>; names: ObserverNames }) {
  const { t } = useTranslation("observer");
  const isHighlighted = highlighted.has(leaf.id);
  const machineDisplay = name(names, "machineId", leaf.machineId);
  return (
    <li
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-md px-2 py-1 text-xs",
        isHighlighted && "bg-brand/10 ring-1 ring-brand/40",
      )}
    >
      <span className="font-mono text-text-primary">{leaf.id}</span>
      <Badge variant="outline" className="text-[10px]">
        {t(`source.${leaf.source}`, { defaultValue: leaf.source })}
      </Badge>
      {leaf.machineId ? (
        <span className="font-mono text-text-muted">
          machine: {machineDisplay}
          {machineDisplay !== leaf.machineId ? <span className="ml-1 text-[10px]">{leaf.machineId}</span> : null}
        </span>
      ) : null}
    </li>
  );
}

function InstanceNode({
  node,
  highlighted,
  names,
}: {
  node: ObserverInstanceNode;
  highlighted: Set<string>;
  names: ObserverNames;
}) {
  const { t } = useTranslation("observer");
  return (
    <li>
      <details open>
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent">
          <Cpu className="size-3.5 text-text-muted" />
          <NodeTitle display={name(names, "instanceId", node.instanceId)} id={node.instanceId} />
          <span className="text-xs text-text-muted">{t("tree.leaves", { count: node.leafCount })}</span>
        </summary>
        <ul className="ml-4 border-l border-border pl-2">
          {node.leaves.map((leaf) => (
            <LeafRow key={leaf.id} leaf={leaf} highlighted={highlighted} names={names} />
          ))}
        </ul>
      </details>
    </li>
  );
}

function AgentNode({
  node,
  highlighted,
  names,
}: {
  node: ObserverAgentNode;
  highlighted: Set<string>;
  names: ObserverNames;
}) {
  const { t } = useTranslation("observer");
  return (
    <li>
      <details open>
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent">
          <Bot className="size-3.5 text-text-muted" />
          <NodeTitle display={name(names, "agentConfigId", node.agentConfigId)} id={node.agentConfigId} />
          <span className="text-xs text-text-muted">
            {t("tree.instances", { count: node.instanceCount })} · {t("tree.leaves", { count: node.leafCount })}
          </span>
        </summary>
        <ul className="ml-4 border-l border-border pl-2">
          {node.children.map((instance) => (
            <InstanceNode key={instance.instanceId} node={instance} highlighted={highlighted} names={names} />
          ))}
          {/* 无 instanceId 的叶子（本地 acp-link）直接挂在 agent 节点 */}
          {node.leaves?.map((leaf) => (
            <LeafRow key={leaf.id} leaf={leaf} highlighted={highlighted} names={names} />
          ))}
        </ul>
      </details>
    </li>
  );
}

function UserNode({
  node,
  highlighted,
  names,
}: {
  node: ObserverUserNode;
  highlighted: Set<string>;
  names: ObserverNames;
}) {
  const { t } = useTranslation("observer");
  return (
    <li>
      <details open>
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent">
          <User className="size-3.5 text-text-muted" />
          <NodeTitle display={name(names, "userId", node.userId)} id={node.userId} />
          <span className="text-xs text-text-muted">
            {t("tree.agents", { count: node.agentCount })} · {t("tree.leaves", { count: node.leafCount })}
          </span>
        </summary>
        <ul className="ml-4 border-l border-border pl-2">
          {node.children.map((agent) => (
            <AgentNode key={agent.agentConfigId} node={agent} highlighted={highlighted} names={names} />
          ))}
        </ul>
      </details>
    </li>
  );
}

function OrgNode({
  node,
  highlighted,
  names,
}: {
  node: ObserverOrgNode;
  highlighted: Set<string>;
  names: ObserverNames;
}) {
  const { t } = useTranslation("observer");
  return (
    <li>
      <details open>
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 text-sm font-medium hover:bg-accent">
          <Building2 className="size-3.5 text-text-muted" />
          <NodeTitle display={name(names, "organizationId", node.organizationId)} id={node.organizationId} />
          <span className="text-xs text-text-muted">{t("tree.leaves", { count: node.leafCount })}</span>
        </summary>
        <ul className="ml-4 border-l border-border pl-2">
          {node.children.map((user) => (
            <UserNode key={user.userId} node={user} highlighted={highlighted} names={names} />
          ))}
        </ul>
      </details>
    </li>
  );
}

export function ObserverOrgTree({ orgs, highlightedLeafIds, names }: ObserverOrgTreeProps) {
  if (orgs.length === 0) return null;
  return (
    <ul className="space-y-1">
      {orgs.map((org) => (
        <OrgNode key={org.organizationId} node={org} highlighted={highlightedLeafIds} names={names} />
      ))}
    </ul>
  );
}
