import {
  Activity,
  Bot,
  Clock,
  Cpu,
  type LucideIcon,
  MessageSquare,
  Radio,
  Server,
  ShieldCheck,
  Wrench,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { agentApi, envApi, mcpApi, modelApi, sessionApi, skillConfigApi, taskApi } from "@/src/api/sdk";
import { useConfigChangeListener } from "../lib/config-events";
import { cn } from "../lib/utils";
import type { Environment, Session } from "../types";
import type { AgentInfo } from "../types/config";

/* ========================================================================== *
 *  useStats — parallel fetch all dashboard data
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
    environments: [],
    sessions: [],
    agents: [],
    models: null,
    skills: [],
    mcpServers: [],
    tasks: [],
    loading: true,
  });
  const load = useCallback(async () => {
    const results = await Promise.allSettled([
      envApi.list().then(({ data }) => (Array.isArray(data) ? (data as Environment[]) : [])),
      sessionApi.list().then(({ data }) => (Array.isArray(data) ? (data as Session[]) : [])),
      agentApi.list().then(({ data }) => {
        const agents = (data as unknown as Record<string, unknown>)?.agents;
        return Array.isArray(agents) ? (agents as AgentInfo[]) : [];
      }),
      modelApi.get().then(({ data }) => data ?? null),
      skillConfigApi.list().then(({ data }) => {
        const skills = (data as unknown as Record<string, unknown>)?.skills;
        return Array.isArray(skills) ? (skills as { name: string; enabled: boolean }[]) : [];
      }),
      mcpApi.list().then(({ data }) => (Array.isArray(data) ? data : [])),
      taskApi.list().then(({ data }) => (Array.isArray(data) ? data : [])),
    ]);
    setState({
      environments: results[0].status === "fulfilled" ? results[0].value : [],
      sessions: results[1].status === "fulfilled" ? results[1].value : [],
      agents: results[2].status === "fulfilled" ? results[2].value : [],
      models: results[3].status === "fulfilled" ? (results[3].value as StatsState["models"]) : null,
      skills: results[4].status === "fulfilled" ? (results[4].value as StatsState["skills"]) : [],
      mcpServers: results[5].status === "fulfilled" ? (results[5].value as StatsState["mcpServers"]) : [],
      tasks: results[6].status === "fulfilled" ? (results[6].value as StatsState["tasks"]) : [],
      loading: false,
    });
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  useConfigChangeListener(() => {
    load();
  }, [load]);

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
 *  useCountUp
 * ========================================================================== */

function useCountUp(target: number, duration = 800, enabled = true) {
  const [display, setDisplay] = useState(0);
  const raf = useRef<number>(0);
  const start = useRef<number>(0);

  useEffect(() => {
    if (!enabled || target === 0) {
      setDisplay(target);
      return;
    }
    const animate = (ts: number) => {
      if (!start.current) start.current = ts;
      const elapsed = ts - start.current;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - (1 - progress) ** 3;
      setDisplay(Math.round(eased * target));
      if (progress < 1) raf.current = requestAnimationFrame(animate);
    };
    raf.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf.current);
  }, [target, duration, enabled]);

  return display;
}

/* ========================================================================== *
 *  RingChart
 * ========================================================================== */

interface RingChartProps {
  pct: number;
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
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={offset}
            style={{ transition: "stroke-dashoffset 1.2s cubic-bezier(0.4, 0, 0.2, 1)" }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          {Icon ? (
            <Icon className="h-4 w-4" style={{ color }} />
          ) : (
            <span className="text-xs font-mono font-bold" style={{ color }}>
              {display}%
            </span>
          )}
        </div>
      </div>
      <span className="text-[11px] font-medium text-text-primary">{label}</span>
      <span className="text-[10px] text-text-muted -mt-1">{sub}</span>
    </div>
  );
}

/* ========================================================================== *
 *  StatusDot
 * ========================================================================== */

