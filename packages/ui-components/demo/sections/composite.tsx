import {
  AgentCardList,
  AgentMasterDetailHeader,
  AgentMasterDetailWorkspace,
  AppHeader,
  AppPage,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  FileTreeInputDialog,
  WorkbenchPanel,
} from "@fenix/ui-components";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { DEMO_NS } from "../i18n";

/**
 * 综合分区：AppPage / AppHeader / WorkbenchPanel / InputDialog / MasterDetailWorkspace / AgentCardList。
 * 导出名被 demo/App.tsx 引用，新增示例时保持导出名与签名不变。
 *
 * 这些组件都是「容器」：布局与状态边界由组件提供，数据与异步流程由调用方注入。
 * 因此示例里的状态全部是本文件内的静态假数据，不涉及任何接口调用。
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

const DETAIL_SECTIONS = ["Overview", "Capabilities", "Settings"];

/** 详情区占位段落：内容足够多时才会触发详情区自身的滚动。 */
const DETAIL_BLOCKS = Array.from({ length: 12 }, (_, index) => `Content block ${index + 1}`);

export function CompositeSection() {
  const { t } = useTranslation(DEMO_NS);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogValue, setDialogValue] = useState("");
  const [dialogError, setDialogError] = useState<string | undefined>(undefined);
  const [dialogSubmitting, setDialogSubmitting] = useState(false);
  const [savedFolder, setSavedFolder] = useState<string | null>(null);
  const [selectedAgents, setSelectedAgents] = useState<DemoAgent[]>([]);

  // 提交交给宿主：这里只做必填校验，并用固定延迟演示 submitting 期间按钮禁用。
  const handleDialogSubmit = () => {
    if (!dialogValue.trim()) {
      setDialogError("Name is required.");
      return;
    }
    setDialogSubmitting(true);
    setTimeout(() => {
      setDialogSubmitting(false);
      setDialogOpen(false);
      setSavedFolder(dialogValue);
    }, 600);
  };

  return (
    <section className="demo-section">
      <h1 className="demo-section-title">{t("sections.composite")}</h1>

      <div className="demo-example">
        <h2 className="demo-example-title">AppPage / AppHeader</h2>
        <p className="demo-hint">
          AppPage 是页面级滚动边界（flex-1 + overflow-auto），因此示例给它一个确定高度的 flex 容器。
        </p>
        <div className="flex h-[320px] flex-col overflow-hidden rounded-lg border border-border">
          <AppPage>
            <AppHeader
              title="Workspace overview"
              subtitle="AppHeader 固定标题层级与操作区基线，AppPage 负责背景、留白与滚动。"
              actions={<Button size="sm">New agent</Button>}
            />
            <p className="mt-6 text-sm text-text-muted">
              Page body — content longer than the frame scrolls inside AppPage, not in the demo shell.
            </p>
          </AppPage>
        </div>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">WorkbenchPanel</h2>
        <WorkbenchPanel className="flex gap-4 p-4">
          <div className="w-[180px] shrink-0 rounded-md bg-surface-2 p-3 text-sm text-text-muted">Index column</div>
          <div className="min-w-0 flex-1 rounded-md bg-surface-2 p-3 text-sm text-text-muted">
            Detail column — WorkbenchPanel 只给左侧索引 + 右侧内容提供一个共享表面，不含任何布局假设。
          </div>
        </WorkbenchPanel>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">InputDialog (file-tree-input-dialog)</h2>
        <div className="demo-row">
          <Button variant="outline" onClick={() => setDialogOpen(true)}>
            New folder
          </Button>
          {savedFolder === null ? null : <Badge variant="secondary">Created: {savedFolder}</Badge>}
        </div>
        {/* 字段状态、错误与异步提交都由调用方持有，组件只负责弹窗结构与提交事件。 */}
        <FileTreeInputDialog
          open={dialogOpen}
          title="New folder"
          description="Folder name is validated by the host before submitting."
          value={dialogValue}
          error={dialogError}
          submitting={dialogSubmitting}
          confirmLabel="Create"
          cancelLabel="Cancel"
          onValueChange={(value) => {
            setDialogValue(value);
            setDialogError(undefined);
          }}
          onOpenChange={setDialogOpen}
          onSubmit={handleDialogSubmit}
        />
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">MasterDetailWorkspace (agent-master-detail-workspace)</h2>
        <p className="demo-hint">
          该组件自带 `calc(100dvh - 210px)` 高度，用于宿主整页布局；示例按原样渲染，未做尺寸改写。
        </p>
        <AgentMasterDetailWorkspace
          index={
            <div className="flex flex-col gap-1 p-3">
              {DETAIL_SECTIONS.map((section) => (
                <div key={section} className="rounded-md px-3 py-2 text-sm text-text-muted">
                  {section}
                </div>
              ))}
            </div>
          }
          detailHeader={
            <AgentMasterDetailHeader>
              <div className="border-b border-border px-6 py-4 text-sm font-medium">Translator</div>
            </AgentMasterDetailHeader>
          }
          detailFooter={
            <div className="border-t border-border px-6 py-3 text-xs text-text-muted">detailFooter 区域</div>
          }
        >
          <div className="p-6 text-sm text-text-muted">
            <p>详情区独立滚动，索引区与头部/底部固定。</p>
            {DETAIL_BLOCKS.map((block) => (
              <p key={block} className="mt-3">
                {block}
              </p>
            ))}
          </div>
        </AgentMasterDetailWorkspace>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">AgentCardList</h2>
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
      </div>
    </section>
  );
}
