import {
  Braces,
  Brain,
  Check,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Database,
  Globe2,
  Info,
  Plug,
  RotateCcw,
  Search,
  Server,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import {
  type AgentEditorDraft,
  type AgentEditorSectionId,
  type EditorOption,
  KNOWLEDGE_OPTIONS,
  MCP_OPTIONS,
  MODEL_OPTIONS,
  NODE_OPTIONS,
  SITE_OPTIONS,
  SKILL_OPTIONS,
} from "./agent-editor-data";

export type UpdateAgentDraft = <Key extends keyof AgentEditorDraft>(key: Key, value: AgentEditorDraft[Key]) => void;

interface AgentEditorSectionProps {
  section: AgentEditorSectionId;
  draft: AgentEditorDraft;
  update: UpdateAgentDraft;
}
function SectionIntro({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <header className="agent-editor-section__intro">
      <span>{eyebrow}</span>
      <h3>{title}</h3>
      <p>{description}</p>
    </header>
  );
}
function FormField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="agent-editor-field">
      <span className="agent-editor-field__label">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      {children}
    </label>
  );
}
function ToggleRow({
  checked,
  onChange,
  icon,
  title,
  description,
  badge,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  icon: ReactNode;
  title: string;
  description: string;
  badge?: string;
}) {
  return (
    <button
      className={`agent-editor-toggle-row${checked ? " is-on" : ""}`}
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
    >
      <span className="agent-editor-toggle-row__icon">{icon}</span>
      <span className="agent-editor-toggle-row__copy">
        <strong>
          {title}
          {badge && <em>{badge}</em>}
        </strong>
        <small>{description}</small>
      </span>
      <span className="agent-editor-switch" aria-hidden="true">
        <i />
      </span>
    </button>
  );
}
function PickerPagination({
  page,
  pageCount,
  total,
  pageSize,
  onPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
}) {
  if (total === 0) return null;
  return (
    <footer className="agent-picker-pagination">
      <span>
        显示 {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)}，共 {total.toLocaleString()} 项
      </span>
      <div>
        <button type="button" disabled={page === 1} onClick={() => onPage(page - 1)} aria-label="上一页">
          <ChevronLeft />
        </button>
        <strong>
          {page} / {pageCount}
        </strong>
        <button type="button" disabled={page === pageCount} onClick={() => onPage(page + 1)} aria-label="下一页">
          <ChevronRight />
        </button>
      </div>
    </footer>
  );
}
function ResourcePicker({
  options,
  selectedIds,
  onChange,
  searchPlaceholder,
}: {
  options: EditorOption[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  searchPlaceholder: string;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 5;
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return options;
    return options.filter((item) =>
      `${item.name}${item.description}${item.meta ?? ""}`.toLowerCase().includes(normalized),
    );
  }, [options, query]);
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageItems = visible.slice((safePage - 1) * pageSize, safePage * pageSize);
  const selected = options.filter((item) => selectedIds.includes(item.id));
  const toggle = (id: string) => {
    onChange(selectedIds.includes(id) ? selectedIds.filter((item) => item !== id) : [...selectedIds, id]);
  };

  return (
    <div className="agent-resource-picker">
      <div className="agent-resource-picker__selected">
        <div>
          <strong>已启用 {selected.length} 项</strong>
          <small>点击标签可快速移除</small>
        </div>
        <div className="agent-resource-picker__chips">
          {selected.length === 0 ? (
            <span className="agent-resource-picker__empty">尚未选择</span>
          ) : (
            selected.map((item) => (
              <button type="button" key={item.id} onClick={() => toggle(item.id)} aria-label={`移除 ${item.name}`}>
                {item.name}
                <span>×</span>
              </button>
            ))
          )}
        </div>
      </div>
      <label className="agent-resource-picker__search">
        <Search />
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
          placeholder={searchPlaceholder}
        />
        <kbd>{visible.length.toLocaleString()} 个结果</kbd>
      </label>
      <div className="agent-resource-picker__list">
        {pageItems.map((item) => {
          const checked = selectedIds.includes(item.id);
          return (
            <button
              className={checked ? "is-selected" : ""}
              type="button"
              key={item.id}
              aria-pressed={checked}
              onClick={() => toggle(item.id)}
            >
              <span className="agent-resource-picker__check">{checked && <Check />}</span>
              <span>
                <strong>{item.name}</strong>
                <small>{item.description}</small>
              </span>
              {item.meta && <em>{item.meta}</em>}
            </button>
          );
        })}
        {visible.length === 0 && <p>没有匹配的资源，换个关键词试试。</p>}
      </div>
      {visible.length > 0 && (
        <footer className="agent-resource-picker__pagination">
          <span>
            显示 {(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, visible.length)}，共{" "}
            {visible.length.toLocaleString()} 项
          </span>
          <div>
            <button type="button" disabled={safePage === 1} onClick={() => setPage(safePage - 1)} aria-label="上一页">
              <ChevronLeft />
            </button>
            <strong>
              {safePage} / {pageCount}
            </strong>
            <button
              type="button"
              disabled={safePage === pageCount}
              onClick={() => setPage(safePage + 1)}
              aria-label="下一页"
            >
              <ChevronRight />
            </button>
          </div>
        </footer>
      )}
    </div>
  );
}
function IdentitySection({ draft, update }: Pick<AgentEditorSectionProps, "draft" | "update">) {
  return (
    <section className="agent-editor-section">
      <SectionIntro
        eyebrow="IDENTITY"
        title="身份与指令"
        description="定义这个智能体是谁、如何思考，以及每次接到任务时必须遵守的边界。"
      />
      <div className="agent-editor-form-grid">
        <FormField label="显示名称" hint="创建后不可修改">
          <input value={draft.name} disabled />
        </FormField>
        <FormField label="内部标识" hint="用于 API 与日志定位">
          <input className="is-mono" value={draft.slug} disabled />
        </FormField>
        <FormField label="简短描述">
          <input
            value={draft.description}
            onChange={(event) => update("description", event.target.value)}
            placeholder="让团队快速理解它能完成什么"
          />
        </FormField>
      </div>
      <FormField label="系统指令 Prompt" hint={`${draft.prompt.length.toLocaleString()} 字符`}>
        <textarea
          className="agent-prompt-editor"
          value={draft.prompt}
          onChange={(event) => {
            update("prompt", event.target.value);
            update("templateId", null);
          }}
          rows={12}
          placeholder="描述角色、目标、工作方式、约束与输出要求…"
        />
      </FormField>
      <p className="agent-editor-guidance">
        <Info /> 好指令应明确：信息不足时如何处理、哪些来源可信、输出如何验收，以及什么必须交由人确认。
      </p>
    </section>
  );
}
function ModelSection({ draft, update }: Pick<AgentEditorSectionProps, "draft" | "update">) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 6;
  const selectedModel = MODEL_OPTIONS.find((model) => model.id === draft.modelId);
  const visibleModels = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return MODEL_OPTIONS;
    return MODEL_OPTIONS.filter((model) =>
      `${model.name}${model.description}${model.meta}`.toLowerCase().includes(normalized),
    );
  }, [query]);
  const pageCount = Math.max(1, Math.ceil(visibleModels.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageModels = visibleModels.slice((safePage - 1) * pageSize, safePage * pageSize);
  return (
    <section className="agent-editor-section">
      <SectionIntro
        eyebrow="MODEL"
        title="推理模型"
        description="模型决定智能体的推理质量、上下文容量与响应特征。切换模型不会修改 Prompt 和已绑定能力。"
      />
      <div className="agent-single-picker-toolbar">
        <label>
          <Search />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder="搜索模型名称、Provider 或上下文容量"
          />
        </label>
        <span>{visibleModels.length.toLocaleString()} 个模型</span>
      </div>
      {selectedModel && (
        <div className="agent-single-picker-current">
          <small>当前选择</small>
          <strong>{selectedModel.name}</strong>
          <span>
            {selectedModel.description} · {selectedModel.meta}
          </span>
        </div>
      )}
      <div className="agent-model-options" role="radiogroup" aria-label="推理模型">
        {pageModels.map((model) => {
          const selected = model.id === draft.modelId;
          return (
            <button
              className={selected ? "is-selected" : ""}
              type="button"
              role="radio"
              aria-checked={selected}
              key={model.id}
              onClick={() => update("modelId", model.id)}
            >
              <span className="agent-model-options__icon">
                <Cpu />
              </span>
              <span className="agent-model-options__copy">
                <strong>{model.name}</strong>
                <small>{model.description}</small>
              </span>
              <em>{model.meta}</em>
              <i>{selected && <Check />}</i>
            </button>
          );
        })}
      </div>
      <PickerPagination
        page={safePage}
        pageCount={pageCount}
        total={visibleModels.length}
        pageSize={pageSize}
        onPage={setPage}
      />
      <div className="agent-model-summary">
        <span>
          <Cpu />
        </span>
        <div>
          <small>当前生效模型</small>
          <strong>{selectedModel?.name}</strong>
          <p>
            {selectedModel?.description} · {selectedModel?.meta}
          </p>
        </div>
        <em>切换后需重启</em>
      </div>
      <p className="agent-editor-guidance">
        <Info /> 对长文档、多轮任务或大量知识检索，应优先选择上下文容量更高的模型；发布前仍需验证真实业务效果。
      </p>
    </section>
  );
}
function CapabilitiesSection({ draft, update }: Pick<AgentEditorSectionProps, "draft" | "update">) {
  const [kind, setKind] = useState<"skills" | "mcp" | "sites">("skills");
  const current =
    kind === "skills"
      ? { options: SKILL_OPTIONS, ids: draft.skillIds, field: "skillIds" as const, placeholder: "搜索 Skills" }
      : kind === "mcp"
        ? { options: MCP_OPTIONS, ids: draft.mcpIds, field: "mcpIds" as const, placeholder: "搜索 MCP 插件" }
        : { options: SITE_OPTIONS, ids: draft.siteIds, field: "siteIds" as const, placeholder: "搜索已部署应用" };

  return (
    <section className="agent-editor-section">
      <SectionIntro
        eyebrow="CAPABILITIES"
        title="能力与工具"
        description="只授予完成任务所需的能力。所有已选资源都会随智能体配置一起发布。"
      />
      <div className="agent-capability-tabs" role="tablist" aria-label="能力类型">
        <button className={kind === "skills" ? "is-active" : ""} type="button" onClick={() => setKind("skills")}>
          <Sparkles /> Skills <span>{draft.skillIds.length}</span>
        </button>
        <button className={kind === "mcp" ? "is-active" : ""} type="button" onClick={() => setKind("mcp")}>
          <Plug /> MCP <span>{draft.mcpIds.length}</span>
        </button>
        <button className={kind === "sites" ? "is-active" : ""} type="button" onClick={() => setKind("sites")}>
          <Globe2 /> Sites <span>{draft.siteIds.length}</span>
        </button>
      </div>
      <ResourcePicker
        key={kind}
        options={current.options}
        selectedIds={current.ids}
        onChange={(ids) => update(current.field, ids)}
        searchPlaceholder={current.placeholder}
      />
    </section>
  );
}
function KnowledgeSection({ draft, update }: Pick<AgentEditorSectionProps, "draft" | "update">) {
  return (
    <section className="agent-editor-section">
      <SectionIntro
        eyebrow="CONTEXT"
        title="知识与记忆"
        description="配置可追溯的事实来源、检索策略与跨会话长期记忆，共同形成模型的上下文。"
      />
      <div className="agent-memory-section">
        <div className="agent-memory-section__heading">
          <Brain />
          <div>
            <strong>长期记忆</strong>
            <small>记忆来自跨会话沉淀，与知识库共同提供上下文，但不参与文档检索。</small>
          </div>
        </div>
        <ToggleRow
          checked={draft.enableMemory}
          onChange={(checked) => update("enableMemory", checked)}
          icon={<Brain />}
          title="跨会话记忆"
          description="允许智能体记住用户偏好与长期事实；敏感内容仍受组织数据策略约束。"
          badge="Hindsight"
        />
      </div>
      <ResourcePicker
        options={KNOWLEDGE_OPTIONS}
        selectedIds={draft.knowledgeBaseIds}
        onChange={(ids) => update("knowledgeBaseIds", ids)}
        searchPlaceholder="搜索知识库名称、内容或状态"
      />
      <div className="agent-policy-card">
        <div className="agent-policy-card__heading">
          <span>
            <Database />
          </span>
          <div>
            <strong>检索策略</strong>
            <small>这些设置会影响响应速度、引用质量与上下文消耗。</small>
          </div>
        </div>
        <ToggleRow
          checked={draft.searchFirst}
          onChange={(checked) => update("searchFirst", checked)}
          icon={<Search />}
          title="回答前优先检索"
          description="每轮先查询知识库，再让模型基于召回内容回答。"
          badge="推荐"
        />
        <div className="agent-result-limit">
          <div>
            <strong>最大返回条数</strong>
            <small>建议 4–8 条；更多结果会占用更长上下文。</small>
          </div>
          <div>
            <button type="button" onClick={() => update("maxResults", Math.max(1, draft.maxResults - 1))}>
              −
            </button>
            <input
              type="number"
              min={1}
              max={20}
              value={draft.maxResults}
              onChange={(event) => update("maxResults", Math.min(20, Math.max(1, Number(event.target.value) || 1)))}
              aria-label="知识库最大返回条数"
            />
            <button type="button" onClick={() => update("maxResults", Math.min(20, draft.maxResults + 1))}>
              +
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
function RuntimeSection({ draft, update }: Pick<AgentEditorSectionProps, "draft" | "update">) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 5;
  const selectedNode = NODE_OPTIONS.find((node) => node.id === draft.nodeId);
  const visibleNodes = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return NODE_OPTIONS;
    return NODE_OPTIONS.filter((node) =>
      `${node.name}${node.description}${node.meta}`.toLowerCase().includes(normalized),
    );
  }, [query]);
  const pageCount = Math.max(1, Math.ceil(visibleNodes.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageNodes = visibleNodes.slice((safePage - 1) * pageSize, safePage * pageSize);
  return (
    <section className="agent-editor-section">
      <SectionIntro
        eyebrow="RUNTIME"
        title="运行环境"
        description="选择智能体实际执行工具与处理文件的位置。远程资源不可用时不会静默回退到本地。"
      />
      <div className="agent-single-picker-toolbar">
        <label>
          <Search />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder="搜索 Sandbox Pool 或 Machine"
          />
        </label>
        <span>{visibleNodes.length.toLocaleString()} 个节点</span>
      </div>
      {selectedNode && (
        <div className="agent-single-picker-current">
          <small>当前选择</small>
          <strong>{selectedNode.name}</strong>
          <span>
            {selectedNode.description} · {selectedNode.meta}
          </span>
        </div>
      )}
      <div className="agent-node-list">
        {pageNodes.map((node) => {
          const selected = node.id === draft.nodeId;
          const sandbox = node.id.startsWith("sandbox:");
          return (
            <button
              className={selected ? "is-selected" : ""}
              type="button"
              key={node.id}
              onClick={() => update("nodeId", node.id)}
              aria-pressed={selected}
            >
              <span className="agent-node-list__icon">{sandbox ? <Server /> : <Cpu />}</span>
              <span>
                <strong>{node.name}</strong>
                <small>{node.description}</small>
              </span>
              <em>{node.meta}</em>
              <i>{selected && <Check />}</i>
            </button>
          );
        })}
      </div>
      <PickerPagination
        page={safePage}
        pageCount={pageCount}
        total={visibleNodes.length}
        pageSize={pageSize}
        onPage={setPage}
      />
      <div className="agent-runtime-note">
        <Server />
        <div>
          <strong>工作区隔离已开启</strong>
          <p>运行目录按组织、用户和环境隔离。浏览器传入的路径不会覆盖服务端工作区。</p>
        </div>
      </div>
    </section>
  );
}
function SharingSection({ draft, update }: Pick<AgentEditorSectionProps, "draft" | "update">) {
  return (
    <section className="agent-editor-section">
      <SectionIntro
        eyebrow="ACCESS"
        title="共享与访问"
        description="控制团队成员能否发现和使用该智能体。编辑权限始终由资源归属决定。"
      />
      <div className="agent-owner-card">
        <span>凤</span>
        <div>
          <small>资源归属</small>
          <strong>凤凰科技 · 智能应用组</strong>
          <p>你可以编辑配置并管理共享范围。</p>
        </div>
        <em>所有者</em>
      </div>
      <ToggleRow
        checked={draft.publicReadable}
        onChange={(checked) => update("publicReadable", checked)}
        icon={<Globe2 />}
        title="允许组织内其他团队使用"
        description="成员可以查看并运行智能体，但不能修改、转移或删除此配置。"
      />
      <div className="agent-access-preview">
        <strong>当前可见范围</strong>
        <div>
          <span>智能应用组</span>
          <i />
          <span>{draft.publicReadable ? "凤凰科技全组织" : "仅当前团队"}</span>
        </div>
        <small>
          {draft.publicReadable ? "共享后不会公开 Prompt 和扩展 JSON。" : "其他团队的资源列表中不会出现此智能体。"}
        </small>
      </div>
    </section>
  );
}
function AdvancedSection({ draft, update }: Pick<AgentEditorSectionProps, "draft" | "update">) {
  let error = "";
  if (draft.extra.trim()) {
    try {
      JSON.parse(draft.extra);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "JSON 格式无效";
    }
  }
  const format = () => {
    if (error || !draft.extra.trim()) return;
    update("extra", JSON.stringify(JSON.parse(draft.extra), null, 2));
  };

  return (
    <section className="agent-editor-section">
      <SectionIntro
        eyebrow="ADVANCED"
        title="扩展配置"
        description="为特定运行时能力提供 JSON 参数。常规配置请优先使用前面的可视化选项。"
      />
      <div className={`agent-json-editor${error ? " has-error" : ""}`}>
        <header>
          <span>
            <Braces /> extra.json
          </span>
          <div>
            <button type="button" onClick={() => update("extra", "")}>
              <RotateCcw /> 清空
            </button>
            <button type="button" onClick={format} disabled={Boolean(error) || !draft.extra.trim()}>
              <WandSparkles /> 格式化
            </button>
          </div>
        </header>
        <textarea
          value={draft.extra}
          onChange={(event) => update("extra", event.target.value)}
          rows={18}
          spellCheck={false}
          aria-label="扩展配置 JSON"
        />
        <footer>
          {error ? (
            <span>{error}</span>
          ) : (
            <span className="is-valid">
              <Check /> JSON 格式有效
            </span>
          )}
          <small>仅保存必要参数，不要在此填写密钥或连接串。</small>
        </footer>
      </div>
    </section>
  );
}

export function AgentEditorSection({ section, draft, update }: AgentEditorSectionProps) {
  if (section === "identity") return <IdentitySection draft={draft} update={update} />;
  if (section === "model") return <ModelSection draft={draft} update={update} />;
  if (section === "capabilities") return <CapabilitiesSection draft={draft} update={update} />;
  if (section === "knowledge") return <KnowledgeSection draft={draft} update={update} />;
  if (section === "runtime") return <RuntimeSection draft={draft} update={update} />;
  if (section === "sharing") return <SharingSection draft={draft} update={update} />;
  return <AdvancedSection draft={draft} update={update} />;
}
