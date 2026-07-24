import { useRequest } from "ahooks";
import { Bot, CheckCircle2, FileText, RefreshCw, XCircle, Zap } from "lucide-react";
import { type DashboardData, dashboardApi } from "@/src/api/dashboard";
import { unwrap } from "@/src/api/request";

type SparkBar = { value: number; active?: boolean };

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
function timeAgo(d: string): string {
  const diff = Date.now() - new Date(d).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时前`;
  const days = Math.floor(h / 24);
  return days < 7 ? `${days}天前` : new Date(d).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function SparkBars({ bars, inverse }: { bars: SparkBar[]; inverse?: boolean }) {
  const max = Math.max(...bars.map((b) => b.value), 1);
  return (
    <div className="dashboard-spark-bars" aria-hidden="true">
      {bars.map((bar) => (
        <span
          className={bar.active ? "is-active" : ""}
          key={bar.value}
          style={{
            height: `${Math.max(18, (bar.value / max) * 52)}px`,
            background: inverse && !bar.active ? "rgba(255,255,255,0.2)" : undefined,
          }}
        />
      ))}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="dashboard-section-title">
      <span />
      {children}
    </h2>
  );
}

function DocStatusBadge({ status }: { status: string }) {
  const m: Record<string, { label: string; cls: string }> = {
    ready: { label: "已完成", cls: "dashboard-doc-status--done" },
    completed: { label: "已完成", cls: "dashboard-doc-status--done" },
    error: { label: "解析失败", cls: "dashboard-doc-status--failed" },
    failed: { label: "解析失败", cls: "dashboard-doc-status--failed" },
    processing: { label: "处理中", cls: "dashboard-doc-status--processing" },
    pending: { label: "处理中", cls: "dashboard-doc-status--processing" },
  };
  const i = m[status] ?? m.pending;
  return <span className={`dashboard-doc-status ${i.cls}`}>{i.label}</span>;
}

function ActivityIcon({ type }: { type: string }) {
  if (type === "agent") return <Bot className="h-3.5 w-3.5 text-blue-500 shrink-0" />;
  if (type === "knowledge") return <FileText className="h-3.5 w-3.5 text-amber-500 shrink-0" />;
  return <Zap className="h-3.5 w-3.5 text-violet-500 shrink-0" />;
}

function DocIcon({ status }: { status: string }) {
  if (status === "ready" || status === "completed")
    return <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />;
  if (status === "error" || status === "failed") return <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />;
  return <RefreshCw className="h-3.5 w-3.5 text-blue-500 shrink-0 animate-spin" />;
}

export function DashboardPage() {
  const { data, loading } = useRequest(async () => unwrap(dashboardApi.overview()));
  const d = data as DashboardData | undefined;

  const agentBars: SparkBar[] =
    d?.agentStats.trend.map((t: { count: number }, i: number, arr: Array<{ count: number }>) => ({
      value: t.count,
      active: i === arr.length - 1,
    })) ?? [];

  const convBars: SparkBar[] =
    d?.conversationStats.trend.map((t: { count: number }, i: number, arr: Array<{ count: number }>) => ({
      value: t.count,
      active: i === arr.length - 1,
    })) ?? [];

  if (loading) {
    return (
      <div className="dashboard-page">
        <div className="flex items-center justify-center h-full">
          <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-page">
      <header className="dashboard-header">
        <h1>平台概览</h1>
        <button type="button" className="dashboard-refresh-btn">
          <RefreshCw size={16} />
          刷新数据
        </button>
      </header>

      <main className="dashboard-grid">
        <section className="dashboard-main">
          <div className="dashboard-top-grid">
            <article className="dashboard-card dashboard-card--primary">
              <p className="dashboard-label">智能体总数</p>
              <strong>{d?.agentStats.agentCount ?? "-"}</strong>
              <p className="dashboard-muted dashboard-primary-stats">
                <span>运行 {d?.agentStats.running ?? "-"}</span>
                <span>停止 {d?.agentStats.stopped ?? "-"}</span>
              </p>
              {agentBars.length > 0 && <SparkBars bars={agentBars} inverse />}
              <p className="dashboard-muted">近日新增趋势</p>
            </article>

            <article className="dashboard-card">
              <p className="dashboard-label">总对话次数</p>
              <div className="dashboard-value-row">
                <strong>{d?.conversationStats ? fmtNum(d.conversationStats.totalConversations) : "-"}</strong>
                <span>次</span>
              </div>
              <p className="dashboard-muted">
                今日 <b>{d?.conversationStats.todayCount ?? "-"}</b> 次
                {d?.conversationStats && d.conversationStats.dayChange !== 0 && (
                  <em className={d.conversationStats.dayChange > 0 ? "dashboard-up" : "dashboard-down"}>
                    {d.conversationStats.dayChange > 0 ? "↑" : "↓"} {Math.abs(d.conversationStats.dayChange)}%
                  </em>
                )}
              </p>
              {convBars.length > 0 && <SparkBars bars={convBars} />}
              <p className="dashboard-muted">7日对话趋势</p>
            </article>

            <article className="dashboard-card">
              <p className="dashboard-label">活跃用户数</p>
              <div className="dashboard-value-row">
                <strong>{d?.activeUserStats.activeUsers ?? "-"}</strong>
                <span>人</span>
              </div>
              <p className="dashboard-muted">近7天有对话行为的独立用户</p>
              {(d?.activeUserStats.recentUsers ?? []).length > 0 && (
                <div className="dashboard-avatar-stack">
                  {d!.activeUserStats.recentUsers.slice(0, 7).map((u) => (
                    <span key={u.userId} title={u.name}>
                      {u.name.charAt(0)}
                    </span>
                  ))}
                  {d!.activeUserStats.activeUsers > 7 && <i>+{d!.activeUserStats.activeUsers - 7}</i>}
                </div>
              )}
            </article>
          </div>

          <section className="dashboard-card dashboard-activity-card">
            <div className="dashboard-panel-head">
              <SectionTitle>最近动态</SectionTitle>
              <button type="button">查看全部 →</button>
            </div>
            <div className="dashboard-activity-list">
              {(d?.recentActivities ?? []).map((activity) => (
                <article className="dashboard-activity-item" key={activity.id}>
                  <div className="dashboard-activity-icon">
                    <ActivityIcon type={activity.type} />
                  </div>
                  <div>
                    <h3>{activity.title}</h3>
                    <p>{activity.content}</p>
                  </div>
                  <time>{timeAgo(activity.createdAt)}</time>
                </article>
              ))}
            </div>
          </section>
        </section>

        <aside className="dashboard-side">
          <article className="dashboard-card dashboard-doc-metric">
            <p className="dashboard-label">知识库文档数</p>
            <div className="dashboard-value-row">
              <strong>{d?.docStats.totalDocs ?? "-"}</strong>
              <span>份</span>
            </div>
            <p className="dashboard-muted">
              向量化完成 <b>{d?.docStats.vectorized ?? "-"}</b> 份
            </p>
            <div className="dashboard-ring-row">
              <div
                className="dashboard-ring"
                style={{
                  background: `conic-gradient(#1d7df4 0 ${d?.docStats.vectorizedRate ?? 0}%, #e7edf7 ${d?.docStats.vectorizedRate ?? 0}% 100%)`,
                }}
              />
              <div>
                <strong>{d?.docStats.vectorizedRate ?? "-"}%</strong>
                <span>向量化完成</span>
              </div>
            </div>
          </article>

          <article className="dashboard-card dashboard-side-panel">
            <SectionTitle>热门智能体 TOP5</SectionTitle>
            <div className="dashboard-top-list">
              {(d?.topAgents ?? []).map((agent, index) => (
                <div className="dashboard-top-item" key={agent.agentId}>
                  <span className={index < 3 ? "is-hot" : ""}>{index + 1}</span>
                  <div>
                    <strong>{agent.agentName}</strong>
                    <p>{agent.count} 次对话</p>
                  </div>
                  <i>
                    <b style={{ width: `${agent.ratio}%` }} />
                  </i>
                </div>
              ))}
            </div>
          </article>

          <article className="dashboard-card dashboard-side-panel">
            <SectionTitle>最近上传文档</SectionTitle>
            <div className="dashboard-doc-list">
              {(d?.recentDocuments ?? []).map((doc) => (
                <div className="dashboard-doc-item" key={doc.id}>
                  <DocIcon status={doc.status} />
                  <strong>{doc.sourceName}</strong>
                  <span>{doc.kbName}</span>
                  <DocStatusBadge status={doc.status} />
                </div>
              ))}
            </div>
          </article>
        </aside>
      </main>

      <style>{`
        .dashboard-page {
          flex: 1;
          min-height: 100%;
          overflow: auto;
          background: #eef4ff;
          padding: 22px 30px 34px;
          color: #11182f;
          font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }

        .dashboard-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          margin-bottom: 22px;
        }

        .dashboard-header h1 {
          margin: 0;
          font-size: 24px;
          font-weight: 800;
          letter-spacing: 0;
        }

        .dashboard-refresh-btn {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          min-height: 40px;
          padding: 0 16px;
          border: 0;
          border-radius: 8px;
          background: #fff;
          color: #6b778d;
          font-size: 14px;
          cursor: pointer;
          box-shadow: 0 1px 2px rgba(30, 60, 120, 0.05);
        }

        .dashboard-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 390px;
          gap: 22px;
          align-items: start;
        }

        .dashboard-main,
        .dashboard-side {
          display: grid;
          gap: 22px;
        }

        .dashboard-top-grid {
          display: grid;
          grid-template-columns: 1fr 1fr 0.82fr;
          gap: 22px;
        }

        .dashboard-mid-grid {
          display: grid;
          grid-template-columns: 1fr;
        }

        .dashboard-card {
          border-radius: 8px;
          background: #fff;
          padding: 24px 26px;
          box-shadow: 0 2px 8px rgba(31, 61, 122, 0.08);
        }

        .dashboard-card--primary {
          min-height: 220px;
          background: #2584f8;
          color: #fff;
        }

        .dashboard-label {
          margin: 0 0 12px;
          color: #6f7f95;
          font-size: 15px;
          font-weight: 600;
        }

        .dashboard-card--primary .dashboard-label,
        .dashboard-card--primary .dashboard-muted {
          color: rgba(255, 255, 255, 0.76);
        }

        .dashboard-card strong {
          display: inline-block;
          font-size: 32px;
          line-height: 1.1;
          font-weight: 800;
          letter-spacing: 0;
        }

        .dashboard-muted {
          margin: 8px 0 0;
          color: #768399;
          font-size: 14px;
          line-height: 1.5;
        }

        .dashboard-muted b {
          color: inherit;
          font-weight: 800;
        }

        .dashboard-primary-stats {
          display: flex;
          gap: 9px;
          font-weight: 700;
        }

        .dashboard-value-row {
          display: flex;
          align-items: baseline;
          gap: 8px;
        }

        .dashboard-value-row span {
          color: #77849a;
          font-size: 15px;
          font-weight: 700;
        }

        .dashboard-up,
        .dashboard-down {
          display: inline-flex;
          align-items: center;
          margin-left: 8px;
          border-radius: 5px;
          padding: 2px 8px;
          font-style: normal;
          font-weight: 800;
        }

        .dashboard-up {
          background: #e6ffd9;
          color: #56c224;
        }

        .dashboard-down {
          background: #fff1ef;
          color: #ff6a6a;
        }

        .dashboard-spark-bars {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          align-items: end;
          gap: 5px;
          height: 58px;
          margin-top: 28px;
        }

        .dashboard-spark-bars span {
          display: block;
          border-radius: 3px 3px 0 0;
          background: #6aa8f8;
        }

        .dashboard-spark-bars .is-active {
          background: #1979f4;
        }

        .dashboard-card--primary .dashboard-spark-bars .is-active {
          background: rgba(255, 255, 255, 0.86);
        }

        .dashboard-avatar-stack {
          display: flex;
          align-items: center;
          margin-top: 20px;
        }

        .dashboard-avatar-stack span,
        .dashboard-avatar-stack i {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          margin-left: -5px;
          border: 2px solid #fff;
          border-radius: 999px;
          background: #2b86f6;
          color: #fff;
          font-size: 13px;
          font-style: normal;
          font-weight: 800;
        }

        .dashboard-avatar-stack span:first-child {
          margin-left: 0;
        }

        .dashboard-avatar-stack i {
          background: #eef1f5;
          color: #7d8796;
          font-size: 11px;
        }

        .dashboard-half {
          display: grid;
          grid-template-columns: 1fr 1px 1fr;
          gap: 34px;
          align-items: stretch;
        }

        .dashboard-divider {
          background: #e8edf5;
        }

        .dashboard-latency {
          display: flex;
          gap: 34px;
          margin-top: 22px;
        }

        .dashboard-latency span {
          color: #7c8798;
          font-size: 13px;
          font-weight: 700;
        }

        .dashboard-latency b {
          display: block;
          margin-top: 5px;
          font-size: 17px;
          font-weight: 800;
        }

        .dashboard-latency .green {
          color: #55c515;
        }

        .dashboard-latency .orange {
          color: #ff9a1f;
        }

        .dashboard-latency .red {
          color: #ff5a68;
        }

        .dashboard-panel-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          margin-bottom: 22px;
        }

        .dashboard-panel-head button {
          border: 0;
          background: transparent;
          color: #7b8798;
          font-size: 13px;
          cursor: pointer;
        }

        .dashboard-section-title {
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 0;
          color: #11182f;
          font-size: 17px;
          font-weight: 800;
        }

        .dashboard-section-title span {
          width: 9px;
          height: 9px;
          border-radius: 999px;
          background: #1e82ff;
        }

        .dashboard-activity-card {
          max-height: 500px;
          overflow-y: auto;
        }

        .dashboard-activity-list {
          display: grid;
        }

        .dashboard-activity-item {
          display: grid;
          grid-template-columns: 44px minmax(0, 1fr) auto;
          gap: 18px;
          align-items: center;
          padding: 17px 0;
          border-bottom: 1px solid #edf1f7;
        }

        .dashboard-activity-item:last-child {
          border-bottom: 0;
        }

        .dashboard-activity-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 42px;
          height: 42px;
          border-radius: 8px;
          font-size: 18px;
          font-weight: 800;
        }

        .dashboard-activity-icon--blue {
          background: #e4f3ff;
          color: #2887f5;
        }

        .dashboard-activity-icon--green {
          background: #f0ffe8;
          color: #62bd27;
        }

        .dashboard-activity-icon--amber {
          background: #fff6df;
          color: #65328b;
        }

        .dashboard-activity-icon--rose {
          background: #fff0ec;
          color: #ff8b2a;
        }

        .dashboard-activity-icon--violet {
          background: #f7ebff;
          color: #8a55dc;
        }

        .dashboard-activity-item h3 {
          margin: 0 0 5px;
          color: #1a2438;
          font-size: 15px;
          font-weight: 800;
        }

        .dashboard-activity-item p {
          margin: 0;
          color: #66748b;
          font-size: 14px;
          line-height: 1.45;
        }

        .dashboard-activity-item time {
          color: #a1a8b4;
          font-size: 13px;
          white-space: nowrap;
        }

        .dashboard-doc-metric {
          min-height: 220px;
        }

        .dashboard-ring-row {
          display: flex;
          align-items: center;
          gap: 22px;
          margin-top: 22px;
        }

        .dashboard-ring {
          width: 72px;
          height: 72px;
          border-radius: 999px;
          background: conic-gradient(#1d7df4 0 85%, #e7edf7 85% 100%);
          position: relative;
        }

        .dashboard-ring::after {
          content: "";
          position: absolute;
          inset: 9px;
          border-radius: inherit;
          background: #fff;
        }

        .dashboard-ring-row strong {
          display: block;
          font-size: 28px;
        }

        .dashboard-ring-row span {
          display: block;
          margin-top: 3px;
          color: #738096;
          font-size: 14px;
        }

        .dashboard-side-panel {
          padding-top: 26px;
        }

        .dashboard-top-list {
          display: grid;
          gap: 0;
          margin-top: 22px;
        }

        .dashboard-top-item {
          display: grid;
          grid-template-columns: 28px minmax(0, 1fr) 92px;
          gap: 14px;
          align-items: center;
          padding: 14px 0;
          border-bottom: 1px solid #edf1f7;
        }

        .dashboard-top-item:last-child {
          border-bottom: 0;
        }

        .dashboard-top-item > span {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 26px;
          height: 26px;
          border-radius: 7px;
          background: #f0f2f4;
          color: #7e8795;
          font-size: 13px;
          font-weight: 800;
        }

        .dashboard-top-item > span.is-hot {
          background: #1f82f9;
          color: #fff;
        }

        .dashboard-top-item strong {
          display: block;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 15px;
          font-weight: 800;
        }

        .dashboard-top-item p {
          margin: 4px 0 0;
          color: #768399;
          font-size: 13px;
        }

        .dashboard-top-item i {
          display: block;
          height: 6px;
          border-radius: 999px;
          background: #eef1f4;
          overflow: hidden;
        }

        .dashboard-top-item i b {
          display: block;
          height: 100%;
          border-radius: inherit;
          background: #167bfa;
        }

        .dashboard-doc-list {
          display: grid;
          gap: 0;
          margin-top: 24px;
        }

        .dashboard-doc-item {
          display: grid;
          grid-template-columns: 20px minmax(0, 1fr) auto auto;
          gap: 10px;
          align-items: center;
          padding: 13px 0;
          border-bottom: 1px solid #edf1f7;
        }

        .dashboard-doc-item:last-child {
          border-bottom: 0;
        }

        .dashboard-doc-item svg {
          color: #d9d3e8;
        }

        .dashboard-doc-item strong {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 14px;
          font-weight: 800;
        }

        .dashboard-doc-item > span:not(.dashboard-doc-status) {
          color: #8994a5;
          font-size: 12px;
          white-space: nowrap;
        }

        .dashboard-doc-status {
          border-radius: 5px;
          padding: 3px 7px;
          font-size: 12px;
          font-weight: 800;
          white-space: nowrap;
        }

        .dashboard-doc-status--done {
          background: #efffe6;
          color: #56c224;
        }

        .dashboard-doc-status--processing {
          background: #fff5df;
          color: #ff9a1f;
        }

        .dashboard-doc-status--failed {
          background: #fff0ee;
          color: #ff6868;
        }

        @media (max-width: 1280px) {
          .dashboard-grid {
            grid-template-columns: 1fr;
          }

          .dashboard-side {
            grid-template-columns: repeat(3, minmax(0, 1fr));
          }
        }

        @media (max-width: 980px) {
          .dashboard-page {
            padding: 18px;
          }

          .dashboard-top-grid,
          .dashboard-side {
            grid-template-columns: 1fr;
          }

          .dashboard-half {
            grid-template-columns: 1fr;
          }

          .dashboard-divider {
            height: 1px;
          }

          .dashboard-activity-card {
            min-height: auto;
          }
        }

        @media (max-width: 640px) {
          .dashboard-header {
            align-items: flex-start;
            flex-direction: column;
          }

          .dashboard-card {
            padding: 20px;
          }

          .dashboard-activity-item {
            grid-template-columns: 42px minmax(0, 1fr);
          }

          .dashboard-activity-item time {
            grid-column: 2;
          }

          .dashboard-doc-item {
            grid-template-columns: 20px minmax(0, 1fr) auto;
          }

          .dashboard-doc-status {
            grid-column: 2;
            justify-self: start;
          }
        }
      `}</style>
    </div>
  );
}
