import {
  Bot,
  Boxes,
  ChevronRight,
  Copy,
  FileText,
  MessageSquareText,
  MoreHorizontal,
  Play,
  Settings2,
  Share2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { FormFields, Modal, PageHeader, PrimaryButton, SearchField, Status, Tag, Toast } from "../components/ui";
import type { PageId } from "../navigation";

const AGENTS = [
  {
    name: "公文写手",
    desc: "根据政策资料起草、改写和审校公文",
    model: "Nova 4.1",
    skills: 6,
    calls: "428",
    status: "运行中",
    tone: "success" as const,
  },
  {
    name: "AgentSites 建站助手",
    desc: "从需求到发布，完成站点设计与构建",
    model: "Claude Sonnet 4.5",
    skills: 8,
    calls: "215",
    status: "运行中",
    tone: "success" as const,
  },
  {
    name: "投标文件审查",
    desc: "识别投标材料中的缺项与履约风险",
    model: "GPT-5.2",
    skills: 4,
    calls: "189",
    status: "待更新",
    tone: "warning" as const,
  },
  {
    name: "经营数据助手",
    desc: "查询业务库并生成经营分析简报",
    model: "Qwen3 Max",
    skills: 5,
    calls: "96",
    status: "已停用",
    tone: "default" as const,
  },
  {
    name: "舆情观察员",
    desc: "持续收集公开信息并归纳舆情趋势",
    model: "Nova 4.1",
    skills: 7,
    calls: "84",
    status: "运行中",
    tone: "success" as const,
  },
  {
    name: "合同条款比对",
    desc: "对照标准条款发现偏差与缺失",
    model: "DeepSeek V3.2",
    skills: 3,
    calls: "62",
    status: "运行中",
    tone: "success" as const,
  },
];

export function AgentsPage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"list" | "grid">("list");
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState(false);
  const filtered = useMemo(
    () =>
      AGENTS.filter((agent) => `${agent.name}${agent.desc}${agent.model}`.toLowerCase().includes(query.toLowerCase())),
    [query],
  );
  const save = () => {
    setCreating(false);
    setToast(true);
    window.setTimeout(() => setToast(false), 1800);
  };
  return (
    <div className="page-frame agents-page">
      <PageHeader title="智能体管理" description="创建、配置和发布面向不同业务的 Agent，并在一个位置查看运行状态。">
        <PrimaryButton onClick={() => setCreating(true)}>新建智能体</PrimaryButton>
      </PageHeader>
      <div className="toolbar">
        <SearchField value={query} onChange={setQuery} placeholder="搜索智能体、模型或能力" />
        <button className="button" type="button">
          <Settings2 />
          筛选
        </button>
        <div className="toolbar__spacer" />
        <div className="segmented">
          <button className={view === "list" ? "is-active" : ""} onClick={() => setView("list")} type="button">
            列表
          </button>
          <button className={view === "grid" ? "is-active" : ""} onClick={() => setView("grid")} type="button">
            卡片
          </button>
        </div>
      </div>
      {view === "list" ? (
        <section className="panel">
          <table className="table">
            <thead>
              <tr>
                <th>智能体</th>
                <th>模型</th>
                <th>能力</th>
                <th>本月调用</th>
                <th>状态</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((agent) => (
                <tr key={agent.name}>
                  <td>
                    <button className="agent-name" type="button" onClick={() => onNavigate("chat")}>
                      <span className="cell-icon">
                        <Bot />
                      </span>
                      <span className="cell-copy">
                        <strong>{agent.name}</strong>
                        <small>{agent.desc}</small>
                      </span>
                    </button>
                  </td>
                  <td>
                    <Tag tone="blue">{agent.model}</Tag>
                  </td>
                  <td>
                    <span className="inline-data">
                      <Boxes />
                      {agent.skills} 项
                    </span>
                  </td>
                  <td>{agent.calls}</td>
                  <td>
                    <Status kind={agent.tone}>{agent.status}</Status>
                  </td>
                  <td>
                    <button className="kebab" type="button">
                      <MoreHorizontal />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <section className="agent-grid">
          {filtered.map((agent) => (
            <article className="panel agent-card" key={agent.name}>
              <header>
                <span className="cell-icon">
                  <Bot />
                </span>
                <Status kind={agent.tone}>{agent.status}</Status>
              </header>
              <h3>{agent.name}</h3>
              <p>{agent.desc}</p>
              <div className="agent-card__meta">
                <Tag tone="blue">{agent.model}</Tag>
                <span>{agent.skills} 项能力</span>
              </div>
              <footer>
                <button type="button" onClick={() => onNavigate("chat")}>
                  <MessageSquareText />
                  对话
                </button>
                <button type="button">
                  <Play />
                  运行
                </button>
                <button type="button">
                  <ChevronRight />
                </button>
              </footer>
            </article>
          ))}
        </section>
      )}
      {creating && (
        <Modal title="新建智能体" onClose={() => setCreating(false)} onConfirm={save}>
          <FormFields kind="智能体" />
          <div className="template-choice">
            <button type="button" className="is-active">
              <FileText />
              空白配置
            </button>
            <button type="button">
              <Copy />
              从现有复制
            </button>
            <button type="button">
              <Share2 />
              使用模板
            </button>
          </div>
        </Modal>
      )}
      {toast && <Toast text="智能体已创建（Mock）" />}
    </div>
  );
}
