import { ArrowDown, ChevronDown, Paperclip, Plus, Send, Shield, Square } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { AskUserQuestionPanel } from "./ask-user-question-panel";
import { ChatQuoteProvider } from "./chat-quote-context";
import { type ComposerAsset, ComposerAssets, DEFAULT_COMPOSER_ASSETS, EXTRA_COMPOSER_ASSET } from "./composer-assets";
import { ComposerContextMeter } from "./composer-context-meter";
import type { DemoScenarioId } from "./demo-model";
import { DemoStatusPanel } from "./demo-status-panel";
import { Button } from "./demo-ui";
import { UserMessage } from "./message-primitives";
import { PermissionRequestPanel } from "./permission-request-panel";
import { DEFAULT_SELECTED_PLUGIN_IDS, PluginSelectionPanel, PluginTrigger, SelectedPluginChips } from "./plugin-picker";
import { type PromptJumpItem, PromptJumpRail } from "./prompt-jump-rail";
import { ScenarioContent } from "./scenario-content";
import { useDemoTranslation } from "./use-demo-copy";

interface ChatCanvasProps {
  scenarioId: DemoScenarioId;
}

interface TextSelectionAction {
  text: string;
  left: number;
  top: number;
}

const LONG_PROMPT_JUMPS: readonly PromptJumpItem[] = [
  {
    id: "long-prompt-design",
    label: "完整 Chat 重构说明",
    meta: "已完成",
    summary: "整理消息、工具、权限与上下文边界，并输出完整 Markdown 说明。",
  },
  {
    id: "long-prompt-tools",
    label: "执行 104 次工具检查",
    meta: "已检查",
    summary: "连续渲染工具活动，覆盖成功、失败、执行中和无正文思考状态。",
  },
  {
    id: "long-prompt-trace",
    label: "确认调用追踪状态",
    meta: "最新问题",
    summary: "确认全部工具调用已进入可追踪状态，并保留详情入口。",
  },
];

const SCENARIO_CONTEXT_USAGE: Partial<Record<DemoScenarioId, number>> = {
  longConversation: 78,
  markdown: 46,
  tools: 38,
  files: 34,
  assets: 41,
};

