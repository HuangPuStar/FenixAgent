import {
  Activity,
  Brain,
  CalendarClock,
  Check,
  Clock3,
  Eye,
  Fingerprint,
  Globe2,
  Lightbulb,
  ListTree,
  Network,
  Orbit,
  Pause,
  Play,
  Settings2,
  Table2,
  Trash2,
} from "lucide-react";
import { type CSSProperties, useState } from "react";
import {
  FormFields,
  Modal,
  PageHeader,
  PrimaryButton,
  RowMenu,
  SearchField,
  SearchToolbar,
  Status,
  Tag,
  ToolbarSummary,
} from "../components/ui";

type TaskState = "成功" | "运行中" | "失败" | "已暂停" | "待运行";

interface ScheduledRun {
  start: number;
  duration: number;
  state: TaskState;
  label: string;
}

interface ScheduledTask {
  id: string;
  name: string;
  agent: string;
  schedule: string;
  next: string;
  state: TaskState;
  runs: ScheduledRun[];
}

const SCHEDULED_TASKS: ScheduledTask[] = [
  {
    id: "daily-brief",
    name: "每日经营简报",
    agent: "经营数据助手",
    schedule: "每天 08:30",
    next: "明天 08:30",
    state: "成功",
    runs: [{ start: 8.5, duration: 0.8, state: "成功", label: "08:30 · 4 分 18 秒" }],
  },
  {
    id: "policy-watch",
    name: "政策资讯采集",
    agent: "舆情观察员",
    schedule: "每 2 小时",
    next: "12:00",
    state: "运行中",
    runs: [
      { start: 2, duration: 0.5, state: "成功", label: "02:00 · 成功" },
      { start: 4, duration: 0.5, state: "成功", label: "04:00 · 成功" },
      { start: 6, duration: 0.5, state: "成功", label: "06:00 · 成功" },
      { start: 8, duration: 0.5, state: "失败", label: "08:00 · 失败" },
      { start: 10, duration: 0.85, state: "运行中", label: "10:00 · 正在运行" },
      { start: 12, duration: 0.5, state: "待运行", label: "12:00 · 待运行" },
      { start: 14, duration: 0.5, state: "待运行", label: "14:00 · 待运行" },
      { start: 16, duration: 0.5, state: "待运行", label: "16:00 · 待运行" },
    ],
  },
  {
    id: "kb-sync",
    name: "知识库增量同步",
    agent: "文档管理员",
    schedule: "每天 01:00",
    next: "明天 01:00",
    state: "成功",
    runs: [{ start: 1, duration: 1.2, state: "成功", label: "01:00 · 7 分 02 秒" }],
  },
  {
    id: "weekly-report",
    name: "客户周报",
    agent: "客户成功助手",
    schedule: "每周五 17:00",
    next: "周五 17:00",
    state: "已暂停",
    runs: [{ start: 17, duration: 1.25, state: "已暂停", label: "17:00 · 已暂停" }],
  },
  {
    id: "order-check",
    name: "异常订单巡检",
    agent: "经营数据助手",
    schedule: "每 30 分钟",
    next: "10:30",
    state: "失败",
    runs: [
      { start: 7, duration: 0.3, state: "成功", label: "07:00 · 成功" },
      { start: 7.5, duration: 0.3, state: "成功", label: "07:30 · 成功" },
      { start: 8, duration: 0.3, state: "成功", label: "08:00 · 成功" },
      { start: 8.5, duration: 0.3, state: "失败", label: "08:30 · 失败" },
      { start: 9, duration: 0.3, state: "成功", label: "09:00 · 成功" },
      { start: 9.5, duration: 0.3, state: "失败", label: "09:30 · 失败" },
      { start: 10.5, duration: 0.3, state: "待运行", label: "10:30 · 待运行" },
      { start: 11, duration: 0.3, state: "待运行", label: "11:00 · 待运行" },
    ],
  },
];

function taskStateKind(state: TaskState) {
  if (state === "成功") return "success" as const;
  if (state === "运行中" || state === "已暂停") return "warning" as const;
  if (state === "失败") return "danger" as const;
  return "default" as const;
}

