import {
  AgentCardList,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@fenix/ui-components";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { DEMO_NS } from "../i18n";

/**
 * Agent L1 分区：智能体卡片列表。
 *
 * AgentCardList 只提供「搜索框 + 响应式卡片网格 + 批量操作插槽 + 空态」这套结构：
 * 卡片长什么样由 renderCard 决定，搜索匹配、选中集合与批量操作内容都由调用方注入。
 * 示例因此在本文件内用 useState 持有选中集合，数据是模块级静态假数据，不涉及任何接口调用。
 *
 * 导出名被 demo 外壳（demo/App.tsx）按分区装配引用，新增示例时保持导出名与签名不变。
 */

interface DemoAgent {
  id: string;
  name: string;
  summary: string;
  tag: string;
}

const DEMO_AGENTS: DemoAgent[] = [
  { id: "agent-translator", name: "Translator", summary: "Translates text between languages.", tag: "text" },
  { id: "agent-reviewer", name: "Code reviewer", summary: "Reviews diffs and reports findings.", tag: "code" },
  { id: "agent-summarizer", name: "Summarizer", summary: "Condenses long documents.", tag: "text" },
  { id: "agent-planner", name: "Planner", summary: "Breaks goals into ordered steps.", tag: "ops" },
];

export function AgentL1Section() {
  const { t } = useTranslation(DEMO_NS);
  const [selectedAgents, setSelectedAgents] = useState<DemoAgent[]>([]);

  return (
    <section>
      <h1 data-slot="demo-section-title" className="mb-6 text-[24px] font-semibold">
        {t("sections.agentL1")}
      </h1>
      <p className="mt-3 text-text-muted text-[12px]">{t("sectionHints.agentL1")}</p>

      <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
        <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
          AgentCardList
        </h2>
        {/* AgentCardList 自身是 flex-1 + min-h-0，需要有确定高度的 flex 容器才会出现列表内滚动。 */}
        <div className="flex h-[420px] flex-col overflow-hidden rounded-lg border border-border">
          <AgentCardList
            items={DEMO_AGENTS}
            cardKey={(agent) => agent.id}
            searchPlaceholder="Search agents…"
            searchFn={(agent, query) => agent.name.toLowerCase().includes(query)}
            emptyMessage="No agents match the search."
            selectable
            selectedItems={selectedAgents}
            onSelectionChange={setSelectedAgents}
            gridCols="grid-cols-2"
            batchActions={
              <Button size="sm" variant="outline">
                Export
              </Button>
            }
            renderCard={(agent, isSelected, toggleSelect) => (
              <Card key={agent.id} className={isSelected ? "ring-2 ring-brand" : undefined}>
                <CardHeader>
                  <CardTitle className="text-sm">{agent.name}</CardTitle>
                  <CardDescription>{agent.summary}</CardDescription>
                </CardHeader>
                <CardContent className="flex items-center justify-between gap-2">
                  <Badge variant="secondary">{agent.tag}</Badge>
                  <Button size="sm" variant="ghost" onClick={toggleSelect}>
                    {isSelected ? "Deselect" : "Select"}
                  </Button>
                </CardContent>
              </Card>
            )}
          />
        </div>
        <p className="mt-3 text-text-muted text-[12px]">
          选中态由调用方持有（selectable + selectedItems + onSelectionChange）；搜索框按 searchFn 过滤，无匹配时走
          emptyMessage；batchActions 在选中后出现，卡片网格列数由 gridCols 决定。
        </p>
      </div>
    </section>
  );
}
