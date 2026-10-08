/**
 * 侧栏智能体树：蓝色侧栏里的 agent 卡片列表与实例行。
 *
 * 迁入自宿主 `apps/web/src/shell/AgentSidebarTree.tsx`（2026-09-28，视图部分）。边界如下：
 *
 * - **纯渲染**：不取数、不发请求、不读组织上下文。显示名 / 访问角标 / 可写可删等**领域判定**由
 *   装配方（`@fenix/agent-config/web`）解析成 `AgentTreeAgentItem` 后传入，本组件只回答「怎么画」。
 * - **内部状态只有树展开**：展开态只影响渲染，与数据来源无关，故留在组件内（数据源变化不重置它）。
 * - **配色自带**：组件设计给宿主的蓝色侧栏（`bg-white/*` 系列的白色蒙层），不依赖宿主
 *   `agent-panel.css` 的 `.agent-sidebar-*` 覆写——那批规则曾用「未分层 CSS 压过工具类」的方式
 *   改色，组件迁走后调用方不再需要它们。样式主体是工具类（刻度已在 `@theme` 按 px 落地，工具类写的就是
 *   设计值），只有伪元素指示条与三处投影落在同目录 `./agent-tree.css`（原因见该文件头）。
 *
 * i18n 走本包命名空间（`agentTree.*`）；访问角标的 `resource.*` 文案也取自本包字典。
 */
import { Bot, ChevronDown, ChevronRight, Eye, Plus, RotateCw, Settings, Square, Trash2 } from "lucide-react";
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { StatusBadge, type StatusTone } from "../config/StatusBadge";
import { UI_COMPONENTS_NS } from "../i18n/namespace";
import { Spinner } from "../ui/spinner";
import { StatusDot } from "../ui/status-dot";
import type { AgentTreeProps } from "./agent-tree-model";
import { getInstanceStatusTone, getRunningInstances, orderInstancesByRunningStatus } from "./agent-tree-model";
import "./agent-tree.css";

/**
 * agent 名称刻度 13px，走 px 档令牌 `text-13`（令牌值就是绝对像素，不随根字号缩放）。
 *
 * 原值是宿主 `.agent-sidebar-agent-card` 的 `font-size: 13px`（`--text-13` 的注释也按这个用途登记），
 * 早期实现是 `text-[13px]`。`text-13` 与卡片自身的字号同源；`text-sm` 是 14px，不是这一档。
 *
 * 为什么带 `min-w-0`：名称是 flex 行内的项目，flex 项目的 `min-width: auto` 会把宽度撑回内容宽度，
 * 缺了它同行的 `truncate` 压不下去；截断另有 `title` 兜底，见渲染点。
 */
const AGENT_ITEM_TITLE_CLASS = "text-13 font-semibold text-white/94 truncate min-w-0";

/**
 * agent 卡片悬浮操作栏的图标按钮刻度（展开 / 重启 / 配置三个按钮同名同级）。
 *
 * 三个按钮此后各写一遍同一串类名，调其中一处（比如把 `w-6` 改成 `w-7`）会让另外两个静默停在旧刻度上。
 * 配置按钮永不进入禁用态，仍带上 `disabled:opacity-50`——该变体只在 `:disabled` 命中时生效，写成同一份
 * 刻度比让它少一条更像「另一类按钮」。删除按钮是红色调的危险动作，单列一处刻度。
 *
 * 按钮本身的 24×24 与 6px 圆角自视图诞生（4027fd0d）起就是刻度类，宿主样式表从未给过它们 px 原值，
 * 故按本批判据留在 `className`；按钮**里的图标** 15×15 有原值（`.agent-sidebar-icon-btn svg` /
 * `.agent-sidebar-actions button svg`），落在 `size-3.75` 上（`--spacing` = 4px，3.75 档即 15px）。
 */
const AGENT_ACTION_BUTTON_CLASS =
  "flex items-center justify-center w-6 h-6 border-none rounded-md bg-white/10 text-white/62 cursor-pointer hover:bg-white/18 hover:text-white transition-colors disabled:opacity-50";

/** 删除按钮：同一刻度，危险动作用红色反馈（hover 才上色，静止时不与其它三个按钮抢注意力）。 */
const AGENT_DELETE_BUTTON_CLASS =
  "flex items-center justify-center w-6 h-6 border-none rounded-md bg-white/10 text-white/62 cursor-pointer hover:bg-red-500/20 hover:text-red-300 transition-colors disabled:opacity-50";

