import "./AgentBadge.css";

import { Loader2, MessageSquare, Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { cn } from "../../lib/cn";
import { AgentLogo } from "./internal/agent-logo";

// =============================================================================
// AgentBadge — 工牌卡组件，双模式：空状态展示（ChatView）+ 管理卡片（AgentManagementPage）
// 渐变头部 + 挂绳孔 + AgentAvatar SVG + 水印 + Skills tag + 可选操作按钮
//
// 来源：逐字复制 `packages/agent-runtime/web/components/chat/AgentBadge.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
// 纯化改动点：`chat:inject-skill` window CustomEvent 总线改为 `onInjectSkill` 回调；
// i18n 收敛到包内单一命名空间（键前缀 `chat.components.`）。
//
// 样式迁移：本文件渲染的选择器源自 `web/css/chat-agent-badge.css`（阶段五删除，`@keyframes` 并入
// `web/css/chat-animations.css`）。阶段一曾把它们逐条改写成 Tailwind 工具类（数值/色值逐字保持）；
// 2026-09-23 又按仓库禁令 FCP-WEB-02 把「需要伪元素选择器或复合值」的那部分下沉回同目录
// `AgentBadge.css`（点阵底与卡片阴影、水印、渐变头部、虚线分隔线、骨架屏脉冲），扁平工具类仍在下方 `className`。
// - `.agent-badge::before/::after` 水印：两条伪元素共用一组声明（仅 `top` 不同），现写在 `AgentBadge.css`；
//   `content` 的四段 `attr(data-badge-name)` 之间是两个空格。
// - `.skill-tag` 的暗色规则源文件用 `@media (prefers-color-scheme: dark)`，迁移时记的是「跟随系统偏好」。
//   2026-09-23 全站强制亮色后，两个主题入口都声明了 `@custom-variant dark (&:where(.dark, .dark *))`：
//   `dark:` 变体（含下方 `SKILL_TAG_CLASS` 的 `dark:border-white/8` 等）改为与 `.dark` token 块同源的
//   类作用域，再没有任何代码会自动加上该类，故这些变体在应用内不会命中——保留而不删除。
// - 骨架屏的 `agent-badge-pulse` 动画定义仍在 `web/css/chat-animations.css`
//   （`@keyframes` 属 CSS，本仓库动画定义统一留在样式表内），按名引用它的 `animation` 写在 `AgentBadge.css`。
// - 类名不复用源 `.agent-badge*` / `.skill-tag`：宿主 `apps/web/src/index.css` 仍有同名的旧规则，
//   复用会让那批已下线的声明重新命中；迁移守卫也把源类名列为「不得回流」。故用组件前缀的新语义名。
// =============================================================================

/**
 * 工牌容器（源 `.agent-badge`）：点阵底、卡片阴影、水印伪元素与「子元素抬到水印之上」的层叠
 * 都在 `AgentBadge.css`（同一条规则即可表达，无需再拆单独的常量）。
 */
const BADGE_CLASS =
  "agent-badge-card relative flex min-h-85 w-56 flex-col overflow-hidden rounded-lg border border-border";

/** 渐变头部（源 `.agent-badge-header`）：渐变底与挂绳孔内阴影在 `AgentBadge.css`。 */
const BADGE_HEADER_CLASS = cn(
  "agent-badge-banner relative shrink-0 px-4.5 pt-6 pb-8 text-center",
  "after:absolute after:top-3 after:left-1/2 after:h-3.5 after:w-3.5 after:-translate-x-1/2 after:rounded-full",
  "after:bg-slate-300 after:content-['']",
);

const BADGE_TAG_CLASS =
  "inline-block rounded-full bg-white/18 px-3.5 py-1 text-3xs font-bold tracking-widest text-white uppercase backdrop-blur-xs";

const BADGE_BODY_CLASS = "flex flex-1 flex-col items-center justify-center px-5";

const BADGE_AVATAR_CLASS =
  "relative z-[2] -mt-7.5 flex h-12.5 w-12.5 shrink-0 items-center justify-center rounded-full border-3 border-white bg-white shadow-[0_0_0_1.5px_var(--color-border,#e2e8f0),0_2px_12px_rgba(23,89,220,0.08)]";

const BADGE_NAME_CLASS = "mt-1 shrink-0 text-xs font-bold text-text-primary";

const BADGE_SOURCE_CLASS = "mt-2 shrink-0 text-3xs tracking-widest text-text-muted uppercase";

const BADGE_DESC_CLASS = "mt-1.25 shrink-0 text-center text-3xs leading-normal text-text-muted";

/** 分隔线（源 `.agent-badge-divider` 的 `::before`/`::after` 虚线段，声明在 `AgentBadge.css`）。 */
const BADGE_DIVIDER_CLASS = "agent-badge-rule mx-5 flex shrink-0 items-center";

const BADGE_DOTS_CLASS = "mx-2.5 flex gap-1.5";

const BADGE_DOT_CLASS = "h-1.25 w-1.25 shrink-0 rounded-full bg-slate-300";

const BADGE_SKILLS_CLASS = "flex shrink-0 flex-col items-center gap-2 px-5 pt-2.5 pb-4.5";

const BADGE_SKILLS_LABEL_CLASS = "text-3xs font-bold tracking-widest text-text-muted uppercase";

const BADGE_SKILLS_ROW_CLASS = "flex max-w-full flex-nowrap justify-center gap-1.5 overflow-hidden";

const BADGE_SKILLS_HINT_CLASS = "text-3xs text-text-muted";

const BADGE_SKILLS_NONE_CLASS = "text-xs text-text-muted";

/**
 * 技能标签（源 `:where(.agent-badge) .skill-tag`）。
 *
 * 交互态与静态态的 hover 声明互相冲突（源靠规则先后决定：静态态在文件后部、胜出），故按状态二选一，
 * 由 `cn()` 的后者胜出保证结果确定。
 */
const SKILL_TAG_CLASS = cn(
  "inline-flex shrink-0 items-center rounded-full border border-border bg-surface-2 px-2.25 py-0.75",
  "font-display text-3xs leading-snug whitespace-nowrap text-text-secondary",
  "[transition:background_0.15s,border-color_0.15s,color_0.15s]",
  "dark:border-white/8 dark:bg-white/6",
);

const SKILL_TAG_INTERACTIVE_CLASS = cn(
  "cursor-pointer hover:border-[var(--color-border-hover,#d1d5db)] hover:bg-surface-3 hover:text-text-primary",
  "dark:hover:border-white/16 dark:hover:bg-white/12",
);

const SKILL_TAG_STATIC_CLASS = "cursor-default hover:border-border hover:bg-surface-2 hover:text-text-secondary";

const BADGE_ACTIONS_CLASS = "flex shrink-0 gap-1 px-5 pt-2.5 pb-3.5";

const BADGE_ACTION_CLASS = cn(
  "flex h-6.5 flex-1 cursor-pointer items-center justify-center gap-0.5 rounded-md border border-slate-200",
  "bg-white text-3xs font-semibold text-slate-500 [transition:background_0.15s,border-color_0.15s]",
  "hover:border-slate-300 hover:text-brand disabled:cursor-not-allowed disabled:opacity-60",
);

const BADGE_ACTION_PRIMARY_CLASS = "border-none bg-brand text-white hover:bg-blue-600";

/** 骨架屏共用的脉冲动画（`@keyframes agent-badge-pulse` 定义在 `../css/chat-animations.css`，按名引用写在 `AgentBadge.css`）。 */
const SKELETON_ANIMATION_CLASS = "agent-badge-skeleton-pulse";

const SKELETON_CIRCLE_CLASS =
  "agent-badge-skeleton-avatar h-12.5 w-12.5 shrink-0 rounded-full border-3 border-white bg-border";

const SKELETON_LINE_CLASS = "shrink-0 rounded-md bg-border";

const SKELETON_TAG_CLASS = "shrink-0 rounded-full bg-surface-2";

/** 工牌卡技能条目（仅展示所需字段）。复制自源 `AgentBadge.tsx`。 */
export interface AgentSkillInfo {
  id: string;
  label: string;
}

/**
 * 工牌卡 — 空状态/管理模式共用。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/AgentBadge.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
 * 纯化改动点：非管理模式下点击技能标签原本派发 window `chat:inject-skill` 事件，
 * 现改为调用 `onInjectSkill`（宿主自行决定注入实现，如写入 Composer）。
 */
export function AgentBadge({
  name,
  description,
  skills,
  // 管理模式 props（全部可选，向后兼容）
  status,
  onEnter,
  onEdit,
  isBusy,
  // 外部 Agent：来源组织名
  sourceOrg,
  onInjectSkill,
}: {
  name: string;
  description?: string;
  skills: AgentSkillInfo[];
  status?: "running" | "stopped";
  onEnter?: () => void;
  onEdit?: () => void;
  isBusy?: boolean;
  sourceOrg?: string;
  /** 点击技能标签时回调（替代 window `chat:inject-skill` 事件总线） */
  onInjectSkill?: (skillName: string) => void;
}) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  // 管理模式激活条件：任一管理 prop 存在
  const isManagement = status !== undefined || onEnter !== undefined || onEdit !== undefined;

  const badge = (
    <div className={BADGE_CLASS} data-badge-name={name} data-slot="agent-badge">
      {/* 渐变头部 + 挂绳孔 */}
      <div className={BADGE_HEADER_CLASS}>
        <span className={BADGE_TAG_CLASS}>AGENT</span>
      </div>

      {/* 头像 + 名称 + 描述 */}
      <div className={BADGE_BODY_CLASS}>
        <div className={BADGE_AVATAR_CLASS}>
          <AgentLogo size={24} />
        </div>
        {sourceOrg && <div className={BADGE_SOURCE_CLASS}>{sourceOrg}</div>}
        <div className={BADGE_NAME_CLASS}>{name}</div>
        {description && <div className={BADGE_DESC_CLASS}>{description}</div>}
      </div>

      {/* 分隔线 */}
      <div className={BADGE_DIVIDER_CLASS}>
        <span className={BADGE_DOTS_CLASS}>
          <span className={BADGE_DOT_CLASS} />
          <span className={BADGE_DOT_CLASS} />
          <span className={BADGE_DOT_CLASS} />
        </span>
      </div>

      {/* Skills 区 — 管理模式下去掉 label/hint 和点击交互 */}
      <div className={BADGE_SKILLS_CLASS}>
        {skills.length > 0 ? (
          <>
            {!isManagement && (
              <span className={BADGE_SKILLS_LABEL_CLASS}>📚 {t("chat.components.chatEmpty.skills")}</span>
            )}
            <div className={BADGE_SKILLS_ROW_CLASS}>
              {skills.map((s) =>
                isManagement ? (
                  <span key={s.id} className={cn(SKILL_TAG_CLASS, SKILL_TAG_STATIC_CLASS)}>
                    {s.label}
                  </span>
                ) : (
                  <button
                    type="button"
                    key={s.id}
                    className={cn(SKILL_TAG_CLASS, SKILL_TAG_INTERACTIVE_CLASS)}
                    onClick={() => onInjectSkill?.(s.label)}
                  >
                    {s.label}
                  </button>
                ),
              )}
            </div>
            {!isManagement && (
              <span className={BADGE_SKILLS_HINT_CLASS}>{t("chat.components.chatEmpty.skillsHint")}</span>
            )}
          </>
        ) : (
          <>
            <span className={BADGE_SKILLS_NONE_CLASS}>{t("chat.components.chatEmpty.noSkills")}</span>
            {!isManagement && (
              <span className={BADGE_SKILLS_HINT_CLASS}>{t("chat.components.chatEmpty.skillsHint")}</span>
            )}
          </>
        )}
      </div>

      {/* 管理模式：操作按钮 */}
      {isManagement && (onEnter || onEdit) && (
        <div className={BADGE_ACTIONS_CLASS}>
          {onEnter && (
            <button
              type="button"
              disabled={isBusy}
              onClick={onEnter}
              className={cn(BADGE_ACTION_CLASS, BADGE_ACTION_PRIMARY_CLASS)}
            >
              {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <MessageSquare className="h-3 w-3" />}
              {t("chat.components.agentBadge.enterChat")}
            </button>
          )}
          {onEdit && (
            <button type="button" disabled={isBusy} onClick={onEdit} className={BADGE_ACTION_CLASS}>
              <Pencil className="h-3 w-3" />
              {t("chat.components.agentBadge.edit")}
            </button>
          )}
        </div>
      )}
    </div>
  );

  // 管理模式：直接返回 badge（由外层管理布局）
  if (isManagement) return badge;
  // 空状态模式：居中展示
  return <div className="flex size-full items-center justify-center p-8">{badge}</div>;
}

