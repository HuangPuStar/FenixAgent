import { Activity, Brain, CalendarClock, Check, Clock3, Pause, Play, Settings2, Trash2 } from "lucide-react";
import { type CSSProperties, useState } from "react";
import { Sparkline } from "../components/sparkline";
import {
  FormFields,
  Modal,
  PageHeader,
  PrimaryButton,
  RowMenu,
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
  const [scope, setScope] = useState("全部");
  const memories = [
    ["用户偏好简洁的汇报格式，不使用过多小标题。", "公文写手", "偏好", "今天 09:18"],
    ["凤凰科技的投标文档统一使用 2026 版公司简介。", "投标文件审查", "事实", "昨天 16:42"],
    ["经营简报需在每周一增加环比和同比解释。", "经营数据助手", "规则", "8 月 21 日"],
    ["用户负责 UI/UX 设计，当前关注 Chat 面板重构。", "全局记忆", "背景", "8 月 20 日"],
    ["发布站点前先执行移动端截图检查。", "AgentSites 建站助手", "流程", "8 月 18 日"],
  ].filter((row) => row.join("").toLowerCase().includes(query.toLowerCase()) && (scope === "全部" || row[2] === scope));
  return (
    <div className="page-frame">
      <PageHeader title="记忆" description="查看 Agent 长期保留的事实、偏好和工作规则，决定哪些内容应该继续被使用。">
        <button className="button" type="button">
          <Settings2 />
          记忆策略
        </button>
      </PageHeader>
      <div className="memory-summary">
        <section className="memory-orbit">
          <span>
            <Brain />
          </span>
          <div>
            <strong>248</strong>
            <small>有效记忆</small>
          </div>
          <i style={{ transform: "rotate(24deg)" }} />
          <i style={{ transform: "rotate(146deg)" }} />
          <i style={{ transform: "rotate(270deg)" }} />
        </section>
        <div className="panel memory-stats">
          <div>
            <span>本周新增</span>
            <strong>32</strong>
          </div>
          <div>
            <span>本周使用</span>
            <strong>186 次</strong>
          </div>
          <div>
            <span>平均置信度</span>
            <strong>0.87</strong>
          </div>
          <Sparkline values={[12, 15, 13, 21, 24, 19, 31]} tone="green" />
        </div>
      </div>
      <SearchToolbar value={query} onChange={setQuery} placeholder="搜索记忆内容或智能体">
        <div className="segmented">
          {["全部", "事实", "偏好", "规则", "背景", "流程"].map((item) => (
            <button
              className={scope === item ? "is-active" : ""}
              onClick={() => setScope(item)}
              type="button"
              key={item}
            >
              {item}
            </button>
          ))}
        </div>
        <ToolbarSummary>
          <span>
            <strong>{memories.length}</strong> 条记忆
          </span>
        </ToolbarSummary>
      </SearchToolbar>
      <section className="memory-list panel">
        {memories.map((memory) => (
          <article key={memory[0]}>
            <span className="memory-list__dot" />
            <div>
              <p>{memory[0]}</p>
              <footer>
                <Tag tone="blue">{memory[1]}</Tag>
                <Tag>{memory[2]}</Tag>
                <time>{memory[3]}</time>
              </footer>
            </div>
            <button type="button">
              <Trash2 />
            </button>
          </article>
        ))}
      </section>
    </div>
  );
}
