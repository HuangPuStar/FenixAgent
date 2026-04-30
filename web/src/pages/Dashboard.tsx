import { useState, useEffect, useCallback, useRef } from "react";
import {
  apiFetchEnvironments, apiFetchAllSessions, apiListAgents, apiGetModels,
  apiListSkills, apiListMcpServers, apiListTasks,
} from "../api/client";
import type { Environment, Session } from "../types";
import type { AgentInfo } from "../types/config";
import { useConfigChangeListener } from "../lib/config-events";
import {
  Cpu, Bot, Wrench, Plug, Clock, Activity, MessageSquare,
  Zap, ShieldCheck, Layers, Server, Radio, type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/utils";

/* ========================================================================== *
 *  useStats — 并行拉取所有概览数据
 * ========================================================================== */

interface StatsState {
  environments: Environment[];
  sessions: Session[];
  agents: AgentInfo[];
  models: { available: { fullId: string }[] } | null;
  skills: { name: string; enabled: boolean }[];
  mcpServers: { name: string; enabled: boolean }[];
  tasks: { id: string; enabled: boolean; lastStatus: string | null }[];
  loading: boolean;
}

function useStats() {
  const [state, setState] = useState<StatsState>({
    environments: [], sessions: [], agents: [],
    models: null, skills: [], mcpServers: [], tasks: [],
    loading: true,
  });
  const load = useCallback(async () => {
    const results = await Promise.allSettled([
      apiFetchEnvironments(), apiFetchAllSessions(), apiListAgents(),
      apiGetModels(), apiListSkills(), apiListMcpServers(), apiListTasks(),
    ]);
    setState({
      environments: results[0].status === "fulfilled" ? results[0].value ?? [] : [],
      sessions: results[1].status === "fulfilled" ? results[1].value ?? [] : [],
      agents: results[2].status === "fulfilled" ? results[2].value.agents : [],
      models: results[3].status === "fulfilled" ? results[3].value : null,
      skills: results[4].status === "fulfilled" ? results[4].value ?? [] : [],
      mcpServers: results[5].status === "fulfilled" ? results[5].value ?? [] : [],
      tasks: results[6].status === "fulfilled" ? results[6].value ?? [] : [],
      loading: false,
    });
  }, []);
  useEffect(() => { load(); }, [load]);

  // 监听配置变更事件（来自其他页面的保存/删除操作）
  useConfigChangeListener(() => { load(); }, [load]);

  // 页面重新获得焦点时刷新（用户从其他 tab 切回来）
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  return state;
}

/* ========================================================================== *
 *  useCountUp — 数字滚动动画 hook
 * ========================================================================== */

function useCountUp(target: number, duration = 800, enabled = true) {
  const [display, setDisplay] = useState(0);
  const raf = useRef<number>(0);
  const start = useRef<number>(0);

  useEffect(() => {
    if (!enabled || target === 0) { setDisplay(target); return; }
    const animate = (ts: number) => {
      if (!start.current) start.current = ts;
      const elapsed = ts - start.current;
      const progress = Math.min(elapsed / duration, 1);
      // easeOutCubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(eased * target));
      if (progress < 1) raf.current = requestAnimationFrame(animate);
    };
    raf.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf.current);
  }, [target, duration, enabled]);

  return display;
}

/* ========================================================================== *
 *  RingChart — 环形进度指示器
 * ========================================================================== */

interface RingChartProps {
  pct: number;         // 0-100
  size?: number;
  stroke?: number;
  color: string;
  trackColor: string;
  label: string;
  sub: string;
  icon?: LucideIcon;
}

function RingChart({ pct, size = 72, stroke = 6, color, trackColor, label, sub, icon: Icon }: RingChartProps) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ - (Math.min(pct, 100) / 100) * circ;
  const display = useCountUp(Math.round(pct), 1200);

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={trackColor} strokeWidth={stroke} />
          <circle
            cx={size / 2} cy={size / 2} r={r}
            fill="none" stroke={color} strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circ} strokeDashoffset={offset}
            style={{ transition: "stroke-dashoffset 1.2s cubic-bezier(0.4, 0, 0.2, 1)" }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          {Icon ? (
            <Icon className="h-4 w-4" style={{ color }} />
          ) : (
            <span className="text-xs font-mono font-bold" style={{ color }}>{display}%</span>
          )}
        </div>
      </div>
      <span className="text-[11px] font-medium text-text-primary">{label}</span>
      <span className="text-[10px] text-text-muted -mt-1">{sub}</span>
    </div>
  );
}