export function TasksPage() {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const tasks = SCHEDULED_TASKS.filter((task) => `${task.name}${task.agent}${task.schedule}`.includes(query));
  return (
    <div className="page-frame">
      <PageHeader title="定时任务" description="让智能体按计划自动执行工作，并集中查看每次运行结果与失败原因。">
        <PrimaryButton onClick={() => setOpen(true)}>新建任务</PrimaryButton>
      </PageHeader>
      <section className="task-overview">
        <div>
          <CalendarClock />
          <span>
            <small>未来 24 小时</small>
            <strong>26 次执行</strong>
          </span>
        </div>
        <div>
          <Check />
          <span>
            <small>过去 7 天</small>
            <strong>98.2% 成功</strong>
          </span>
        </div>
        <div>
          <Clock3 />
          <span>
            <small>平均耗时</small>
            <strong>3 分 42 秒</strong>
          </span>
        </div>
      </section>
      <SearchToolbar value={query} onChange={setQuery} placeholder="搜索任务或智能体">
        <button className="button button--ghost" type="button">
          <Settings2 />
          筛选
        </button>
        <ToolbarSummary>
          <span>
            <strong>{tasks.length}</strong> 个任务
          </span>
        </ToolbarSummary>
      </SearchToolbar>
      <section className="panel runtime-board">
        <header className="runtime-board__header">
          <div>
            <span className="runtime-board__icon">
              <Activity />
            </span>
            <div>
              <h3>未来 24 小时运行排布</h3>
              <p>2026 年 8 月 26 日 · 每个色块代表一次计划运行，宽度按预计耗时放大显示。</p>
            </div>
          </div>
          <div className="runtime-legend" role="group" aria-label="运行状态图例">
            {[
              ["成功", "success"],
              ["运行中", "running"],
              ["失败", "failed"],
              ["待运行", "queued"],
              ["已暂停", "paused"],
            ].map(([label, state]) => (
              <span key={state}>
                <i className={`is-${state}`} /> {label}
              </span>
            ))}
          </div>
        </header>
        <div className="runtime-board__body">
          <div className="runtime-axis">
            <span />
            <div>
              {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((hour) => (
                <time key={hour} style={{ left: `${(hour / 24) * 100}%` }}>
                  {String(hour).padStart(2, "0")}:00
                </time>
              ))}
            </div>
          </div>
          {tasks.map((task) => (
            <div className="runtime-row" key={task.id}>
              <div className="runtime-row__label">
                <strong>{task.name}</strong>
                <span>{task.schedule}</span>
              </div>
              <div className="runtime-track">
                <span className="runtime-now" role="img" aria-label="当前时间 10:16" />
                {task.runs.map((run) => (
                  <button
                    type="button"
                    title={run.label}
                    aria-label={`${task.name} ${run.label}`}
                    className={`runtime-run is-${
                      run.state === "成功"
                        ? "success"
                        : run.state === "运行中"
                          ? "running"
                          : run.state === "失败"
                            ? "failed"
                            : run.state === "已暂停"
                              ? "paused"
                              : "queued"
                    }`}
                    style={
                      {
                        "--run-start": `${(run.start / 24) * 100}%`,
                        "--run-width": `${Math.max((run.duration / 24) * 100, 0.9)}%`,
                      } as CSSProperties
                    }
                    key={`${task.id}-${run.start}`}
                  />
                ))}
              </div>
            </div>
          ))}
          {tasks.length === 0 && <div className="runtime-empty">没有匹配的定时任务</div>}
        </div>
      </section>
      <section className="panel task-registry">
        <header className="panel__header">
          <h3>任务管理</h3>
          <span>{tasks.length} 个任务</span>
        </header>
        <table className="table">
          <thead>
            <tr>
              <th>任务</th>
              <th>执行智能体</th>
              <th>计划</th>
              <th>下次运行</th>
              <th>最近状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.id}>
                <td>
                  <div className="cell-title">
                    <span className="cell-icon">
                      <CalendarClock />
                    </span>
                    <strong>{task.name}</strong>
                  </div>
                </td>
                <td>{task.agent}</td>
                <td>
                  <Tag>{task.schedule}</Tag>
                </td>
                <td>{task.next}</td>
                <td>
                  <Status kind={taskStateKind(task.state)}>{task.state}</Status>
                </td>
                <td>
                  <div className="row-actions">
                    <button type="button" aria-label={task.state === "已暂停" ? "运行" : "暂停"}>
                      {task.state === "已暂停" ? <Play /> : <Pause />}
                    </button>
                    <RowMenu />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {open && (
        <Modal title="新建定时任务" onClose={() => setOpen(false)}>
          <FormFields kind="任务" />
          <div className="field">
            <label>执行计划</label>
            <input defaultValue="每天 09:00" />
          </div>
        </Modal>
      )}
    </div>
  );
}