/**
 * 工牌骨架屏 — 加载态。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/AgentBadge.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除）；纯化改动点：无。
 */
export function AgentBadgeSkeleton() {
  return (
    <div className="flex size-full items-center justify-center p-8">
      <div className={BADGE_CLASS} data-badge-name="" data-slot="agent-badge">
        <div className={BADGE_HEADER_CLASS}>
          <span className={BADGE_TAG_CLASS}>AGENT</span>
        </div>
        <div className={BADGE_BODY_CLASS}>
          <div className={cn(SKELETON_CIRCLE_CLASS, SKELETON_ANIMATION_CLASS)} />
          <div
            className={cn(SKELETON_LINE_CLASS, SKELETON_ANIMATION_CLASS)}
            style={{ width: 100, height: 13, marginTop: 10 }}
          />
          <div
            className={cn(SKELETON_LINE_CLASS, SKELETON_ANIMATION_CLASS)}
            style={{ width: 160, height: 12, marginTop: 8 }}
          />
        </div>
        <div className={BADGE_DIVIDER_CLASS}>
          <span className={BADGE_DOTS_CLASS}>
            <span className={BADGE_DOT_CLASS} />
            <span className={BADGE_DOT_CLASS} />
            <span className={BADGE_DOT_CLASS} />
          </span>
        </div>
        <div className={BADGE_SKILLS_CLASS}>
          <div className={cn(SKELETON_LINE_CLASS, SKELETON_ANIMATION_CLASS)} style={{ width: 80, height: 12 }} />
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <div className={cn(SKELETON_TAG_CLASS, SKELETON_ANIMATION_CLASS)} style={{ width: 72, height: 24 }} />
            <div className={cn(SKELETON_TAG_CLASS, SKELETON_ANIMATION_CLASS)} style={{ width: 56, height: 24 }} />
            <div className={cn(SKELETON_TAG_CLASS, SKELETON_ANIMATION_CLASS)} style={{ width: 48, height: 24 }} />
          </div>
        </div>
      </div>
    </div>
  );
}
