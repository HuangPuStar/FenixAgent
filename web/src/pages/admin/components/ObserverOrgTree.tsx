// web/src/pages/admin/components/ObserverOrgTree.tsx
// 归属树（organizationId → userId → agentConfigId → instanceId → leafId，docs/arch/21 §5）。
// 叶子行显示 source badge 与 machineId；拓扑反查时高亮 machine 承载的 leaf。
// 使用原生 <details> 逐层钻取，保持键盘可访问性（open 属性默认展开层级）。

import { Bot, Building2, Cpu, Layers, User } from "lucide-react";
import { useEffect, useState } from "react";
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
import {
  chatRelayPayload,
  formatClockTime,
  formatDuration,
  groupYjsSessions,
  name,
  sessionTabCounts,
  type YjsSessionGroup,
} from "../utils";

interface ObserverOrgTreeProps {
  orgs: ObserverOrgNode[];
  /** 拓扑反查高亮：machine 承载的 leaf id 集合。 */
  highlightedLeafIds: Set<string>;
  /** 各角色 id → 可读名称（name(id) 展示）。 */
  names: ObserverNames;
}

/** 每层 icon 与子树连接线颜色：层级一眼区分（org→user→agent→instance→yjs）。 */
const LEVEL_COLOR = {
  org: "text-brand",
  orgLine: "border-brand/30",
  user: "text-accent-tiffany",
  userLine: "border-accent-tiffany/30",
  agent: "text-accent-green",
  agentLine: "border-accent-green/30",
  instance: "text-accent-yellow",
  instanceLine: "border-accent-yellow/30",
  yjs: "text-accent-pink",
  yjsLine: "border-accent-pink/30",
} as const;

/**
 * 节点主标题：可读名称 + 原始 id 弱化小字跟随。
 * maxLength 超长时截断并加省略号，title 悬浮显示完整 id（长 rcsSessionId 等场景）。
 */
function NodeTitle({ display, id, maxLength }: { display: string; id: string; maxLength?: number }) {
  const isTruncated = maxLength !== undefined && display.length > maxLength;
  const shown = isTruncated ? `${display.slice(0, maxLength)}…` : display;
  return (
    <span className="min-w-0">
      <span className="font-mono text-text-primary" title={isTruncated ? display : undefined}>
        {shown}
      </span>
      {display !== id ? <span className="ml-1 font-mono text-[10px] text-text-muted">{id}</span> : null}
    </span>
  );
}

/**
 * chat-relay 叶子行右侧统计：打开时间 / 已连时长（30s 跳动）/ 会话 id / 同会话标签页数。
 * 用于快速识别陈旧残留连接（同实例多连接但会话不同/缺失，见 docs/arch/21 §6 排查）。
 */
function ChatRelayStats({ leaf, tabCount }: { leaf: ObserverLeaf; tabCount: number }) {
  const { t } = useTranslation("observer");
  // 时长随本地时钟每 30s 跳动；观察面板本身 15s 轮询，两个更新源互不冲突
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const info = chatRelayPayload(leaf);
  if (!info?.openTime) return null;
  const duration = formatDuration(now - info.openTime);
  return (
    <span className="ml-auto flex shrink-0 items-center gap-2 text-[10px] text-text-muted">
      <span title={t("stats.openTime")}>{formatClockTime(info.openTime)}</span>
      <span>{t(`stats.unit.${duration.unit}`, { value: duration.value })}</span>
      {info.rcsSessionId ? (
        <span title={`${t("stats.session")}: ${info.rcsSessionId}`} className="font-mono">
          {info.rcsSessionId.length > 12 ? `${info.rcsSessionId.slice(0, 10)}…` : info.rcsSessionId}
        </span>
      ) : null}
      {tabCount > 1 ? (
        <Badge variant="outline" className="text-[10px]">
          {t("stats.tabs", { count: tabCount })}
        </Badge>
      ) : null}
    </span>
  );
}