/* ========================================================================== *
 *  StatusDot — 脉冲状态点
 * ========================================================================== */

function StatusDot({ color, pulse = false }: { color: string; pulse?: boolean }) {
  return (
    <span className="relative inline-flex h-2 w-2">
      <span
        className={cn("absolute inset-0 rounded-full", color)}
      />
      {pulse && (
        <span
          className={cn("absolute inset-0 rounded-full animate-ping", color)}
          style={{ animationDuration: "2s" }}
        />
      )}
    </span>
  );
}

/* ========================================================================== *
 *  AnimatedKpiCard — 带动画的 KPI 卡片
 * ========================================================================== */

interface AnimatedKpiCardProps {
  icon: LucideIcon;
  label: string;
  value: number;
  suffix?: string;
  trend: string;
  accentColor: string;
  accentBg: string;
  sparkPath: string;
}

function AnimatedKpiCard({
  icon: Icon, label, value, suffix, trend, accentColor, accentBg, sparkPath,
}: AnimatedKpiCardProps) {
  const display = useCountUp(value, 900);

  return (
    <div className="dashboard-kpi-card group">
      {/* glow blob — top-right blurred circle */}
      <div className="dashboard-kpi-glow" style={{ background: accentColor }} />
      <div className="relative z-10 flex flex-col h-full">
        <div className="dashboard-kpi-header">
          <div className={cn("dashboard-kpi-icon", accentBg)} style={{ color: accentColor }}>
            <Icon className="h-[18px] w-[18px]" />
          </div>
          <span className="dashboard-kpi-trend">{trend}</span>
        </div>
        <div className="dashboard-kpi-value" style={{ color: accentColor }}>
          {display}{suffix ?? ""}
        </div>
        <div className="dashboard-kpi-label">
          {label}
        </div>
      </div>
      {/* sparkline SVG decoration */}
      <svg
        className="kpi-sparkline"
        viewBox="0 0 200 30"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d={sparkPath} fill="none" stroke={accentColor} strokeWidth="2" strokeLinecap="round" />
      </svg>
    </div>
  );
}

/* ========================================================================== *
 *  TopologyNode — 拓扑节点
 * ========================================================================== */

interface TopoNode {
  id: string;
  name: string;
  x: number;
  y: number;
  status: "active" | "idle" | "error" | "offline";
}

function statusColor(s: TopoNode["status"]) {
  switch (s) {
    case "active": return "#30b08f";
    case "idle": return "#6366F1";
    case "error": return "#c03639";
    case "offline": return "#909399";
  }
}

function statusLabel(s: TopoNode["status"]) {
  switch (s) {
    case "active": return "运行中";
    case "idle": return "空闲";
    case "error": return "异常";
    case "offline": return "离线";
  }
}