function StatusDot({ color, pulse = false }: { color: string; pulse?: boolean }) {
  return (
    <span className="relative inline-flex h-2 w-2">
      <span className={cn("absolute inset-0 rounded-full", color)} />
      {pulse && (
        <span className={cn("absolute inset-0 rounded-full animate-ping", color)} style={{ animationDuration: "2s" }} />
      )}
    </span>
  );
}

/* ========================================================================== *
 *  AnimatedKpiCard
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
  icon: Icon,
  label,
  value,
  suffix,
  trend,
  accentColor,
  accentBg,
  sparkPath,
}: AnimatedKpiCardProps) {
  const display = useCountUp(value, 900);

  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-surface-1 p-4 px-5 transition-transform duration-200 ease-out hover:-translate-y-[3px] hover:shadow-[0_8px_25px_rgba(0,0,0,0.08)] hover:border-brand cursor-default group">
      <div
        className="absolute -top-8 -right-8 w-20 h-20 rounded-full opacity-[0.06] blur-[30px]"
        style={{ background: accentColor }}
      />
      <div className="relative z-10 flex flex-col h-full">
        <div className="flex items-center justify-between mb-2">
          <div
            className={cn("w-[34px] h-[34px] rounded-[10px] flex items-center justify-center", accentBg)}
            style={{ color: accentColor }}
          >
            <Icon className="h-[18px] w-[18px]" />
          </div>
          <span className="text-[11px] font-medium text-[#30b08f]">{trend}</span>
        </div>
        <div
          className="font-mono text-[30px] font-bold tracking-tight leading-none mb-1"
          style={{ color: accentColor }}
        >
          {display}
          {suffix ?? ""}
        </div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted mt-auto">{label}</div>
      </div>
      <svg
        className="absolute bottom-0 left-0 right-0 h-[30px] opacity-10 pointer-events-none"
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
 *  TopologyNode
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
    case "active":
      return "#30b08f";
    case "idle":
      return "#6366F1";
    case "error":
      return "#c03639";
    case "offline":
      return "#909399";
  }
}

function AgentTopology({
  agents,
  t,
}: {
  agents: TopoNode[];
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const canvasW = 520;
  const canvasH = 180;
  const hubX = canvasW / 2;
  const hubY = 38;

  const maxShow = 6;
  const shown = agents.slice(0, maxShow);
  const gap = canvasW / (shown.length + 1);

  function statusLabel(s: TopoNode["status"]) {
    switch (s) {
      case "active":
        return t("topology.status_running");
      case "idle":
        return t("topology.status_idle");
      case "error":
        return t("topology.status_error");
      case "offline":
        return t("topology.status_offline");
    }
  }

  return (
    <svg viewBox={`0 0 ${canvasW} ${canvasH}`} className="w-full h-auto" style={{ maxHeight: 180 }}>
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

      <rect
        x={hubX - 48}
        y={hubY - 14}
        width={96}
        height={30}
        rx={8}
        fill="var(--color-surface-1)"
        stroke="#6366F1"
        strokeWidth="2"
        filter="url(#topoShadow)"
      />
      <text
        x={hubX}
        y={hubY + 6}
        textAnchor="middle"
        fill="var(--color-text-primary)"
        fontFamily="Inter, sans-serif"
        fontSize="13"
        fontWeight="700"
      >
        RCS Hub
      </text>
      <circle cx={hubX} cy={hubY + 1} r="4" fill="#6366F1">
        <animate attributeName="r" values="4;12;4" dur="2s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;0;0.5" dur="2s" repeatCount="indefinite" />
      </circle>

      {shown.map((a, i) => {
        const nx = gap * (i + 1);
        const ny = 130;

        return (
          <g key={a.id}>
            <line
              x1={hubX}
              y1={hubY + 20}
              x2={nx}
              y2={ny}
              stroke={statusColor(a.status)}
              strokeOpacity="0.25"
              strokeWidth="1.5"
              strokeDasharray={a.status === "offline" ? "4,4" : undefined}
            />
            {a.status !== "offline" && (
              <>
                <circle r="2.5" fill={statusColor(a.status)} opacity="0.6">
                  <animateMotion
                    dur={`${2 + i * 0.5}s`}
                    repeatCount="indefinite"
                    path={`M${hubX},${hubY + 20} L${nx},${ny}`}
                  />
                </circle>
                <circle r="1.5" fill="#22D3EE" opacity="0.4">
                  <animateMotion
                    dur={`${2.5 + i * 0.3}s`}
                    repeatCount="indefinite"
                    path={`M${hubX},${hubY + 20} L${nx},${ny}`}
                    begin="0.8s"
                  />
                </circle>
              </>
            )}
          </g>
        );
      })}

      {shown.map((a, i) => {
        const nx = gap * (i + 1);
        const ny = 130;
        const sc = statusColor(a.status);

        return (
          <g key={a.id}>
            <rect
              x={nx - 52}
              y={ny - 2}
              width={104}
              height={44}
              rx={10}
              fill="var(--color-surface-1)"
              stroke={sc}
              strokeWidth="1.5"
              filter="url(#topoShadow)"
            />
            {a.status === "active" && (
              <rect
                x={nx - 52}
                y={ny - 2}
                width={104}
                height={44}
                rx={10}
                fill="none"
                stroke={sc}
                strokeWidth="1.5"
                style={{ animation: "glowBreathe 3s ease-in-out infinite" }}
              />
            )}
            <circle cx={nx - 36} cy={ny + 20} r="4.5" fill={sc} />
            {a.status === "active" && (
              <circle cx={nx - 36} cy={ny + 20} r="4.5" fill={sc} opacity="0.3">
                <animate attributeName="r" values="4.5;8;4.5" dur="2s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.3;0;0.3" dur="2s" repeatCount="indefinite" />
              </circle>
            )}
            <text
              x={nx}
              y={ny + 14}
              textAnchor="middle"
              fill="var(--color-text-primary)"
              fontFamily="Inter, sans-serif"
              fontSize="11.5"
              fontWeight="600"
            >
              {a.name.length > 12 ? `${a.name.slice(0, 12)}…` : a.name}
            </text>
            <text x={nx} y={ny + 30} textAnchor="middle" fill={sc} fontSize="10">
              ● {statusLabel(a.status)}
            </text>
          </g>
        );
      })}

      {agents.length > maxShow && (
        <text x={canvasW - 30} y={canvasH - 12} fill="var(--color-text-muted)" fontSize="11">
          {t("topology.more", { count: agents.length - maxShow })}
        </text>
      )}
    </svg>
  );
}

/* ========================================================================== *
 *  TimelineItem
 * ========================================================================== */