function LeafRow({
  leaf,
  highlighted,
  names,
  sessionCounts,
}: {
  leaf: ObserverLeaf;
  highlighted: Set<string>;
  names: ObserverNames;
  sessionCounts: Map<string, number>;
}) {
  const { t } = useTranslation("observer");
  const isHighlighted = highlighted.has(leaf.id);
  const machineDisplay = name(names, "machineId", leaf.machineId);
  const sessionInfo = chatRelayPayload(leaf);
  const leafIdTruncated = leaf.id.length > 40;
  return (
    <li
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-md px-2 py-1 text-xs",
        isHighlighted && "bg-brand/10 ring-1 ring-brand/40",
      )}
    >
      <span className="font-mono text-text-primary" title={leafIdTruncated ? leaf.id : undefined}>
        {leafIdTruncated ? `${leaf.id.slice(0, 40)}…` : leaf.id}
      </span>
      <Badge variant="outline" className="text-[10px]">
        {t(`source.${leaf.source}`, { defaultValue: leaf.source })}
      </Badge>
      {leaf.machineId ? (
        <span className="font-mono text-text-muted">
          machine: {machineDisplay}
          {machineDisplay !== leaf.machineId ? <span className="ml-1 text-[10px]">{leaf.machineId}</span> : null}
        </span>
      ) : null}
      {sessionInfo ? (
        <ChatRelayStats leaf={leaf} tabCount={sessionCounts.get(sessionInfo.rcsSessionId ?? "") ?? 1} />
      ) : null}
    </li>
  );
}

/**
 * Y.Doc 会话层右侧统计：最早打开时间 / 已连时长（30s 跳动）/ 会话内连接数。
 * 会话层是实例下的一级聚合（同一 rcsSessionId 的 chat-relay 链接集合），
 * 用于快速看出「同会话多标签页」与「跨会话多连接」的区别。
 */
function YjsSessionStats({ session }: { session: YjsSessionGroup }) {
  const { t } = useTranslation("observer");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  // 聚合会话内所有链接的打开时间，取最早作为会话起点
  const openTimes = session.leaves
    .map((leaf) => chatRelayPayload(leaf)?.openTime)
    .filter((value): value is number => typeof value === "number");
  if (openTimes.length === 0) return null;
  const earliestOpen = Math.min(...openTimes);
  const duration = formatDuration(now - earliestOpen);
  return (
    <span className="ml-auto flex shrink-0 items-center gap-2 text-[10px] text-text-muted">
      <span title={t("stats.openTime")}>{formatClockTime(earliestOpen)}</span>
      <span>{t(`stats.unit.${duration.unit}`, { value: duration.value })}</span>
      {session.leaves.length > 1 ? (
        <Badge variant="outline" className="text-[10px]">
          {t("stats.tabs", { count: session.leaves.length })}
        </Badge>
      ) : null}
    </span>
  );
}

/** Y.Doc 会话节点：同一 rcsSessionId 的链接集合（一个 Y.Doc 实例，可多条链接）。 */
function YjsSessionNode({
  session,
  highlighted,
  names,
  sessionCounts,
}: {
  session: YjsSessionGroup;
  highlighted: Set<string>;
  names: ObserverNames;
  sessionCounts: Map<string, number>;
}) {
  return (
    <li>
      <details open>
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-accent">
          <Layers className={`size-3.5 ${LEVEL_COLOR.yjs}`} />
          <NodeTitle display={session.rcsSessionId} id={session.rcsSessionId} maxLength={18} />
          <YjsSessionStats session={session} />
        </summary>
        <ul className={`ml-4 border-l pl-2 ${LEVEL_COLOR.yjsLine}`}>
          {session.leaves.map((leaf) => (
            <LeafRow key={leaf.id} leaf={leaf} highlighted={highlighted} names={names} sessionCounts={sessionCounts} />
          ))}
        </ul>
      </details>
    </li>
  );
}