export function ChatCanvas({ scenarioId }: ChatCanvasProps) {
  const { t } = useDemoTranslation();
  const [draft, setDraft] = useState("");
  const [sentMessages, setSentMessages] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [pluginOpen, setPluginOpen] = useState(false);
  const [selectedPluginIds, setSelectedPluginIds] = useState<Set<string>>(() => new Set(DEFAULT_SELECTED_PLUGIN_IDS));
  const [composerAssets, setComposerAssets] = useState<ComposerAsset[]>(() =>
    scenarioId === "assets" ? DEFAULT_COMPOSER_ASSETS.map((asset) => ({ ...asset })) : [],
  );
  const [textSelection, setTextSelection] = useState<TextSelectionAction | null>(null);
  const canvasRef = useRef<HTMLElement>(null);
  const inputDockRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const generationTimerRef = useRef<number | null>(null);
  const quoteIdRef = useRef(0);

  useEffect(() => {
    return () => {
      if (generationTimerRef.current) window.clearTimeout(generationTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const inputDock = inputDockRef.current;
    const timeline = timelineRef.current;
    if (!canvas || !inputDock || !timeline) return;

    let hasMeasured = false;
    let scrollFrame = 0;

    const updateTimelineClearance = () => {
      const wasNearLatest = !hasMeasured || timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop < 32;
      hasMeasured = true;
      canvas.style.setProperty(
        "--chat-input-clearance",
        `${Math.ceil(inputDock.getBoundingClientRect().height + 8)}px`,
      );
      if (wasNearLatest) {
        window.cancelAnimationFrame(scrollFrame);
        scrollFrame = window.requestAnimationFrame(() => {
          timeline.scrollTop = timeline.scrollHeight;
        });
      }
    };
    updateTimelineClearance();
    const resizeObserver = new ResizeObserver(updateTimelineClearance);
    resizeObserver.observe(inputDock);
    return () => {
      resizeObserver.disconnect();
      window.cancelAnimationFrame(scrollFrame);
    };
  }, []);

  const addQuoteAsset = useCallback((sourceText: string) => {
    const preview = sourceText.replace(/\s+/g, " ").trim();
    if (!preview) return;
    quoteIdRef.current += 1;
    setComposerAssets((assets) => [
      ...assets,
      {
        id: `quote-${quoteIdRef.current}`,
        kind: "quote",
        name: `引用 ${quoteIdRef.current}`,
        meta: "会话文本",
        preview,
      },
    ]);
    setTextSelection(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const updateTextSelection = () => {
    const selection = window.getSelection();
    const timeline = timelineRef.current;
    const canvas = canvasRef.current;
    if (!selection || selection.isCollapsed || !timeline || !canvas || selection.rangeCount === 0) {
      setTextSelection(null);
      return;
    }
    const text = selection.toString().trim();
    const range = selection.getRangeAt(0);
    const selectedNode =
      range.commonAncestorContainer.nodeType === Node.TEXT_NODE
        ? range.commonAncestorContainer.parentElement
        : range.commonAncestorContainer;
    if (!text || !(selectedNode instanceof Node) || !timeline.contains(selectedNode)) {
      setTextSelection(null);
      return;
    }
    const rangeBounds = range.getBoundingClientRect();
    const canvasBounds = canvas.getBoundingClientRect();
    setTextSelection({
      text,
      left: Math.max(
        12,
        Math.min(canvasBounds.width - 130, rangeBounds.left - canvasBounds.left + rangeBounds.width / 2 - 55),
      ),
      top: Math.max(10, rangeBounds.top - canvasBounds.top - 42),
    });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message && composerAssets.length === 0) return;
    setSentMessages((messages) => [...messages, message || `已发送 ${composerAssets.length} 个 Asset`]);
    setDraft("");
    setComposerAssets([]);
    setPluginOpen(false);
    setGenerating(true);
    if (generationTimerRef.current) window.clearTimeout(generationTimerRef.current);
    generationTimerRef.current = window.setTimeout(() => {
      setGenerating(false);
      generationTimerRef.current = null;
    }, 1400);
  };

  const togglePlugin = (id: string) => {
    setSelectedPluginIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const contextUsage = Math.min(96, (SCENARIO_CONTEXT_USAGE[scenarioId] ?? 28) + composerAssets.length * 2);

  const startNewSession = () => {
    if (generationTimerRef.current) window.clearTimeout(generationTimerRef.current);
    generationTimerRef.current = null;
    setDraft("");
    setComposerAssets([]);
    setSentMessages([]);
    setGenerating(false);
    setPluginOpen(false);
    timelineRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <ChatQuoteProvider onQuote={addQuoteAsset}>
      <section
        ref={canvasRef}
        className="chat-demo__canvas"
        data-has-assets={composerAssets.length > 0 || undefined}
        aria-label={t(`scenarios.${scenarioId}.title`)}
      >
        {scenarioId === "longConversation" && <PromptJumpRail items={LONG_PROMPT_JUMPS} timelineRef={timelineRef} />}
        <div
          ref={timelineRef}
          className="chat-demo__timeline"
          onMouseUp={updateTextSelection}
          onKeyUp={updateTextSelection}
          onScroll={() => setTextSelection(null)}
        >
          <ScenarioContent scenarioId={scenarioId} />
          {sentMessages.map((message, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: local demo messages have no persisted identifier
            <UserMessage key={index}>{message}</UserMessage>
          ))}
          {generating && (
            <div className="chat-demo__mock-thinking" aria-live="polite">
              <span />
              <span />
              <span />
              {t("status.thinking")}
            </div>
          )}
        </div>

        {textSelection && (
          <div
            className="chat-demo__selection-actions"
            role="toolbar"
            aria-label="所选文本操作"
            style={{ left: textSelection.left, top: textSelection.top }}
          >
            <button type="button" onClick={() => addQuoteAsset(textSelection.text)}>
              添加到对话
            </button>
          </div>
        )}

        <div ref={inputDockRef} className="chat-demo__input-dock">
          {scenarioId === "longConversation" && (
            <button
              type="button"
              className="chat-demo__jump-latest"
              onClick={() =>
                timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight, behavior: "smooth" })
              }
            >
              <ArrowDown />
              {t("longConversation.jumpLatest")}
            </button>
          )}

          {pluginOpen ? (
            <PluginSelectionPanel
              selectedIds={selectedPluginIds}
              onToggle={togglePlugin}
              onClose={() => setPluginOpen(false)}
            />
          ) : scenarioId === "askUser" ? (
            <AskUserQuestionPanel />
          ) : scenarioId === "permission" ? (
            <PermissionRequestPanel />
          ) : (
            <DemoStatusPanel scenarioId={scenarioId} />
          )}

          <div className="chat-demo__composer-wrap">
            <form className="chat-demo__composer" onSubmit={handleSubmit}>
              <ComposerAssets
                assets={composerAssets}
                onRemove={(id) => setComposerAssets((assets) => assets.filter((asset) => asset.id !== id))}
              />
              <SelectedPluginChips selectedIds={selectedPluginIds} onRemove={togglePlugin} />
              <textarea
                value={draft}
                rows={2}
                placeholder={t("conversation.composerPlaceholder")}
                aria-label={t("conversation.composerPlaceholder")}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <div className="chat-demo__composer-tools">
                <div className="chat-demo__composer-tools-main">
                  <PluginTrigger
                    open={pluginOpen}
                    count={selectedPluginIds.size}
                    onToggle={() => setPluginOpen((open) => !open)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="chat-demo__composer-attach"
                    aria-label={t("controls.attach")}
                    onClick={() =>
                      setComposerAssets((assets) => {
                        const candidates = [...DEFAULT_COMPOSER_ASSETS, EXTRA_COMPOSER_ASSET];
                        const nextAsset = candidates.find(
                          (candidate) => !assets.some((asset) => asset.id === candidate.id),
                        );
                        return nextAsset ? [...assets, { ...nextAsset }] : assets;
                      })
                    }
                  >
                    <Paperclip />
                  </Button>
                  <ComposerContextMeter percentage={contextUsage} />
                  <button
                    type="button"
                    className="chat-demo__composer-text-action chat-demo__composer-model"
                    aria-label={`${t("conversation.model")} 模型`}
                  >
                    {t("conversation.model")}
                    <ChevronDown />
                  </button>
                  <span className="chat-demo__composer-policy" title="Agent 可执行">
                    <Shield />
                    <span>Agent 可执行</span>
                  </span>
                </div>
                <div className="chat-demo__composer-tools-right">
                  <button type="button" className="chat-demo__composer-text-action" onClick={startNewSession}>
                    <Plus />
                    {t("conversation.newSession")}
                  </button>
                  <Button
                    type={generating ? "button" : "submit"}
                    size="icon-sm"
                    className="chat-demo__send"
                    disabled={!generating && !draft.trim() && composerAssets.length === 0}
                    aria-label={generating ? t("controls.stop") : t("controls.send")}
                    onClick={
                      generating
                        ? () => {
                            if (generationTimerRef.current) window.clearTimeout(generationTimerRef.current);
                            generationTimerRef.current = null;
                            setGenerating(false);
                          }
                        : undefined
                    }
                  >
                    {generating ? <Square /> : <Send />}
                  </Button>
                </div>
              </div>
            </form>
            <div className="chat-demo__composer-meta">
              <span>{t("conversation.composerHint")}</span>
            </div>
          </div>
        </div>
      </section>
    </ChatQuoteProvider>
  );
}
