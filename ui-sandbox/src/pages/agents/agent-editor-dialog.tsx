import {
  Braces,
  Brain,
  Check,
  ChevronRight,
  CircleDot,
  Cpu,
  Database,
  Eye,
  Layers3,
  LockKeyhole,
  RotateCcw,
  Server,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  type AgentEditorDraft,
  type AgentEditorSectionId,
  cloneInitialAgentDraft,
  MODEL_OPTIONS,
  NODE_OPTIONS,
} from "./agent-editor-data";
import { AgentEditorSection, type UpdateAgentDraft } from "./agent-editor-sections";

interface AgentEditorDialogProps {
  open: boolean;
  onClose: () => void;
  onBuildFromTemplate: () => void;
  onSaved: (message: string) => void;
}

const SECTIONS = [
  { id: "identity", label: "身份与指令", caption: "名称、Prompt、模板", icon: Sparkles },
  { id: "model", label: "模型", caption: "推理模型与上下文", icon: Cpu },
  { id: "capabilities", label: "能力与工具", caption: "Skills、MCP、Sites", icon: Layers3 },
  { id: "knowledge", label: "知识与记忆", caption: "知识库、检索与长期记忆", icon: Database },
  { id: "runtime", label: "运行环境", caption: "沙盒池与机器", icon: Server },
  { id: "sharing", label: "共享与访问", caption: "组织可见范围", icon: Eye },
  { id: "advanced", label: "扩展配置", caption: "Runtime JSON", icon: Braces },
] satisfies Array<{
  id: AgentEditorSectionId;
  label: string;
  caption: string;
  icon: typeof Sparkles;
}>;

function countChanges(draft: AgentEditorDraft, initial: AgentEditorDraft): number {
  return (Object.keys(draft) as Array<keyof AgentEditorDraft>).filter(
    (key) => JSON.stringify(draft[key]) !== JSON.stringify(initial[key]),
  ).length;
}

function getSectionMeta(section: AgentEditorSectionId, draft: AgentEditorDraft): string | null {
  if (section === "model") return MODEL_OPTIONS.find((item) => item.id === draft.modelId)?.name ?? "未选择";
  if (section === "capabilities") return `${draft.skillIds.length + draft.mcpIds.length + draft.siteIds.length} 项`;
  if (section === "knowledge") return `${draft.knowledgeBaseIds.length} 个库 · 记忆${draft.enableMemory ? "开" : "关"}`;
  if (section === "runtime") return "就绪";
  if (section === "sharing") return draft.publicReadable ? "组织内" : "仅团队";
  return null;
}