function InstanceNode({
  node,
  highlighted,
  names,
  sessionCounts,
}: {
  node: ObserverInstanceNode;
  highlighted: Set<string>;
  names: ObserverNames;
  sessionCounts: Map<string, number>;
}) {
  const { t } = useTranslation("observer");
  // 实例下先按 rcsSessionId 分组出 Y.Doc 会话层，无会话的链接（acp-ws / external-relay）直接挂实例层
  const { sessions, ungrouped } = groupYjsSessions(node.leaves);
  return (
    <li>
      <details open>
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent">
          <Cpu className={`size-3.5 ${LEVEL_COLOR.instance}`} />
          <NodeTitle display={name(names, "instanceId", node.instanceId)} id={node.instanceId} maxLength={28} />
          <span className="text-xs text-text-muted">{t("tree.leaves", { count: node.leafCount })}</span>
        </summary>
        <ul className={`ml-4 border-l pl-2 ${LEVEL_COLOR.instanceLine}`}>
          {sessions.map((session) => (
            <YjsSessionNode
              key={session.rcsSessionId}
              session={session}
              highlighted={highlighted}
              names={names}
              sessionCounts={sessionCounts}
            />
          ))}
          {ungrouped.map((leaf) => (
            <LeafRow key={leaf.id} leaf={leaf} highlighted={highlighted} names={names} sessionCounts={sessionCounts} />
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
  sessionCounts,
}: {
  node: ObserverAgentNode;
  highlighted: Set<string>;
  names: ObserverNames;
  sessionCounts: Map<string, number>;
}) {
  const { t } = useTranslation("observer");
  return (
    <li>
      <details open>
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent">
          <Bot className={`size-3.5 ${LEVEL_COLOR.agent}`} />
          <NodeTitle
            display={name(names, "agentConfigId", node.agentConfigId)}
            id={node.agentConfigId}
            maxLength={28}
          />
          <span className="text-xs text-text-muted">
            {t("tree.instances", { count: node.instanceCount })} · {t("tree.leaves", { count: node.leafCount })}
          </span>
        </summary>
        <ul className={`ml-4 border-l pl-2 ${LEVEL_COLOR.agentLine}`}>
          {node.children.map((instance) => (
            <InstanceNode
              key={instance.instanceId}
              node={instance}
              highlighted={highlighted}
              names={names}
              sessionCounts={sessionCounts}
            />
          ))}
          {/* 无 instanceId 的叶子（本地 acp-link）直接挂在 agent 节点 */}
          {node.leaves?.map((leaf) => (
            <LeafRow key={leaf.id} leaf={leaf} highlighted={highlighted} names={names} sessionCounts={sessionCounts} />
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
  sessionCounts,
}: {
  node: ObserverUserNode;
  highlighted: Set<string>;
  names: ObserverNames;
  sessionCounts: Map<string, number>;
}) {
  const { t } = useTranslation("observer");
  return (
    <li>
      <details open>
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent">
          <User className={`size-3.5 ${LEVEL_COLOR.user}`} />
          <NodeTitle display={name(names, "userId", node.userId)} id={node.userId} maxLength={28} />
          <span className="text-xs text-text-muted">
            {t("tree.agents", { count: node.agentCount })} · {t("tree.leaves", { count: node.leafCount })}
          </span>
        </summary>
        <ul className={`ml-4 border-l pl-2 ${LEVEL_COLOR.userLine}`}>
          {node.children.map((agent) => (
            <AgentNode
              key={agent.agentConfigId}
              node={agent}
              highlighted={highlighted}
              names={names}
              sessionCounts={sessionCounts}
            />
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
  sessionCounts,
}: {
  node: ObserverOrgNode;
  highlighted: Set<string>;
  names: ObserverNames;
  sessionCounts: Map<string, number>;
}) {
  const { t } = useTranslation("observer");
  return (
    <li>
      <details open>
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 text-sm font-medium hover:bg-accent">
          <Building2 className={`size-3.5 ${LEVEL_COLOR.org}`} />
          <NodeTitle
            display={name(names, "organizationId", node.organizationId)}
            id={node.organizationId}
            maxLength={32}
          />
          <span className="text-xs text-text-muted">{t("tree.leaves", { count: node.leafCount })}</span>
        </summary>
        <ul className={`ml-4 border-l pl-2 ${LEVEL_COLOR.orgLine}`}>
          {node.children.map((user) => (
            <UserNode
              key={user.userId}
              node={user}
              highlighted={highlighted}
              names={names}
              sessionCounts={sessionCounts}
            />
          ))}
        </ul>
      </details>
    </li>
  );
}

export function ObserverOrgTree({ orgs, highlightedLeafIds, names }: ObserverOrgTreeProps) {
  if (orgs.length === 0) return null;
  // 全树一次性统计同会话标签页数，避免每个叶子重复遍历
  const sessionCounts = sessionTabCounts(orgs);
  return (
    <ul className="space-y-1">
      {orgs.map((org) => (
        <OrgNode
          key={org.organizationId}
          node={org}
          highlighted={highlightedLeafIds}
          names={names}
          sessionCounts={sessionCounts}
        />
      ))}
    </ul>
  );
}