export function MemoriesPage() {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("世界事实");
  const [displayMode, setDisplayMode] = useState<"constellation" | "graph" | "table" | "timeline">("constellation");
  const [selectedMemory, setSelectedMemory] = useState(0);
  const views = [
    ["世界事实", "可验证的客观信息", Globe2, "128"],
    ["经验", "用户与 Agent 的经历", Fingerprint, "54"],
    ["观察", "从行为中形成的判断", Eye, "31"],
    ["心智模型", "归纳后的长期认知", Lightbulb, "12"],
    ["实体", "人物、项目与关系", Network, "23"],
  ] as const;
  const memories = [
    {
      content: "FenixAgent 的生产部署要求 PostgreSQL 连接池与 Agent 并发配置保持独立，避免突发任务占满数据库连接。",
      source: "产品与交付手册",
      type: "世界事实",
      agent: "交付助手",
      time: "今天 10:42",
      confidence: 92,
      evidence: "3 个来源 · 5 次引用",
    },
    {
      content: "用户更倾向先查看可运行示例，再阅读完整配置说明。回答部署问题时，应先给出最小命令和验证结果。",
      source: "会话归纳",
      type: "经验",
      agent: "技术支持",
      time: "昨天 16:18",
      confidence: 86,
      evidence: "6 段会话 · 4 次强化",
    },
    {
      content: "最近三次知识库同步失败都发生在超大 PDF 文件，需要在上传前展示文件预检结果和明确的失败重试入口。",
      source: "运行记录",
      type: "观察",
      agent: "文档管理员",
      time: "8 月 24 日",
      confidence: 78,
      evidence: "3 次运行 · 待确认",
    },
  ].filter(
    (memory) =>
      `${memory.content}${memory.source}${memory.agent}`.toLowerCase().includes(query.toLowerCase()) &&
      (scope === "全部" || memory.type === scope),
  );
  const selected = memories[selectedMemory] ?? memories[0];

  return (
    <div className="page-frame memory-page">
      <PageHeader title="记忆" description="理解 Agent 记住了什么，追溯记忆如何形成，并及时修正不再可靠的认知。" />
      <div className="memory-workspace">
        <aside className="memory-index">
          <header>
            <strong>记忆视角</strong>
            <small>按形成方式查看长期认知</small>
          </header>
          <SearchField value={query} onChange={setQuery} placeholder="搜索记忆" />
          <nav>
            {views.map(([label, description, Icon, count]) => (
              <button
                className={scope === label ? "is-selected" : ""}
                key={label}
                type="button"
                onClick={() => {
                  setScope(label);
                  setSelectedMemory(0);
                }}
              >
                <span>
                  <Icon />
                </span>
                <span>
                  <strong>{label}</strong>
                  <small>{description}</small>
                </span>
                <b>{count}</b>
              </button>
            ))}
          </nav>
          <footer>
            <Brain />
            <span>
              <strong>本周形成 32 条</strong>
              <small>平均可信度 87%</small>
            </span>
          </footer>
        </aside>
        <main className="memory-canvas">
          <section className="memory-pulse">
            <div>
              <Activity />
              <span>
                <strong>记忆脉冲</strong>
                <small>最近 24 小时持续形成</small>
              </span>
            </div>
            <div className="memory-pulse__flow">
              <i />
            </div>
            <span>12 条待确认</span>
          </section>
          <div className="memory-columns">
            <section className="memory-feed">
              <header>
                <div>
                  <strong>{scope}</strong>
                  <small>按最近强化排序</small>
                </div>
                {scope === "世界事实" ? (
                  <nav className="memory-display-modes" aria-label="世界事实展示方式">
                    {[
                      ["constellation", Orbit, "星座图"],
                      ["graph", Network, "图谱"],
                      ["table", Table2, "表格"],
                      ["timeline", ListTree, "时间线"],
                    ].map(([mode, Icon, label]) => (
                      <button
                        className={displayMode === mode ? "is-active" : ""}
                        key={label as string}
                        type="button"
                        title={label as string}
                        onClick={() => setDisplayMode(mode as typeof displayMode)}
                      >
                        <Icon />
                        <span>{label as string}</span>
                      </button>
                    ))}
                  </nav>
                ) : (
                  <span>{memories.length} 条结果</span>
                )}
              </header>
              {scope === "世界事实" && (
                <div className={`memory-view-preview is-${displayMode}`}>
                  {displayMode === "constellation" && (
                    <>
                      <i />
                      <i />
                      <i />
                      <i />
                      <svg viewBox="0 0 300 74">
                        <path d="M32 42L106 18L174 52L266 24M106 18L174 52" />
                      </svg>
                      <span>事实聚类 · 4 个主题星群</span>
                    </>
                  )}
                  {displayMode === "graph" && (
                    <div className="memory-relation-preview">
                      <Network />
                      <span>记忆之间的关联脉络</span>
                      <b>部署偏好</b>
                      <b>失败观察</b>
                      <b>交付经验</b>
                    </div>
                  )}
                  {displayMode === "table" && (
                    <>
                      <span>事实内容</span>
                      <span>来源</span>
                      <span>可信度</span>
                      <strong>生产部署约束</strong>
                      <span>交付手册</span>
                      <em>92%</em>
                    </>
                  )}
                  {displayMode === "timeline" && (
                    <>
                      <i />
                      <span>
                        <strong>今天</strong>形成 3 条部署事实
                      </span>
                      <i />
                      <span>
                        <strong>昨天</strong>强化 5 条产品事实
                      </span>
                    </>
                  )}
                </div>
              )}
              {memories.map((memory, index) => (
                <button
                  className={selected === memory ? "is-selected" : ""}
                  key={memory.content}
                  type="button"
                  onClick={() => setSelectedMemory(index)}
                >
                  <span className="memory-feed__dot" />
                  <span>
                    <small>
                      {memory.source} · {memory.time}
                    </small>
                    <p>{memory.content}</p>
                    <span>
                      <Tag tone="blue">{memory.agent}</Tag>
                      <Tag>{memory.type}</Tag>
                      <em>{memory.evidence}</em>
                    </span>
                  </span>
                </button>
              ))}
              {memories.length === 0 && (
                <div className="memory-empty">
                  <Brain />
                  <strong>没有匹配的记忆</strong>
                  <span>尝试其他关键词或记忆视角。</span>
                </div>
              )}
            </section>
            <aside className="memory-inspector">
              {selected ? (
                <>
                  <header>
                    <small>当前记忆</small>
                    <strong>记忆检查器</strong>
                  </header>
                  <div className="memory-confidence">
                    <strong>{selected.confidence}</strong>
                    <span>可信度</span>
                  </div>
                  <div className="memory-meter">
                    <i style={{ width: `${selected.confidence}%` }} />
                  </div>
                  <dl>
                    <div>
                      <dt>形成方式</dt>
                      <dd>{selected.type}</dd>
                    </div>
                    <div>
                      <dt>来源</dt>
                      <dd>{selected.source}</dd>
                    </div>
                    <div>
                      <dt>最近强化</dt>
                      <dd>{selected.time}</dd>
                    </div>
                    <div>
                      <dt>证据覆盖</dt>
                      <dd>{selected.evidence}</dd>
                    </div>
                  </dl>
                  <button className="button" type="button">
                    查看来源与引用
                  </button>
                  <button className="button button--danger" type="button">
                    <Trash2 />
                    删除这条记忆
                  </button>
                </>
              ) : (
                <div className="memory-empty">
                  <Brain />
                  <strong>选择一条记忆</strong>
                  <span>检查它的来源和可信度。</span>
                </div>
              )}
            </aside>
          </div>
        </main>
      </div>
    </div>
  );
}