/**
 * 实例行悬浮操作栏的图标按钮刻度（重启 / 停止两处同名同级）。
 *
 * 配色用白色蒙层而不是 `text-text-dim` / `bg-surface-hover` 主题令牌：那对令牌是**浅色主题**值
 * （`#94a3b8` / `#e6f0ff`），宿主侧栏是蓝底，旧实现靠 `agent-panel.css` 里
 * `.agent-sidebar-tree .text-text-dim { color: rgba(255,255,255,0.58) }` 这类**未分层覆写**压回白色。
 * 那批覆写随视图迁走已删除，令牌在这里会渲染成蓝底上的灰字与近白亮块；`white/58` 与 `white/18`
 * 就是覆写原本给出的等效值，也与同侧栏的 agent 级按钮（`AGENT_ACTION_BUTTON_CLASS`）同一刻度。
 */
const INSTANCE_ACTION_BUTTON_CLASS =
  "flex items-center justify-center w-5.5 h-5.5 border-none rounded bg-transparent text-white/58 cursor-pointer hover:bg-white/18 hover:text-white transition-colors disabled:opacity-50";

/** 选中态卡片：描边取侧栏强调色、底色提亮一档。左指示条的几何——宽度 3px（`before:w-0.75`）与
 *  垂直居中（`before:top-1/2`）——2026-09-28 第三批从 `./agent-tree.css` 撤回这里（`::before` 只在
 *  选中态有 `content`，类也只挂选中卡片）；其余外形（60% 高、圆角、渐变）仍见该表。 */
const AGENT_CARD_SELECTED_CLASS =
  "agent-tree-card--selected before:w-0.75 before:top-1/2 border-[var(--agent-tree-accent-strong)] bg-white/16 text-white";

/**
 * 访问级别的色调词表：`resource.public` = 可对外 / 被他组织引用，`resource.external` = 外部组织资源。
 *
 * 用色调而不是色名（`text-blue-700` / `bg-amber-100` 这类）：色名一旦写进业务，同一语义会在各页面
 * 各演化一套绿/蓝，深浅色变体也要跟着各写一份。色调只声明「这类访问级别算哪一类信息」，
 * 具体色值由 `StatusBadge` 决定。`resource.internal` 不展示徽标、故不登记——未命中一律按 `neutral`，
 * 不会臆断成某一类。
 */
const ACCESS_BADGE_TONES: Record<string, StatusTone> = {
  "resource.public": "info",
  "resource.external": "warning",
};

/** 不展示徽标的访问级别（本组织私有是默认状态，标出来只是噪音）。 */
const HIDDEN_ACCESS_BADGE_KEY = "resource.internal";

