import {
  type Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  Cpu,
  Database,
  Filter,
  HardDrive,
  RefreshCw,
  Wifi,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Sparkline } from "../components/sparkline";
import { PageHeader, RowMenu, SearchField, Status, Tag } from "../components/ui";

export function AdminPage() {
  return (
    <div className="page-frame">
      <PageHeader title="运行概览" description="从平台视角观察实例、消息通道、存储和任务队列的实时健康状态。">
        <button className="button" type="button">
          <RefreshCw />
          刷新
        </button>
      </PageHeader>
      <section className="admin-health">
        <div className="admin-health__lead">
          <span>
            <CheckCircle2 />
          </span>
          <div>
            <strong>平台运行正常</strong>
            <p>所有核心服务可用，暂无影响用户的事件。</p>
          </div>
          <small>最后检查 09:46:18</small>
        </div>
        <div className="admin-health__services">
          {[
            ["API 服务", "28 ms"],
            ["PostgreSQL", "4 ms"],
            ["Redis", "2 ms"],
            ["Agent Relay", "46 个连接"],
          ].map(([name, value]) => (
            <div key={name}>
              <Status>{name}</Status>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      </section>
      <section className="metric-grid">
        <div className="panel metric">
          <span>在线实例</span>
          <strong>46</strong>
          <small>容量 23%</small>
        </div>
        <div className="panel metric">
          <span>每分钟请求</span>
          <strong>382</strong>
          <small>错误率 0.08%</small>
        </div>
        <div className="panel metric">
          <span>消息延迟 P95</span>
          <strong>118ms</strong>
          <small>低于目标 200ms</small>
        </div>
        <div className="panel metric">
          <span>待处理任务</span>
          <strong>7</strong>
          <small className="metric__warning">队列运行正常</small>
        </div>
      </section>
      <div className="admin-grid">
        <section className="panel">
          <header className="panel__header">
            <h3>请求与延迟</h3>
            <div className="segmented">
              <button className="is-active" type="button">
                1h
              </button>
              <button type="button">24h</button>
              <button type="button">7d</button>
            </div>
          </header>
          <div className="admin-chart">
            <Sparkline values={[43, 45, 39, 56, 58, 62, 54, 67, 74, 68, 79, 76, 84, 88]} />
            <div className="chart-grid" />
            <footer>
              <span>
                <i />
                请求量 382/min
              </span>
              <span>
                <i />
                P95 118ms
              </span>
            </footer>
          </div>
        </section>
        <section className="panel">
          <header className="panel__header">
            <h3>资源使用</h3>
          </header>
          <div className="resource-usage">
            {[
              [Cpu, "CPU", 42],
              [HardDrive, "内存", 61],
              [Database, "数据库连接", 28],
              [Wifi, "WebSocket", 23],
            ].map(([Icon, name, value]) => {
              const ItemIcon = Icon as typeof Cpu;
              return (
                <div key={name as string}>
                  <ItemIcon />
                  <span>
                    <strong>{name as string}</strong>
                    <small>{value as number}%</small>
                  </span>
                  <div>
                    <i style={{ width: `${value}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
      <section className="panel incidents">
        <header className="panel__header">
          <h3>最近事件</h3>
          <button className="button button--ghost" type="button">
            查看事件历史
          </button>
        </header>
        {[
          [CheckCircle2, "Agent Relay 扩容完成", "新增 2 个 worker，连接已均衡", "今天 08:22", "success"],
          [AlertTriangle, "模型供应商延迟升高", "Anthropic P95 延迟持续 6 分钟高于阈值", "昨天 17:41", "warning"],
          [CheckCircle2, "快照存储恢复", "Redis 暂时性错误已自动恢复", "8 月 22 日", "success"],
        ].map(([Icon, title, desc, time, state]) => {
          const EventIcon = Icon as typeof Activity;
          return (
            <div className={`incident incident--${state}`} key={title as string}>
              <EventIcon />
              <span>
                <strong>{title as string}</strong>
                <small>{desc as string}</small>
              </span>
              <time>{time as string}</time>
            </div>
          );
        })}
      </section>
    </div>
  );
}

export function PeoplePage() {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("实例");
  const instances = [
    ["ins_8f2a", "公文写手", "Pu Wang", "machine-cn-01", "12 分钟", "运行中"],
    ["ins_2c1d", "经营数据助手", "Lin Chen", "machine-cn-02", "38 分钟", "运行中"],
    ["ins_7b4e", "投标文件审查", "Mei Zhao", "machine-cn-01", "4 分钟", "空闲"],
    ["ins_1a9f", "舆情观察员", "Pu Wang", "machine-edge-03", "1 小时", "运行中"],
    ["ins_5d3c", "站点构建助手", "Tao Li", "machine-cn-02", "—", "离线"],
  ].filter((row) => row.join("").toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="page-frame">
      <PageHeader title="用户与实例" description="查看谁在使用平台、运行了哪些 Agent 实例，以及实例分布和占用情况。">
        <button className="button" type="button">
          <RefreshCw />
          刷新
        </button>
      </PageHeader>
      <div className="resource-tabs">
        <div className="segmented">
          {["实例", "用户", "机器"].map((item) => (
            <button className={tab === item ? "is-active" : ""} type="button" onClick={() => setTab(item)} key={item}>
              {item}
            </button>
          ))}
        </div>
        <span>46 在线 · 12 空闲 · 3 离线</span>
      </div>
      <div className="toolbar">
        <SearchField value={query} onChange={setQuery} placeholder={`搜索${tab}、用户或机器`} />
        <button className="button" type="button">
          <Filter />
          筛选
        </button>
      </div>
      <section className="panel">
        <table className="table">
          <thead>
            <tr>
              <th>实例</th>
              <th>智能体</th>
              <th>用户</th>
              <th>机器</th>
              <th>持续时间</th>
              <th>状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {instances.map((row) => (
              <tr key={row[0]}>
                <td>
                  <code>{row[0]}</code>
                </td>
                <td>
                  <div className="cell-title">
                    <span className="cell-icon">
                      <Bot />
                    </span>
                    <strong>{row[1]}</strong>
                  </div>
                </td>
                <td>
                  <div className="mini-user">
                    <span>{row[2].slice(0, 1)}</span>
                    {row[2]}
                  </div>
                </td>
                <td>
                  <Tag>{row[3]}</Tag>
                </td>
                <td>{row[4]}</td>
                <td>
                  <Status kind={row[5] === "运行中" ? "success" : row[5] === "离线" ? "danger" : "default"}>
                    {row[5]}
                  </Status>
                </td>
                <td>
                  <RowMenu />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export function LogsPage() {
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState("全部");
  const [live, setLive] = useState(true);
  const logs = useMemo(
    () =>
      [
        ["09:46:18.421", "INFO", "agent-relay", "session/new completed", "ins_8f2a · 84ms"],
        ["09:46:17.008", "INFO", "yjs-store", "snapshot persisted", "chat:rcs_a91c · 12kb"],
        ["09:46:15.773", "WARN", "model-router", "provider latency above threshold", "anthropic · 2241ms"],
        ["09:46:12.102", "INFO", "task-runner", "scheduled task started", "task_daily_report"],
        ["09:46:08.941", "ERROR", "file-ws", "remote machine connection refused", "machine-edge-04"],
        ["09:46:02.337", "DEBUG", "auth", "organization context resolved", "org_phoenix"],
        ["09:45:58.112", "INFO", "mcp", "tools/list refreshed", "github · 24 tools"],
      ].filter(
        (row) => row.join(" ").toLowerCase().includes(query.toLowerCase()) && (level === "全部" || row[1] === level),
      ),
    [query, level],
  );
  return (
    <div className="page-frame logs-page">
      <PageHeader title="运行日志" description="实时检索平台日志，按级别和服务定位请求、实例与外部连接问题。">
        <button className={`button${live ? " button--primary" : ""}`} type="button" onClick={() => setLive(!live)}>
          <span className={`live-dot${live ? " is-live" : ""}`} />
          {live ? "实时跟随" : "已暂停"}
        </button>
      </PageHeader>
      <div className="log-toolbar">
        <SearchField value={query} onChange={setQuery} placeholder="搜索消息、实例 ID 或服务" />
        <div className="segmented">
          {["全部", "DEBUG", "INFO", "WARN", "ERROR"].map((item) => (
            <button
              className={level === item ? "is-active" : ""}
              type="button"
              onClick={() => setLevel(item)}
              key={item}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="toolbar__spacer" />
        <button className="button" type="button">
          <Clock3 />
          最近 30 分钟
        </button>
      </div>
      <section className="log-console">
        {logs.map((row) => (
          <div className={`log-row log-row--${row[1].toLowerCase()}`} key={`${row[0]}-${row[2]}`}>
            <time>{row[0]}</time>
            <strong>{row[1]}</strong>
            <span>{row[2]}</span>
            <p>{row[3]}</p>
            <code>{row[4]}</code>
          </div>
        ))}
      </section>
      <footer className="log-footer">
        <span>{live ? "正在接收新日志" : "日志流已暂停"}</span>
        <span>{logs.length} 条结果 · 采样率 100%</span>
      </footer>
    </div>
  );
}
