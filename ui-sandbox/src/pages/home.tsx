import { Activity, ArrowUpRight, CalendarClock, Cpu, LayoutTemplate, Sparkles, Workflow } from "lucide-react";
import { Sparkline } from "../components/sparkline";
import { PageHeader } from "../components/ui";
import type { PageId } from "../navigation";

export function HomePage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const quick = [
    {
      label: "编排工作流",
      detail: "组合智能体与业务节点",
      icon: Workflow,
      page: "workflow" as PageId,
    },
    {
      label: "接入模型",
      detail: "配置供应商和调用额度",
      icon: Cpu,
      page: "models" as PageId,
    },
    {
      label: "设置任务",
      detail: "按计划自动运行 Agent",
      icon: CalendarClock,
      page: "tasks" as PageId,
    },
    {
      label: "查看设计基线",
      detail: "浏览统一布局与组件模版",
      icon: LayoutTemplate,
      page: "templates" as PageId,
    },
  ];
  return (
    <div className="page-frame home-page">
      <PageHeader
        title="早上好，Pu Wang"
        description="工作区运行正常。这里汇总今天需要关注的智能体、任务和资源变化。"
      ></PageHeader>
      <section className="home-summary">
        <div className="home-summary__lead">
          <span>
            <Sparkles /> 今日工作区
          </span>
          <strong>18 个智能体正在为 4 个业务流提供服务</strong>
          <p>过去 24 小时完成 1,284 次执行，整体成功率 98.7%。</p>
        </div>
        <div className="home-summary__chart">
          <Sparkline values={[32, 38, 37, 51, 47, 62, 59, 74, 79, 88, 83, 94]} />
          <small>执行趋势 · 24h</small>
        </div>
      </section>
      <section className="metric-grid">
        <div className="panel metric">
          <span>运行中的实例</span>
          <strong>18</strong>
          <small>较昨日 +3</small>
        </div>
        <div className="panel metric">
          <span>今日调用</span>
          <strong>1,284</strong>
          <small>成功率 98.7%</small>
        </div>
        <div className="panel metric">
          <span>平均响应</span>
          <strong>4.8s</strong>
          <small>降低 0.6s</small>
        </div>
        <div className="panel metric">
          <span>待处理事项</span>
          <strong>5</strong>
          <small className="metric__warning">2 项需要确认</small>
        </div>
      </section>
      <div className="home-columns">
        <section className="panel">
          <header className="panel__header">
            <h3>快速开始</h3>
            <span className="panel-caption">常用入口</span>
          </header>
          <div className="quick-grid">
            {quick.map((item) => {
              const Icon = item.icon;
              return (
                <button type="button" key={item.label} onClick={() => onNavigate(item.page)}>
                  <span>
                    <Icon />
                  </span>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                  <ArrowUpRight />
                </button>
              );
            })}
          </div>
        </section>
        <section className="panel">
          <header className="panel__header">
            <h3>实时活动</h3>
            <button className="button button--ghost" type="button">
              查看全部
            </button>
          </header>
          <div className="activity-list">
            {[
              ["公文写手", "完成文档结构优化", "刚刚"],
              ["投标审查助手", "调用 Browser 检索 12 个来源", "8 分钟"],
              ["数据洞察", "定时任务执行成功", "23 分钟"],
              ["客户支持", "发布了新版本 v12", "1 小时"],
            ].map(([name, text, time]) => (
              <div className="activity-row" key={name}>
                <span className="activity-row__icon">
                  <Activity />
                </span>
                <span>
                  <strong>{name}</strong>
                  <small>{text}</small>
                </span>
                <time>{time}</time>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