function AgentTopology({ agents }: { agents: TopoNode[] }) {
  const canvasW = 520; const canvasH = 180;
  const hubX = canvasW / 2; const hubY = 38;

  // position agents in a row below
  const maxShow = 6;
  const shown = agents.slice(0, maxShow);
  const gap = canvasW / (shown.length + 1);

  return (
    <svg
      viewBox={`0 0 ${canvasW} ${canvasH}`}
      className="w-full h-auto"
      style={{ maxHeight: 180 }}
    >
      <defs>
        {shown.map((a) => (
          <linearGradient key={a.id} id={`topoLine-${a.id}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={statusColor("active")} stopOpacity="0.6" />
            <stop offset="100%" stopColor={statusColor(a.status)} stopOpacity="0.3" />
          </linearGradient>
        ))}
        <filter id="topoShadow">
          <feDropShadow dx="0" dy="2" stdDeviation="4" floodOpacity="0.08" />
        </filter>
      </defs>

      {/* Hub */}
      <rect
        x={hubX - 48} y={hubY - 14} width={96} height={30} rx={8}
        fill="var(--color-surface-1)" stroke="#6366F1" strokeWidth="2"
        filter="url(#topoShadow)"
      />
      <text x={hubX} y={hubY + 6} textAnchor="middle" fill="var(--color-text-primary)" fontFamily="Inter, sans-serif" fontSize="13" fontWeight="700">
        RCS Hub
      </text>
      {/* Hub pulse ring */}
      <circle cx={hubX} cy={hubY + 1} r="4" fill="#6366F1">
        <animate attributeName="r" values="4;12;4" dur="2s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;0;0.5" dur="2s" repeatCount="indefinite" />
      </circle>

      {/* Connection lines + data particles */}
      {shown.map((a, i) => {
        const nx = gap * (i + 1);
        const ny = 130;
        const midY = (hubY + 20 + ny) / 2;

        return (
          <g key={a.id}>
            <line
              x1={hubX} y1={hubY + 20} x2={nx} y2={ny}
              stroke={statusColor(a.status)} strokeOpacity="0.25" strokeWidth="1.5"
              strokeDasharray={a.status === "offline" ? "4,4" : undefined}
            />
            {/* data particles */}
            {a.status !== "offline" && (
              <>
                <circle r="2.5" fill={statusColor(a.status)} opacity="0.6">
                  <animateMotion dur={`${2 + i * 0.5}s`} repeatCount="indefinite" path={`M${hubX},${hubY + 20} L${nx},${ny}`} />
                </circle>
                <circle r="1.5" fill="#22D3EE" opacity="0.4">
                  <animateMotion dur={`${2.5 + i * 0.3}s`} repeatCount="indefinite" path={`M${hubX},${hubY + 20} L${nx},${ny}`} begin="0.8s" />
                </circle>
              </>
            )}
          </g>
        );
      })}

      {/* Agent nodes */}
      {shown.map((a, i) => {
        const nx = gap * (i + 1);
        const ny = 130;
        const sc = statusColor(a.status);

        return (
          <g key={a.id}>
            {/* Node rect */}
            <rect
              x={nx - 52} y={ny - 2} width={104} height={44} rx={10}
              fill="var(--color-surface-1)" stroke={sc} strokeWidth="1.5"
              filter="url(#topoShadow)"
            />
            {a.status === "active" && (
              <rect
                x={nx - 52} y={ny - 2} width={104} height={44} rx={10}
                fill="none" stroke={sc} strokeWidth="1.5"
                style={{ animation: "glowBreathe 3s ease-in-out infinite" }}
              />
            )}
            {/* LED dot */}
            <circle cx={nx - 36} cy={ny + 20} r="4.5" fill={sc} />
            {a.status === "active" && (
              <circle cx={nx - 36} cy={ny + 20} r="4.5" fill={sc} opacity="0.3">
                <animate attributeName="r" values="4.5;8;4.5" dur="2s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.3;0;0.3" dur="2s" repeatCount="indefinite" />
              </circle>
            )}
            {/* Name + Status */}
            <text x={nx} y={ny + 14} textAnchor="middle" fill="var(--color-text-primary)" fontFamily="Inter, sans-serif" fontSize="11.5" fontWeight="600">
              {a.name.length > 12 ? a.name.slice(0, 12) + "…" : a.name}
            </text>
            <text x={nx} y={ny + 30} textAnchor="middle" fill={sc} fontSize="10">
              ● {statusLabel(a.status)}
            </text>
          </g>
        );
      })}

      {/* +N indicator */}
      {agents.length > maxShow && (
        <text x={canvasW - 30} y={canvasH - 12} fill="var(--color-text-muted)" fontSize="11">
          +{agents.length - maxShow} 更多
        </text>
      )}
    </svg>
  );
}

/* ========================================================================== *
 *  TimelineItem
 * ========================================================================== */

function TimelineItem({
  dotColor, title, time,
}: {
  dotColor: string; title: string; time: string;
}) {
  return (
    <div className="dashboard-timeline-item">
      <div className="flex items-center gap-3">
        <span className={cn("dashboard-timeline-dot", dotColor)} />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] text-text-primary truncate">{title}</div>
          <div className="text-[10px] text-text-muted mt-0.5">{time}</div>
        </div>
      </div>
    </div>
  );
}

/* ========================================================================== *
 *  Dashboard — 主组件
 * ========================================================================== */

export function Dashboard() {
  const stats = useStats();

  if (stats.loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
          <div className="text-sm text-text-muted">加载系统概览...</div>
        </div>
      </div>
    );
  }

  // --- 统计数据 ---
  const activeEnvs = stats.environments.filter(
    (e) => e.instance_status === "running" || e.instance_status === "starting",
  );
  const activeSessions = stats.sessions.filter(
    (s) => s.status === "active" || s.status === "running",
  );
  const offlineEnvs = stats.environments.filter(
    (e) => !["running", "starting"].includes(e.instance_status ?? ""),
  );
  const enabledSkills = stats.skills.filter((s) => s.enabled);
  const enabledMcp = stats.mcpServers.filter((m) => m.enabled);
  const enabledTasks = stats.tasks.filter((t) => t.enabled);
  const modelCount = stats.models?.available?.length ?? 0;
  const totalConfigItems = stats.agents.length + stats.skills.length + stats.mcpServers.length;
  const enabledConfigItems = enabledSkills.length + enabledMcp.length + stats.agents.filter(a => a.enabled !== false).length;
  const healthPct = totalConfigItems > 0 ? Math.round((enabledConfigItems / totalConfigItems) * 95 + 5) : 100;

  // --- 拓扑数据 ---
  const topoNodes: TopoNode[] = stats.environments.map((e) => {
    const isActive = e.instance_status === "running" || e.instance_status === "starting";
    const isError = e.instance_status === "error";
    return {
      id: e.id,
      name: e.name || e.agent_name || e.id.slice(0, 8),
      x: 0, y: 0,
      status: isActive ? "active" : isError ? "error" : "offline",
    } satisfies TopoNode;
  });

  // --- 模拟活动事件 ---
  const timeline = buildTimeline(stats);

  // --- Sparkline 数据 (模拟用于展示) ---
  const sparkAgents = generateSparkData(activeEnvs.length, stats.environments.length);
  const sparkSessions = generateSparkData(activeSessions.length, stats.sessions.length);
  const sparkModels = generateSparkData(modelCount, modelCount);
  const sparkTasks = generateSparkData(enabledTasks.length, stats.tasks.length);
  const sparkHealth = generateSparkData(healthPct / 100, healthPct / 100, 0.7, 1);

  return (
    <div className="h-full overflow-y-auto dashboard-page">
      <div className="mx-auto max-w-6xl px-6 py-6 space-y-5">

        {/* ================================================================ *
         *  SECTION 1 — 页面标题行
         * ================================================================ */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-text-primary">系统概览</h1>
            <p className="text-[12px] text-text-muted mt-0.5">
              实时监控 AI Agent 控制面板运行状态
            </p>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-text-muted">
            <StatusDot color="bg-status-active" pulse />
            <span>系统运行中</span>
          </div>
        </div>

        {/* ================================================================ *
         *  SECTION 2 — KPI 卡片条 (5 列)
         * ================================================================ */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 stagger-animate">
          <AnimatedKpiCard
            icon={Bot} label="智能体" value={stats.environments.length}
            trend={`${activeEnvs.length} 活跃`}
            accentColor="#6366F1" accentBg="dashboard-kpi-icon-brand"
            sparkPath="M0,22 C20,22 30,18 50,18 C70,18 80,14 100,14 C120,14 130,8 150,8 C170,8 180,12 200,10"
          />
          <AnimatedKpiCard
            icon={MessageSquare} label="会话" value={stats.sessions.length}
            trend={`${activeSessions.length} 进行中`}
            accentColor="#22D3EE" accentBg="dashboard-kpi-icon-cyan"
            sparkPath="M0,16 C30,16 45,12 60,12 C75,12 90,18 105,18 C120,18 135,10 150,10 C165,10 185,14 200,8"
          />
          <AnimatedKpiCard
            icon={Cpu} label="模型" value={modelCount}
            trend="已配置"
            accentColor="#818CF8" accentBg="dashboard-kpi-icon-purple"
            sparkPath="M0,10 C20,10 35,14 50,14 C65,14 80,8 95,8 C110,8 130,12 150,12 C170,12 185,6 200,8"
          />
          <AnimatedKpiCard
            icon={ShieldCheck} label="可用率" value={healthPct}
            suffix="%"
            trend="健康"
            accentColor="#10B981" accentBg="dashboard-kpi-icon-green"
            sparkPath="M0,6 C25,6 40,4 60,4 C80,4 95,8 115,8 C135,8 155,4 175,4 C190,4 200,6 200,6"
          />
          <AnimatedKpiCard
            icon={Clock} label="定时任务" value={stats.tasks.length}
            trend={`${enabledTasks.length} 启用`}
            accentColor="#F59E0B" accentBg="dashboard-kpi-icon-amber"
            sparkPath="M0,20 C30,20 50,16 70,16 C90,16 110,14 130,14 C150,14 165,10 185,10 C195,10 200,12 200,12"
          />
        </div>

        {/* ================================================================ *
         *  SECTION 3 — 三栏布局：健康环 | 拓扑 | 活动
         * ================================================================ */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

          {/* --- 系统健康环 --- */}
          <div className="rounded-xl border border-border bg-surface-1 p-5 flex flex-col">
            <div className="flex items-center gap-2 mb-4">
              <ShieldCheck className="h-4 w-4 text-brand" />
              <span className="text-xs font-semibold uppercase tracking-wider text-text-dim">
                系统健康度
              </span>
            </div>
            <div className="flex flex-wrap justify-center gap-4 flex-1 items-center">
              <RingChart
                pct={activeEnvs.length > 0 ? Math.round((activeEnvs.length / Math.max(stats.environments.length, 1)) * 100) : 0}
                color="#6366F1" trackColor="var(--color-surface-2)"
                label="智能体在线" sub={`${activeEnvs.length}/${stats.environments.length}`}
                icon={Server}
              />
              <RingChart
                pct={stats.sessions.length > 0 ? Math.round((activeSessions.length / Math.max(stats.sessions.length, 1)) * 100) : 0}
                color="#30b08f" trackColor="var(--color-surface-2)"
                label="会话活跃" sub={`${activeSessions.length}/${stats.sessions.length}`}
                icon={MessageSquare}
              />
              <RingChart
                pct={healthPct}
                color="#e65d6e" trackColor="var(--color-surface-2)"
                label="配置启用率" sub={`${enabledConfigItems}/${totalConfigItems}`}
                icon={Zap}
              />
            </div>
          </div>

          {/* --- Agent 拓扑 --- */}
          <div className="rounded-xl border border-border bg-surface-1 p-5 flex flex-col lg:col-span-2">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Radio className="h-4 w-4 text-status-active" />
                <span className="text-xs font-semibold uppercase tracking-wider text-text-dim">
                  Agent 拓扑
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
                <StatusDot color="bg-status-active" pulse />
                <span>{topoNodes.filter(n => n.status === "active").length} 在线</span>
                <span className="mx-1 text-border">|</span>
                <StatusDot color="bg-gray-400" />
                <span>{topoNodes.filter(n => n.status === "offline").length} 离线</span>
              </div>
            </div>
            <div className="flex-1 flex items-center justify-center min-h-[180px]">
              {topoNodes.length > 0 ? (
                <AgentTopology agents={topoNodes} />
              ) : (
                <div className="text-sm text-text-muted">
                  暂无智能体 — 前往<span className="text-brand font-medium">智能体</span>页面创建
                </div>
              )}
            </div>
          </div>

        </div>

        {/* ================================================================ *
         *  SECTION 4 — 双栏：活动时间线 | 快速统计
         * ================================================================ */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

          {/* --- 活动时间线 --- */}
          <div className="rounded-xl border border-border bg-surface-1 p-5 lg:col-span-2">
            <div className="flex items-center gap-2 mb-3">
              <Activity className="h-4 w-4 text-status-warning" />
              <span className="text-xs font-semibold uppercase tracking-wider text-text-dim">
                最近活动
              </span>
            </div>
            <div className="space-y-2">
              {timeline.length > 0 ? (
                timeline.map((item, i) => (
                  <TimelineItem
                    key={i}
                    dotColor={item.dotColor}
                    title={item.title}
                    time={item.time}
                  />
                ))
              ) : (
                <div className="text-sm text-text-muted py-2">暂无近期活动</div>
              )}
            </div>
          </div>

          {/* --- 快速统计 --- */}
          <div className="rounded-xl border border-border bg-surface-1 p-5">
            <div className="flex items-center gap-2 mb-3">
              <Wrench className="h-4 w-4 text-text-dim" />
              <span className="text-xs font-semibold uppercase tracking-wider text-text-dim">
                快速统计
              </span>
            </div>
            <div className="space-y-3">
              <QuickStatRow label="Agent 配置" count={stats.agents.length} />
              <QuickStatRow
                label="Skills"
                count={enabledSkills.length}
                total={stats.skills.length}
              />
              <QuickStatRow
                label="MCP 服务器"
                count={enabledMcp.length}
                total={stats.mcpServers.length}
              />
              <QuickStatRow label="会话归档" count={stats.sessions.filter(s => s.status === "archived" || s.status === "complete").length} />
              <QuickStatRow
                label="定时任务"
                count={enabledTasks.length}
                total={stats.tasks.length}
              />
            </div>
          </div>

        </div>

      </div>
    </div>
  );
}

/* ========================================================================== *
 *  QuickStatRow
 * ========================================================================== */

function QuickStatRow({ label, count, total }: { label: string; count: number; total?: number }) {
  return (
    <div className="flex items-center justify-between text-[13px]">
      <span className="text-text-secondary">{label}</span>
      <span className="font-mono font-semibold text-text-primary">
        {total !== undefined ? (
          <>
            <span className="text-status-active">{count}</span>
            <span className="text-text-muted"> / {total}</span>
          </>
        ) : (
          count
        )}
      </span>
    </div>
  );
}

/* ========================================================================== *
 *  工具函数
 * ========================================================================== */

/** 生成模拟 sparkline 数据 (8 个归一化点) */
function generateSparkData(active: number, total: number, min = 0.1, max = 1): number[] {
  const ratio = total > 0 ? active / total : 0;
  const points: number[] = [];
  for (let i = 0; i < 8; i++) {
    const t = i / 7;
    const noise = (Math.sin(t * Math.PI * 2) * 0.12 + Math.cos(t * Math.PI * 3) * 0.08);
    const base = min + ratio * (max - min);
    const val = base + noise * (1 - ratio);
    points.push(Math.max(0.05, Math.min(1, val)));
  }
  return points;
}

function buildTimeline(stats: StatsState) {
  const items: { dotColor: string; title: string; time: string }[] = [];

  const activeEnvs = stats.environments.filter(
    e => e.instance_status === "running" || e.instance_status === "starting",
  );
  const activeSessions = stats.sessions.filter(
    s => s.status === "active" || s.status === "running",
  );

  if (activeEnvs.length > 0) {
    items.push({
      dotColor: "bg-status-active",
      title: `${activeEnvs.length} 个智能体处于活跃状态`,
      time: "现在",
    });
  }
  if (activeSessions.length > 0) {
    items.push({
      dotColor: "bg-status-running",
      title: `${activeSessions.length} 个会话进行中`,
      time: "现在",
    });
  }
  if (stats.tasks.length > 0) {
    items.push({
      dotColor: "bg-status-warning",
      title: `${stats.tasks.length} 个定时任务已注册`,
      time: "系统",
    });
  }
  if (stats.models?.available?.length) {
    items.push({
      dotColor: "bg-violet-500",
      title: `${stats.models.available.length} 个模型可用`,
      time: "配置",
    });
  }
  if (items.length === 0) {
    items.push({
      dotColor: "bg-gray-400",
      title: "系统刚启动，暂无活动记录",
      time: "现在",
    });
  }

  return items;
}