export const AgentTree = memo(function AgentTree({
  agents,
  initialLoading,
  fetching,
  selectedEnvironmentId = null,
  selectedInstanceId = null,
  enteringAgentId = null,
  pendingInstance = null,
  onCreateAgent,
  onEnterAgent,
  onEnterInstance,
  onSpawnInstance,
  onRestartAgent,
  onRestartInstance,
  onStopInstance,
  onConfigureAgent,
  onDeleteAgent,
}: AgentTreeProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);

  // 树展开状态：只影响渲染，不需要跨数据刷新保持（agent 列表刷新时保留已展开的项）。
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>({});

  // 只有首次加载（尚未完成过任何一次数据加载）才显示全屏 loading 动画，判据由装配方维护。
  // 轮询刷新、手动 refresh 时已有数据保留在 DOM 中，不替换，避免闪烁。
  if (initialLoading) {
    return <Spinner variant="panel" size="xs" className="py-6" />;
  }

  // 非加载状态下的空列表
  if (agents.length === 0 && !fetching) {
    return (
      <div className="px-4 py-4 text-center text-white/58">
        <Bot className="h-8 w-8 mx-auto mb-2 text-white/58 opacity-30" />
        <p className="text-xs mb-3">{t("agentTree.noAgents")}</p>
        {onCreateAgent && (
          <button
            type="button"
            onClick={onCreateAgent}
            className="agent-tree-create-btn inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-gradient-to-br from-[var(--agent-tree-accent-deep)] to-[var(--agent-tree-accent-bright)] text-white transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            {t("agentTree.createAgent")}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="agent-tree flex-1 min-h-0 overflow-y-auto overflow-x-hidden pt-2 pb-3 [scrollbar-color:rgba(255,255,255,0.22)_transparent] [scrollbar-width:thin]">
      <div className="sticky top-0 z-10 flex items-center justify-between pr-4 pb-4">
        <span className="block px-4 pt-2.5 pb-1 text-3xs font-bold uppercase leading-[1.2] tracking-widest text-white/35">
          {t("agentTree.sectionTitle")}
        </span>
        <div className="flex items-center gap-1">
          {onCreateAgent && (
            <button
              type="button"
              onClick={onCreateAgent}
              title={t("agentTree.createAgent")}
              className="w-6 h-6 flex items-center justify-center rounded-md bg-white/10 text-white/62 hover:bg-white/18 hover:text-white cursor-pointer transition-colors"
            >
              <Plus className="size-3.75" />
            </button>
          )}
        </div>
      </div>
      {agents.map((agent) => {
        const { instances } = agent;
        const orderedInstances = orderInstancesByRunningStatus(instances);
        const collapsed = !expandedAgents[agent.id];
        const isEntering = enteringAgentId === agent.id;
        const runningInstances = getRunningInstances(instances);
        const isAgentSelected =
          agent.environmentId === selectedEnvironmentId ||
          instances.some((inst) => inst.instanceUid === selectedInstanceId);
        // agent 级别的重启中状态：该 agent 下有实例正在重启
        const isRestarting =
          pendingInstance?.type === "restart" &&
          runningInstances.some((inst) => inst.instanceUid === pendingInstance?.id);
        // 拆分 标识键/名称 格式：前半为标识键，后半为显示名
        const slashIdx = agent.displayName.indexOf("/");
        const agentLabel = slashIdx >= 0 ? agent.displayName.slice(slashIdx + 1) : agent.displayName;
        const agentKey = slashIdx >= 0 ? agent.displayName.slice(0, slashIdx) : "";
        const showAccessBadge = agent.accessBadgeKey !== HIDDEN_ACCESS_BADGE_KEY;

        return (
          <div key={agent.id} className="mx-2 mb-2 group relative last:mb-0">
            {/* 卡片主体 */}
            <button
              type="button"
              disabled={isEntering}
              onClick={() => onEnterAgent(agent.id)}
              className={[
                "agent-tree-card relative flex items-center justify-between gap-2.5 w-full min-h-10",
                "px-3 py-2.25 text-left text-13 font-[inherit]",
                "border border-white/10 rounded-md bg-white/8 text-white/94",
                "cursor-pointer transition-all duration-150",
                "hover:border-[var(--agent-tree-accent-soft)] hover:bg-white/13",
                "disabled:opacity-60 disabled:cursor-not-allowed",
                isAgentSelected ? AGENT_CARD_SELECTED_CLASS : "",
              ].join(" ")}
            >
              {/* 一行左右布局：左侧显示名（过长截断，title 兜底），右侧标识键 / 远程标记 */}
              <div className="flex items-center gap-1.5 min-w-0">
                <div className={AGENT_ITEM_TITLE_CLASS} title={agentLabel}>
                  {agentLabel}
                </div>
                {/* 仅公有 / 外部显示标签；色调语义见 `ACCESS_BADGE_TONES` */}
                {showAccessBadge && (
                  <StatusBadge
                    status={agent.accessBadgeKey}
                    label={t(agent.accessBadgeKey)}
                    toneMap={ACCESS_BADGE_TONES}
                  />
                )}
              </div>
              {/* 副信息：标识键 + 远程标记。字号 10px 走 px 档令牌 `text-3xs`（`text-xs` 是 12px，不是
                  这一档）。`shrink-0` 让名称先让位；键自身再压一个上限，避免长组织名把同一行里的名称
                  挤到只剩几个字。
                  悬浮操作栏是 `absolute right-1.5`，不预留空间——它出现就压在同一行右端，而副信息恒在
                  右端（`justify-between`），因此两者必须互斥。用 `group-hover:invisible` 让副信息在操作栏
                  出现时让位：`visibility` 不参与布局计算（`display` 会让行内抖动），且它同时把内容移出
                  无障碍树——`opacity-0` 会让读屏继续播报已经看不见的字。操作栏自身用 `opacity` 显示，
                  `opacity` 不影响可聚焦性，键盘仍可 Tab 进四个按钮，故不给副信息加 `group-focus-within`：
                  那会连「Tab 到卡片本身」也把副信息抹掉。 */}
              {(agentKey || agent.remote) && (
                <div className="flex items-center gap-1.5 shrink-0 text-3xs text-white/58 group-hover:invisible">
                  {agentKey && (
                    <span className="font-mono truncate max-w-20" title={agentKey}>
                      {agentKey}
                    </span>
                  )}
                  {agent.remote && (
                    <>
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
                      <span className="shrink-0">{t("agentTree.remoteNode")}</span>
                    </>
                  )}
                </div>
              )}
            </button>

            {/* 悬浮操作栏（四个图标各 15×15，走 `size-3.75`） */}
            <div className="absolute top-1.5 right-1.5 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                type="button"
                className={AGENT_ACTION_BUTTON_CLASS}
                onClick={() =>
                  setExpandedAgents((prev) => ({
                    ...prev,
                    [agent.id]: !prev[agent.id],
                  }))
                }
                title={collapsed ? t("agentTree.expandInstances") : t("agentTree.collapseInstances")}
              >
                {collapsed ? (
                  <ChevronRight className="size-3.75" strokeWidth={1.8} />
                ) : (
                  <ChevronDown className="size-3.75" strokeWidth={1.8} />
                )}
              </button>
              <button
                type="button"
                className={AGENT_ACTION_BUTTON_CLASS}
                disabled={isRestarting}
                onClick={() => onRestartAgent(agent.id)}
                title={t("agentTree.restartAgent")}
              >
                <RotateCw className={`size-3.75 ${isRestarting ? "animate-spin" : ""}`} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                className={AGENT_ACTION_BUTTON_CLASS}
                onClick={() => onConfigureAgent?.(agent.id)}
                title={agent.readOnly ? t("agentTree.viewAgentConfig") : t("agentTree.agentConfig")}
              >
                {agent.readOnly ? (
                  <Eye className="size-3.75" strokeWidth={1.8} />
                ) : (
                  <Settings className="size-3.75" strokeWidth={1.8} />
                )}
              </button>
              {agent.deletable && (
                <button
                  type="button"
                  className={AGENT_DELETE_BUTTON_CLASS}
                  onClick={() => onDeleteAgent?.(agent.id)}
                  title={t("agentTree.deleteAgent")}
                >
                  <Trash2 className="size-3.75" strokeWidth={1.8} />
                </button>
              )}
            </div>

            {/* 展开的实例列表 */}
            {!collapsed && (
              <div className="mt-1 py-0.5">
                {orderedInstances.map((inst) => {
                  // per-instance 操作状态：通过 pendingInstance 精确匹配实例 ID 和操作类型
                  const isInstRestarting =
                    pendingInstance?.id === inst.instanceUid && pendingInstance?.type === "restart";
                  const isInstStopping = pendingInstance?.id === inst.instanceUid && pendingInstance?.type === "stop";
                  const isInstSelected = selectedInstanceId === inst.instanceUid;
                  return (
                    <div
                      key={inst.instanceUid}
                      className={[
                        // 字号 13px 走 px 档令牌 `text-13`：实例行的原值就是 13px（早期 `text-[13px]`），
                        // `text-xs` 是 12px，不是同一档。
                        "group flex items-center gap-2 px-3 py-1.5 ml-2 text-13 rounded-md cursor-pointer transition-colors",
                        isInstSelected ? "bg-white/15 text-white" : "text-white/76 hover:bg-white/8 hover:text-white",
                      ].join(" ")}
                      onClick={() => onEnterInstance(agent.id, inst.instanceUid)}
                    >
                      <StatusDot tone={getInstanceStatusTone(inst)} />
                      <span className="truncate">{inst.name}</span>
                      <div className="ml-auto flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        <button
                          type="button"
                          className={INSTANCE_ACTION_BUTTON_CLASS}
                          disabled={isInstRestarting}
                          onClick={(e) => {
                            e.stopPropagation();
                            onRestartInstance(agent.id, inst.instanceUid);
                          }}
                          title={t("agentTree.restart")}
                        >
                          <RotateCw className={`w-3.5 h-3.5 ${isInstRestarting ? "animate-spin" : ""}`} />
                        </button>
                        <button
                          type="button"
                          className={INSTANCE_ACTION_BUTTON_CLASS}
                          disabled={isInstStopping}
                          onClick={(e) => {
                            e.stopPropagation();
                            onStopInstance(inst.instanceUid);
                          }}
                          title={t("agentTree.stop")}
                        >
                          <Square className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
                <button
                  type="button"
                  disabled={isEntering}
                  onClick={() => onSpawnInstance(agent.id)}
                  title={t("agentTree.newInstance")}
                  // 与实例行同源：字号 13px 走 px 档令牌 `text-13`（原值 `text-[13px]`）。
                  className="flex items-center gap-1.5 px-3 py-1 ml-2 text-13 text-white/56 cursor-pointer border-none rounded-md bg-transparent hover:bg-white/8 hover:text-white transition-colors whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5 shrink-0" />
                  <span>{t("agentTree.newInstance")}</span>
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});
