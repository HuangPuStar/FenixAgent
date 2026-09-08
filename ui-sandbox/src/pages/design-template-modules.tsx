import {
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Database,
  FileText,
  Globe2,
  LoaderCircle,
  Pencil,
  Server,
  Trash2,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { RowMenu, Status, Tag } from "../components/ui";

export function TemplateSpec({
  title,
  description,
  componentName,
  notes,
  children,
}: {
  title: string;
  description: string;
  componentName: string;
  notes: string[];
  children: ReactNode;
}) {
  return (
    <section className="design-template-spec">
      <header>
        <div>
          <strong>{title}</strong>
          <span>{description}</span>
        </div>
        <code>{componentName}</code>
      </header>
      <div className="design-template-preview">{children}</div>
      <footer>
        {notes.map((note) => (
          <span key={note}>{note}</span>
        ))}
      </footer>
    </section>
  );
}

const PROVIDERS = [
  { id: "openai", name: "OpenAI Production", meta: "2 个模型", icon: BrainCircuit },
  { id: "anthropic", name: "Anthropic", meta: "1 个模型", icon: Bot },
  { id: "aliyun", name: "阿里云百炼", meta: "2 个模型", icon: Cloud },
];

export function MasterDetailTemplate() {
  const [selectedId, setSelectedId] = useState("openai");
  const selected = PROVIDERS.find((provider) => provider.id === selectedId) ?? PROVIDERS[0];
  const SelectedIcon = selected.icon;

  return (
    <div className="template-workbench">
      <aside>
        <header>
          <strong>服务商</strong>
          <span>3</span>
        </header>
        <nav aria-label="服务商模版列表">
          {PROVIDERS.map((provider) => {
            const Icon = provider.icon;
            return (
              <button
                type="button"
                className={selectedId === provider.id ? "is-active" : ""}
                onClick={() => setSelectedId(provider.id)}
                key={provider.id}
              >
                <span>
                  <Icon />
                </span>
                <span>
                  <strong>{provider.name}</strong>
                  <small>{provider.meta}</small>
                </span>
                <ChevronRight />
              </button>
            );
          })}
        </nav>
      </aside>
      <section>
        <header className="template-detail-header">
          <span className="template-detail-header__icon">
            <SelectedIcon />
          </span>
          <div>
            <strong>{selected.name}</strong>
            <small>{selected.id}-production</small>
          </div>
          <Status>已连接</Status>
          <button className="button button--ghost" type="button">
            <Pencil /> 编辑
          </button>
        </header>
        <div className="template-model-rows">
          {[
            ["GPT-5.2", "gpt-5.2", true],
            ["GPT-4.1 mini", "gpt-4.1-mini", false],
          ].map(([name, id, reasoning]) => (
            <article key={id as string}>
              <span className="template-row-icon">
                <BrainCircuit />
              </span>
              <span>
                <strong>{name as string}</strong>
                <small>{id as string}</small>
              </span>
              <Tag tone={reasoning ? "blue" : undefined}>{reasoning ? "支持思考" : "无思考"}</Tag>
              <RowMenu />
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

export function CompactListTemplate() {
  const rows = [
    ["发布检查清单", "release-checklist", FileText, "已同步", "success"],
    ["生产数据库", "postgres-production", Database, "需授权", "warning"],
    ["Browser Control", "18 个工具", Globe2, "可用", "success"],
  ] as const;
  return (
    <div className="template-compact-list">
      {rows.map(([name, meta, Icon, status, kind]) => (
        <article key={name}>
          <span className="template-row-icon">
            <Icon />
          </span>
          <span>
            <strong>{name}</strong>
            <small>{meta}</small>
          </span>
          <Status kind={kind}>{status}</Status>
          <RowMenu />
        </article>
      ))}
    </div>
  );
}

const DATA_ROWS = [
  ["知识检索", "Research Agent", "今天 09:42", "运行中"],
  ["日报汇总", "Operations Agent", "今天 08:00", "已完成"],
  ["发布检查", "Release Agent", "昨天 18:24", "失败"],
];

export function DataListTemplate() {
  const [selected, setSelected] = useState<string[]>([]);
  const [ascending, setAscending] = useState(true);
  const rows = ascending ? DATA_ROWS : [...DATA_ROWS].reverse();
  const toggle = (name: string) =>
    setSelected((current) => (current.includes(name) ? current.filter((item) => item !== name) : [...current, name]));

  return (
    <div className="template-data-list">
      <div className="template-data-list__actions">
        <span>{selected.length ? `已选择 ${selected.length} 项` : "3 个任务"}</span>
        {selected.length > 0 && (
          <button className="button button--ghost" type="button" onClick={() => setSelected([])}>
            清除选择
          </button>
        )}
      </div>
      <table>
        <thead>
          <tr>
            <th aria-label="选择" />
            <th>
              <button type="button" onClick={() => setAscending(!ascending)}>
                名称 <ChevronDown className={ascending ? "" : "is-reversed"} />
              </button>
            </th>
            <th>执行者</th>
            <th>最近运行</th>
            <th>状态</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, owner, time, status]) => (
            <tr key={name}>
              <td>
                <input
                  type="checkbox"
                  aria-label={`选择${name}`}
                  checked={selected.includes(name)}
                  onChange={() => toggle(name)}
                />
              </td>
              <td>
                <strong>{name}</strong>
              </td>
              <td>{owner}</td>
              <td>{time}</td>
              <td>
                <Status kind={status === "已完成" ? "success" : status === "失败" ? "danger" : "warning"}>
                  {status}
                </Status>
              </td>
              <td>
                <RowMenu />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <footer>
        <span>第 1–3 项，共 24 项</span>
        <div>
          <button type="button" aria-label="上一页" disabled>
            <ChevronLeft />
          </button>
          <button type="button" className="is-active">
            1
          </button>
          <button type="button">2</button>
          <button type="button" aria-label="下一页">
            <ChevronRight />
          </button>
        </div>
      </footer>
    </div>
  );
}

export function CatalogTemplate() {
  const cards = [
    ["Filesystem", "读取、搜索和修改工作区文件。", FileText, "开发工具", "已添加"],
    ["PostgreSQL", "以只读权限查询项目数据库。", Database, "数据", "查看"],
    ["Cloud Runtime", "管理部署、日志和运行状态。", Server, "云服务", "查看"],
  ] as const;
  return (
    <div className="template-catalog">
      {cards.map(([name, description, Icon, category, action]) => (
        <article key={name}>
          <header>
            <span className="template-row-icon">
              <Icon />
            </span>
            <div>
              <strong>{name}</strong>
              <small>Fenix Labs</small>
            </div>
            {action === "已添加" && <Check />}
          </header>
          <p>{description}</p>
          <footer>
            <Tag>{category}</Tag>
            <button type="button">{action}</button>
          </footer>
        </article>
      ))}
    </div>
  );
}

export function TimelineTemplate() {
  const items = [
    ["09:00", "日报汇总", "执行完成", "42s", "done"],
    ["10:30", "知识库同步", "正在运行", "03:18", "running"],
    ["14:00", "发布前检查", "等待运行", "—", "pending"],
  ];
  return (
    <div className="template-timeline">
      {items.map(([time, name, status, duration, state]) => (
        <article className={`is-${state}`} key={name}>
          <time>{time}</time>
          <span className="template-timeline__axis">
            {state === "running" ? <LoaderCircle /> : state === "done" ? <Check /> : null}
          </span>
          <div>
            <strong>{name}</strong>
            <small>{status}</small>
          </div>
          <span>{duration}</span>
          {state === "running" && (
            <button className="button button--ghost" type="button">
              查看运行
            </button>
          )}
        </article>
      ))}
    </div>
  );
}

export function DetailHeaderTemplate() {
  return (
    <header className="template-object-header">
      <span className="template-object-header__icon">
        <BrainCircuit />
      </span>
      <div>
        <span>
          <strong>OpenAI Production</strong>
          <Status>已连接</Status>
        </span>
        <small>openai-production · 本组织 · 今天 09:42 更新</small>
      </div>
      <button className="button button--ghost" type="button">
        <Pencil /> 编辑
      </button>
      <button className="button button--danger" type="button">
        <Trash2 /> 删除
      </button>
    </header>
  );
}