function TimelineItem({ dotColor, title, time }: { dotColor: string; title: string; time: string }) {
  return (
    <div className="px-3 py-2 rounded-lg transition-colors duration-150 hover:bg-surface-2">
      <div className="flex items-center gap-3">
        <span className={cn("inline-block w-[7px] h-[7px] rounded-full shrink-0", dotColor)} />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] text-text-primary truncate">{title}</div>
          <div className="text-[10px] text-text-muted mt-0.5">{time}</div>
        </div>
      </div>
    </div>
  );
}

/* ========================================================================== *
 *  Dashboard
 * ========================================================================== */

export function Dashboard() {
  const stats = useStats();
  const { t } = useTranslation("dashboard");

  if (stats.loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
          <div className="text-sm text-text-muted">{t("loading")}</div>
        </div>
      </div>
    );
  }

  const activeEnvs = stats.environments.filter(
    (e) => e.instance_status === "running" || e.instance_status === "starting",
  );
  const activeSessions = stats.sessions.filter((s) => s.status === "active" || s.status === "running");
  const enabledSkills = stats.skills.filter((s) => s.enabled);
  const enabledMcp = stats.mcpServers.filter((m) => m.enabled);
  const enabledTasks = stats.tasks.filter((t) => t.enabled);
  const modelCount = stats.models?.available?.length ?? 0;
  const totalConfigItems = stats.agents.length + stats.skills.length + stats.mcpServers.length;
  const enabledConfigItems =
    enabledSkills.length + enabledMcp.length + stats.agents.filter((a) => a.enabled !== false).length;
  const healthPct = totalConfigItems > 0 ? Math.round((enabledConfigItems / totalConfigItems) * 95 + 5) : 100;

  const topoNodes: TopoNode[] = stats.environments.map((e) => {
    const isActive = e.instance_status === "running" || e.instance_status === "starting";
    const isError = e.instance_status === "error";
    return {
      id: e.id,
      name: e.name || e.agent_name || e.id.slice(0, 8),
      x: 0,
      y: 0,
      status: isActive ? "active" : isError ? "error" : "offline",
    } satisfies TopoNode;
  });

  const timeline = buildTimeline(stats, t);

  const _sparkAgents = generateSparkData(activeEnvs.length, stats.environments.length);
  const _sparkSessions = generateSparkData(activeSessions.length, stats.sessions.length);
  const _sparkModels = generateSparkData(modelCount, modelCount);
  const _sparkTasks = generateSparkData(enabledTasks.length, stats.tasks.length);
  const _sparkHealth = generateSparkData(healthPct / 100, healthPct / 100, 0.7, 1);

  return (
    <div
      className="h-full overflow-y-auto"
      style={{
        background:
          "radial-gradient(ellipse 80% 60% at 50% -20%, rgba(99, 102, 241, 0.04), transparent), radial-gradient(ellipse 50% 40% at 80% 80%, rgba(34, 211, 238, 0.03), transparent)",
      }}
    >
      <div className="mx-auto max-w-6xl px-6 py-6 space-y-5">
        {/* Page title */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-text-primary">{t("title")}</h1>
            <p className="text-[12px] text-text-muted mt-0.5">{t("subtitle")}</p>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-text-muted">
            <StatusDot color="bg-status-active" pulse />
            <span>{t("system_running")}</span>
          </div>
        </div>

        {/* KPI cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 [&>*]:animate-[fadeUp_0.5s_ease_forwards] [&>*]:opacity-0 [&>*:nth-child(1)]:delay-[50ms] [&>*:nth-child(2)]:delay-[100ms] [&>*:nth-child(3)]:delay-[150ms] [&>*:nth-child(4)]:delay-[200ms] [&>*:nth-child(5)]:delay-[250ms] [&>*:nth-child(6)]:delay-[300ms] [&>*:nth-child(7)]:delay-[350ms] [&>*:nth-child(8)]:delay-[400ms]">
          <AnimatedKpiCard
            icon={Bot}
            label={t("stat_cards.agents")}
            value={stats.environments.length}
            trend={t("stat_cards.trend_active", { count: activeEnvs.length })}
            accentColor="#6366F1"
            accentBg="bg-brand-subtle text-brand-light"
            sparkPath="M0,22 C20,22 30,18 50,18 C70,18 80,14 100,14 C120,14 130,8 150,8 C170,8 180,12 200,10"
          />
          <AnimatedKpiCard
            icon={MessageSquare}
            label={t("stat_cards.sessions")}
            value={stats.sessions.length}
            trend={t("stat_cards.trend_in_progress", { count: activeSessions.length })}
            accentColor="#22D3EE"
            accentBg="bg-[rgba(34,211,238,0.12)] text-[#22D3EE]"
            sparkPath="M0,16 C30,16 45,12 60,12 C75,12 90,18 105,18 C120,18 135,10 150,10 C165,10 185,14 200,8"
          />
          <AnimatedKpiCard
            icon={Cpu}
            label={t("stat_cards.models")}
            value={modelCount}
            trend={t("stat_cards.trend_configured")}
            accentColor="#818CF8"
            accentBg="bg-[rgba(129,140,248,0.12)] text-[#818CF8]"
            sparkPath="M0,10 C20,10 35,14 50,14 C65,14 80,8 95,8 C110,8 130,12 150,12 C170,12 185,6 200,8"
          />
          <AnimatedKpiCard
            icon={ShieldCheck}
            label={t("stat_cards.availability")}
            value={healthPct}
            suffix="%"
            trend={t("stat_cards.trend_healthy")}
            accentColor="#10B981"
            accentBg="bg-[rgba(52,211,153,0.12)] text-[#10B981]"
            sparkPath="M0,6 C25,6 40,4 60,4 C80,4 95,8 115,8 C135,8 155,4 175,4 C190,4 200,6 200,6"
          />
          <AnimatedKpiCard
            icon={Clock}
            label={t("stat_cards.tasks")}
            value={stats.tasks.length}
            trend={t("stat_cards.trend_enabled", { count: enabledTasks.length })}
            accentColor="#F59E0B"
            accentBg="bg-[rgba(251,191,36,0.12)] text-[#F59E0B]"
            sparkPath="M0,20 C30,20 50,16 70,16 C90,16 110,14 130,14 C150,14 165,10 185,10 C195,10 200,12 200,12"
          />
        </div>

        {/* Health rings | Topology */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="rounded-xl border border-border bg-surface-1 p-5 flex flex-col">
            <div className="flex items-center gap-2 mb-4">
              <ShieldCheck className="h-4 w-4 text-brand" />
              <span className="text-xs font-semibold uppercase tracking-wider text-text-dim">{t("health.title")}</span>
            </div>
            <div className="flex flex-wrap justify-center gap-4 flex-1 items-center">
              <RingChart
                pct={
                  activeEnvs.length > 0
                    ? Math.round((activeEnvs.length / Math.max(stats.environments.length, 1)) * 100)
                    : 0
                }
                color="#6366F1"
                trackColor="var(--color-surface-2)"
                label={t("health.agents_online")}
                sub={`${activeEnvs.length}/${stats.environments.length}`}
                icon={Server}
              />
              <RingChart
                pct={
                  stats.sessions.length > 0
                    ? Math.round((activeSessions.length / Math.max(stats.sessions.length, 1)) * 100)
                    : 0
                }
                color="#30b08f"
                trackColor="var(--color-surface-2)"
                label={t("health.sessions_active")}
                sub={`${activeSessions.length}/${stats.sessions.length}`}
                icon={MessageSquare}
              />
              <RingChart
                pct={healthPct}
                color="#e65d6e"
                trackColor="var(--color-surface-2)"
                label={t("health.config_enabled")}
                sub={`${enabledConfigItems}/${totalConfigItems}`}
                icon={Zap}
              />
            </div>
          </div>

          <div className="rounded-xl border border-border bg-surface-1 p-5 flex flex-col lg:col-span-2">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Radio className="h-4 w-4 text-status-active" />
                <span className="text-xs font-semibold uppercase tracking-wider text-text-dim">
                  {t("topology.title")}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
                <StatusDot color="bg-status-active" pulse />
                <span>
                  {topoNodes.filter((n) => n.status === "active").length} {t("topology.online")}
                </span>
                <span className="mx-1 text-border">|</span>
                <StatusDot color="bg-gray-400" />
                <span>
                  {topoNodes.filter((n) => n.status === "offline").length} {t("topology.offline")}
                </span>
              </div>
            </div>
            <div className="flex-1 flex items-center justify-center min-h-[180px]">
              {topoNodes.length > 0 ? (
                <AgentTopology agents={topoNodes} t={t} />
              ) : (
                <div className="text-sm text-text-muted">{t("topology.empty")}</div>
              )}
            </div>
          </div>
        </div>

        {/* Timeline | Quick stats */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="rounded-xl border border-border bg-surface-1 p-5 lg:col-span-2">
            <div className="flex items-center gap-2 mb-3">
              <Activity className="h-4 w-4 text-status-warning" />
              <span className="text-xs font-semibold uppercase tracking-wider text-text-dim">{t("recent.title")}</span>
            </div>
            <div className="space-y-2">
              {timeline.length > 0 ? (
                timeline.map((item, i) => (
                  <TimelineItem
                    // biome-ignore lint/suspicious/noArrayIndexKey: timeline items may lack unique id
                    key={`${item.title}-${item.time}-${i}`}
                    dotColor={item.dotColor}
                    title={item.title}
                    time={item.time}
                  />
                ))
              ) : (
                <div className="text-sm text-text-muted py-2">{t("recent.no_activity")}</div>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-surface-1 p-5">
            <div className="flex items-center gap-2 mb-3">
              <Wrench className="h-4 w-4 text-text-dim" />
              <span className="text-xs font-semibold uppercase tracking-wider text-text-dim">
                {t("recent.quick_stats")}
              </span>
            </div>
            <div className="space-y-3">
              <QuickStatRow label={t("quick_stats.agent_config")} count={stats.agents.length} />
              <QuickStatRow label={t("quick_stats.skills")} count={enabledSkills.length} total={stats.skills.length} />
              <QuickStatRow
                label={t("quick_stats.mcp_servers")}
                count={enabledMcp.length}
                total={stats.mcpServers.length}
              />
              <QuickStatRow
                label={t("quick_stats.session_archive")}
                count={stats.sessions.filter((s) => s.status === "archived" || s.status === "complete").length}
              />
              <QuickStatRow
                label={t("quick_stats.scheduled_tasks")}
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
 *  Utilities
 * ========================================================================== */

function generateSparkData(active: number, total: number, min = 0.1, max = 1): number[] {
  const ratio = total > 0 ? active / total : 0;
  const points: number[] = [];
  for (let i = 0; i < 8; i++) {
    const t = i / 7;
    const noise = Math.sin(t * Math.PI * 2) * 0.12 + Math.cos(t * Math.PI * 3) * 0.08;
    const base = min + ratio * (max - min);
    const val = base + noise * (1 - ratio);
    points.push(Math.max(0.05, Math.min(1, val)));
  }
  return points;
}

function buildTimeline(stats: StatsState, t: (key: string, opts?: Record<string, unknown>) => string) {
  const items: { dotColor: string; title: string; time: string }[] = [];

  const activeEnvs = stats.environments.filter(
    (e) => e.instance_status === "running" || e.instance_status === "starting",
  );
  const activeSessions = stats.sessions.filter((s) => s.status === "active" || s.status === "running");

  if (activeEnvs.length > 0) {
    items.push({
      dotColor: "bg-status-active",
      title: t("timeline.agents_active", { count: activeEnvs.length }),
      time: t("timeline.time_now"),
    });
  }
  if (activeSessions.length > 0) {
    items.push({
      dotColor: "bg-status-running",
      title: t("timeline.sessions_in_progress", { count: activeSessions.length }),
      time: t("timeline.time_now"),
    });
  }
  if (stats.tasks.length > 0) {
    items.push({
      dotColor: "bg-status-warning",
      title: t("timeline.tasks_registered", { count: stats.tasks.length }),
      time: t("timeline.time_system"),
    });
  }
  if (stats.models?.available?.length) {
    items.push({
      dotColor: "bg-violet-500",
      title: t("timeline.models_available", { count: stats.models.available.length }),
      time: t("timeline.time_config"),
    });
  }
  if (items.length === 0) {
    items.push({
      dotColor: "bg-gray-400",
      title: t("recent.no_startup"),
      time: t("timeline.time_now"),
    });
  }

  return items;
}
