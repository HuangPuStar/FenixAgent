import { ArrowLeft, Check, ChevronRight, Cpu, FileText, Search, Sparkles, X } from "lucide-react";
import { useMemo, useState } from "react";
import { MODEL_OPTIONS, SKILL_OPTIONS, TEMPLATE_OPTIONS } from "./agent-editor-data";

interface AgentTemplateDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (templateName: string) => void;
}

const TEMPLATE_META = {
  "policy-brief": { category: "政务办公", modelId: "claude-sonnet-4-5", uses: 128, owner: "平台预置" },
  "document-review": { category: "内容审校", modelId: "gpt-5-2", uses: 86, owner: "凤凰科技" },
  "meeting-summary": { category: "协同办公", modelId: "qwen3-max", uses: 64, owner: "平台预置" },
} as const;

export function AgentTemplateDialog({ open, onClose, onCreate }: AgentTemplateDialogProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "platform" | "organization">("all");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState(TEMPLATE_OPTIONS[0]?.id ?? "");
  const [name, setName] = useState("");
  const pageSize = 8;
  const visibleTemplates = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return TEMPLATE_OPTIONS.filter((template) => {
      const meta = TEMPLATE_META[template.id as keyof typeof TEMPLATE_META];
      const matchesQuery =
        !normalized || `${template.name}${template.description}${meta?.category}`.toLowerCase().includes(normalized);
      const matchesFilter =
        filter === "all" || (filter === "platform" ? meta?.owner === "平台预置" : meta?.owner !== "平台预置");
      return matchesQuery && matchesFilter;
    });
  }, [filter, query]);
  const pageCount = Math.max(1, Math.ceil(visibleTemplates.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageTemplates = visibleTemplates.slice((safePage - 1) * pageSize, safePage * pageSize);
  const selected = TEMPLATE_OPTIONS.find((template) => template.id === selectedId) ?? TEMPLATE_OPTIONS[0];
  if (!open || !selected) return null;
  const meta = TEMPLATE_META[selected.id as keyof typeof TEMPLATE_META];
  const model = MODEL_OPTIONS.find((item) => item.id === meta?.modelId);
  const selectedSkills = SKILL_OPTIONS.filter((item) => selected.skillIds.includes(item.id));
  const createName = name.trim() || `${selected.name}助手`;

  return (
    <div className="agent-template-backdrop" role="presentation">
      <section className="agent-template-dialog" role="dialog" aria-modal="true" aria-label="从模板创建智能体">
        <header className="agent-template-dialog__header">
          <button type="button" className="agent-template-back" onClick={onClose}>
            <ArrowLeft />
          </button>
          <div>
            <span>AGENT TEMPLATE LIBRARY</span>
            <h2>从模板创建智能体</h2>
            <p>复用旧智能体模板的指令、模型与能力配置，创建后仍可独立调整。</p>
          </div>
          <button type="button" className="agent-template-close" onClick={onClose} aria-label="关闭">
            <X />
          </button>
        </header>
        <div className="agent-template-dialog__body">
          <aside className="agent-template-library">
            <label className="agent-template-search">
              <Search />
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
                placeholder="搜索旧智能体模板"
              />
              <kbd>{visibleTemplates.length.toLocaleString()}</kbd>
            </label>
            <nav className="agent-template-filters" aria-label="模板分类">
              <button
                className={filter === "all" ? "is-active" : ""}
                type="button"
                onClick={() => {
                  setFilter("all");
                  setPage(1);
                }}
              >
                全部
              </button>
              <button
                className={filter === "platform" ? "is-active" : ""}
                type="button"
                onClick={() => {
                  setFilter("platform");
                  setPage(1);
                }}
              >
                平台预置
              </button>
              <button
                className={filter === "organization" ? "is-active" : ""}
                type="button"
                onClick={() => {
                  setFilter("organization");
                  setPage(1);
                }}
              >
                组织模板
              </button>
            </nav>
            <div className="agent-template-cards">
              {pageTemplates.map((template) => {
                const itemMeta = TEMPLATE_META[template.id as keyof typeof TEMPLATE_META];
                const active = template.id === selected.id;
                return (
                  <button
                    className={active ? "is-selected" : ""}
                    type="button"
                    key={template.id}
                    onClick={() => setSelectedId(template.id)}
                  >
                    <span>
                      <FileText />
                    </span>
                    <div>
                      <strong>{template.name}</strong>
                      <small>{template.description}</small>
                      <em>
                        {itemMeta.category} · 已使用 {itemMeta.uses} 次
                      </em>
                    </div>
                    {active ? (
                      <i>
                        <Check />
                      </i>
                    ) : (
                      <ChevronRight />
                    )}
                  </button>
                );
              })}
              {visibleTemplates.length === 0 && <p>没有匹配的模板。</p>}
            </div>
            {visibleTemplates.length > 0 && (
              <footer className="agent-template-pagination">
                <span>
                  {(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, visibleTemplates.length)} /{" "}
                  {visibleTemplates.length.toLocaleString()}
                </span>
                <div>
                  <button type="button" disabled={safePage === 1} onClick={() => setPage(safePage - 1)}>
                    上一页
                  </button>
                  <strong>
                    {safePage} / {pageCount}
                  </strong>
                  <button type="button" disabled={safePage === pageCount} onClick={() => setPage(safePage + 1)}>
                    下一页
                  </button>
                </div>
              </footer>
            )}
          </aside>
          <main className="agent-template-preview">
            <header>
              <span>{meta?.category}</span>
              <h3>{selected.name}</h3>
              <p>{selected.description}</p>
              <small>由 {meta?.owner} 维护 · 创建后生成独立副本</small>
            </header>
            <section className="agent-template-includes">
              <h4>模板将带入</h4>
              <div>
                <article>
                  <Cpu />
                  <span>
                    <small>默认模型</small>
                    <strong>{model?.name}</strong>
                    <em>{model?.meta}</em>
                  </span>
                </article>
                <article>
                  <Sparkles />
                  <span>
                    <small>预置能力</small>
                    <strong>{selectedSkills.length} 项 Skills</strong>
                    <em>{selectedSkills.map((item) => item.name).join(" · ")}</em>
                  </span>
                </article>
              </div>
            </section>
            <section className="agent-template-prompt-preview">
              <div>
                <h4>系统指令预览</h4>
                <span>{selected.prompt.length} 字符</span>
              </div>
              <p>{selected.prompt}</p>
            </section>
            <label className="agent-template-name">
              <span>新智能体名称</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={`${selected.name}助手`}
              />
              <small>模板本身不会被修改，后续配置仅影响新智能体。</small>
            </label>
          </main>
        </div>
        <footer className="agent-template-dialog__footer">
          <span>
            <Check /> 已选择「{selected.name}」模板
          </span>
          <div>
            <button type="button" onClick={onClose}>
              取消
            </button>
            <button type="button" onClick={() => onCreate(createName)}>
              使用此模板创建 <ChevronRight />
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