function SummaryItem({
  icon,
  label,
  value,
  meta,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  meta: string;
  onClick: () => void;
}) {
  return (
    <button className="agent-composition-node agent-summary-item" type="button" onClick={onClick}>
      <span>{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
        <em>{meta}</em>
      </div>
      <ChevronRight />
    </button>
  );
}

export function AgentEditorDialog({ open, onClose, onBuildFromTemplate, onSaved }: AgentEditorDialogProps) {
  const initial = useMemo(cloneInitialAgentDraft, [open]);
  const [draft, setDraft] = useState<AgentEditorDraft>(initial);
  const [activeSection, setActiveSection] = useState<AgentEditorSectionId>("identity");
  const [confirmClose, setConfirmClose] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "restarting">("idle");
  const changeCount = countChanges(draft, initial);
  const dirty = changeCount > 0;
  const selectedModel = MODEL_OPTIONS.find((item) => item.id === draft.modelId);
  const selectedNode = NODE_OPTIONS.find((item) => item.id === draft.nodeId);
  const jsonValid = useMemo(() => {
    if (!draft.extra.trim()) return true;
    try {
      JSON.parse(draft.extra);
      return true;
    } catch {
      return false;
    }
  }, [draft.extra]);
  const canSave = dirty && jsonValid && draft.maxResults >= 1 && draft.maxResults <= 20;

  const update: UpdateAgentDraft = (key, value) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const requestClose = () => {
    if (saveState !== "idle") return;
    dirty ? setConfirmClose(true) : onClose();
  };
  const save = (restart: boolean) => {
    if (!canSave) return;
    setSaveState(restart ? "restarting" : "saving");
    window.setTimeout(
      () => {
        onSaved(restart ? "配置已保存，2 个运行实例已重新启动" : "配置已保存，将在下次启动时生效");
        setSaveState("idle");
        onClose();
      },
      restart ? 1200 : 700,
    );
  };

  useEffect(() => {
    if (!open) return;
    setDraft(initial);
    setActiveSection("identity");
    setConfirmClose(false);
    setSaveState("idle");
  }, [open, initial]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        save(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (!open) return null;

  return (
    <div className="agent-editor-backdrop" role="presentation">
      <article className="agent-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-editor-title">
        <header className="agent-editor-header">
          <div className="agent-editor-identity">
            <span className="agent-editor-avatar">
              <Sparkles />
            </span>
            <div>
              <span>
                <strong id="agent-editor-title">编辑智能体</strong>
                <em>运行中</em>
              </span>
              <p>
                {draft.name} <i /> <code>{draft.slug}</code>
              </p>
            </div>
          </div>
          <div className="agent-editor-header__actions">
            <div className="agent-editor-header__status">
              <span>
                <CircleDot /> 2 个运行实例
              </span>
              <small>上次保存于 10:42</small>
            </div>
            <button className="agent-editor-template-button" type="button" onClick={onBuildFromTemplate}>
              <WandSparkles />
              从模板构建
            </button>
          </div>
          <button className="agent-editor-close" type="button" onClick={requestClose} aria-label="关闭编辑智能体">
            <X />
          </button>
        </header>

        <div className="agent-editor-workspace">
          <aside className="agent-editor-nav" aria-label="智能体配置分区">
            <div className="agent-editor-nav__label">配置地图</div>
            <nav>
              {SECTIONS.map((section) => {
                const Icon = section.icon;
                const meta = getSectionMeta(section.id, draft);
                return (
                  <button
                    className={activeSection === section.id ? "is-active" : ""}
                    type="button"
                    key={section.id}
                    onClick={() => setActiveSection(section.id)}
                  >
                    <span>
                      <Icon />
                    </span>
                    <div>
                      <strong>{section.label}</strong>
                      <small>{section.caption}</small>
                    </div>
                    {meta && <em>{meta}</em>}
                  </button>
                );
              })}
            </nav>
            <div className="agent-editor-readiness">
              <header>
                <span>发布检查</span>
                <strong>6 / 6</strong>
              </header>
              <div>
                <i />
              </div>
              <p>
                <Check /> 配置完整，可以安全保存
              </p>
            </div>
          </aside>

          <main className="agent-editor-content" key={activeSection}>
            <AgentEditorSection section={activeSection} draft={draft} update={update} />
          </main>

          <aside className="agent-composition" aria-label="当前智能体配置摘要">
            <header>
              <span>CONFIGURATION OVERVIEW</span>
              <h3>当前配置</h3>
              <p>以下能力共同组成智能体，并不代表固定执行顺序。点击可前往修改。</p>
            </header>
            <div className="agent-composition-flow agent-summary-grid">
              <SummaryItem
                icon={<Cpu />}
                label="核心模型"
                value={selectedModel?.name ?? "未选择模型"}
                meta="负责理解任务、推理并决定是否调用能力"
                onClick={() => setActiveSection("model")}
              />
              <SummaryItem
                icon={<Database />}
                label="上下文来源"
                value={`${draft.knowledgeBaseIds.length} 个知识库 · 记忆${draft.enableMemory ? "已开启" : "未开启"}`}
                meta={`${draft.prompt.length} 字符系统指令 · ${draft.searchFirst ? "回答前优先检索" : "按需检索"}`}
                onClick={() => setActiveSection("knowledge")}
              />
              <SummaryItem
                icon={<Layers3 />}
                label="可调用能力"
                value={`${draft.skillIds.length + draft.mcpIds.length + draft.siteIds.length} 项能力`}
                meta={`${draft.skillIds.length} Skills · ${draft.mcpIds.length} MCP · ${draft.siteIds.length} Sites`}
                onClick={() => setActiveSection("capabilities")}
              />
              <SummaryItem
                icon={<Server />}
                label="执行位置"
                value={selectedNode?.name ?? "本地默认"}
                meta={`工具和文件操作在此环境执行 · ${selectedNode?.meta ?? "就绪"}`}
                onClick={() => setActiveSection("runtime")}
              />
            </div>
            <p className="agent-summary-explanation">
              <Brain /> 模型会结合 Prompt、知识和记忆生成判断，并按需调用可用能力；所有操作最终由所选运行环境承载。
            </p>
            <section className="agent-change-impact">
              <div>
                <RotateCcw />
              </div>
              <span>
                <small>保存影响</small>
                <strong>2 个实例需要重启</strong>
                <p>不重启也可保存；当前会话会继续使用旧配置。</p>
              </span>
            </section>
            <p className="agent-composition-safety">
              <LockKeyhole /> 组织隔离 · 最小权限 · Prompt 不随共享公开
            </p>
          </aside>
        </div>

        <footer className="agent-editor-footer">
          <div className="agent-editor-footer__state">
            {dirty ? (
              <>
                <span>{changeCount}</span>
                <p>
                  <strong>{changeCount} 处未保存修改</strong>
                  <small>关闭前会提醒你确认</small>
                </p>
              </>
            ) : (
              <p>
                <strong>已是最新配置</strong>
                <small>修改任意字段后即可保存</small>
              </p>
            )}
          </div>
          {dirty && (
            <button className="agent-editor-reset" type="button" onClick={() => setDraft(initial)}>
              <RotateCcw /> 重置修改
            </button>
          )}
          <div className="agent-editor-footer__actions">
            <button type="button" onClick={requestClose} disabled={saveState !== "idle"}>
              取消
            </button>
            <button
              className="is-save"
              type="button"
              onClick={() => save(false)}
              disabled={!canSave || saveState !== "idle"}
            >
              {saveState === "saving" ? "正在保存…" : "仅保存"}
              <kbd>⌘S</kbd>
            </button>
            <button
              className="is-primary"
              type="button"
              onClick={() => save(true)}
              disabled={!canSave || saveState !== "idle"}
            >
              <RotateCcw />
              {saveState === "restarting" ? "正在重启实例…" : "保存并重启"}
            </button>
          </div>
        </footer>

        {saveState !== "idle" && (
          <div className="agent-editor-progress" role="status">
            <span />
            <strong>{saveState === "restarting" ? "正在应用配置并重启运行实例" : "正在安全保存配置"}</strong>
            <small>请勿关闭窗口，这通常只需要几秒。</small>
          </div>
        )}

        {confirmClose && (
          <div className="agent-editor-confirm-layer">
            <section role="alertdialog" aria-modal="true" aria-labelledby="discard-title">
              <span>
                <RotateCcw />
              </span>
              <h3 id="discard-title">放弃未保存的修改？</h3>
              <p>这 {changeCount} 处修改尚未保存，关闭后无法恢复。</p>
              <div>
                <button type="button" onClick={() => setConfirmClose(false)}>
                  继续编辑
                </button>
                <button type="button" onClick={onClose}>
                  放弃修改
                </button>
              </div>
            </section>
          </div>
        )}
      </article>
    </div>
  );
}
