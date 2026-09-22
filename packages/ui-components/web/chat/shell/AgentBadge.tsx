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
// 样式迁移（2026-09-22）：原 `../css/chat-agent-badge.css` 中由本文件渲染的选择器已逐条改写为
// 下方常量与 `className` 的 Tailwind 工具类，数值/色值逐字保持。
// - `.agent-badge::before/::after` 水印用同一条 `[&::before,&::after]:` 变体表达（两条伪元素声明相同，
//   仅 `top` 与 `.before/.after` 不同），`content` 的四段 `attr(data-badge-name)` 用引号内下划线还原空格。
// - `.skill-tag` 的暗色规则源文件用 `@media (prefers-color-scheme: dark)`，包内主题是 `.dark` 类切换，
//   两者语义不同，故保留媒体查询写法（`[@media(prefers-color-scheme:dark)]:`）而非 `dark:`。
// - `.agent-badge-skeleton` 的 `agent-badge-pulse` 动画定义仍在 `../css/chat-agent-badge.css`
//   （`@keyframes` 属 CSS，本仓库动画定义统一留在样式表内），此处只引用动画名。
// =============================================================================

/** 工牌容器（源 `.agent-badge`）：水印伪元素 + 子元素统一 `relative z-1` 层叠。 */
const BADGE_CLASS = cn(
  "relative flex min-h-[340px] w-56 flex-col overflow-hidden rounded-[14px] border border-border",
  "shadow-[0_1px_3px_rgba(0,0,0,0.04),0_4px_16px_rgba(0,0,0,0.03)]",
  "[background:radial-gradient(circle,var(--color-border,#e2e8f0)_0.8px,transparent_0.8px)_0_0/60px_60px,var(--color-surface-1,#fff)]",
  "[&>*]:relative [&>*]:z-[1]",
);

/** 水印伪元素共有声明（源 `.agent-badge::before, .agent-badge::after`）。 */
const BADGE_WATERMARK_CLASS = cn(
  "[&::before,&::after]:pointer-events-none [&::before,&::after]:absolute [&::before,&::after]:inset-x-0",
  "[&::before,&::after]:z-0 [&::before,&::after]:flex [&::before,&::after]:items-center [&::before,&::after]:justify-center",
  "[&::before,&::after]:overflow-hidden [&::before,&::after]:whitespace-nowrap [&::before,&::after]:rotate-[-10deg]",
  "[&::before,&::after]:text-[80px] [&::before,&::after]:font-black [&::before,&::after]:tracking-[-0.02em]",
  "[&::before,&::after]:text-[var(--color-border,#e2e8f0)] [&::before,&::after]:opacity-[0.16]",
  '[&::before,&::after]:content-[attr(data-badge-name)_"__"_attr(data-badge-name)_"__"_attr(data-badge-name)_"__"_attr(data-badge-name)]',
  "[&::before]:top-[41%] [&::after]:top-[80%]",
);

/** 渐变头部（源 `.agent-badge-header`）与挂绳孔伪元素。 */
const BADGE_HEADER_CLASS = cn(
  "relative shrink-0 px-[18px] pt-6 pb-8 text-center",
  "[background:radial-gradient(220px_circle_at_50%_0%,rgba(107,230,255,0.22),transparent_68%),linear-gradient(180deg,#1759dc,#0d2a6e)]",
  "after:absolute after:top-3 after:left-1/2 after:h-3.5 after:w-3.5 after:-translate-x-1/2 after:rounded-full",
  "after:bg-[#cbd5e1] after:shadow-[inset_0_1px_2px_rgba(0,0,0,0.1)] after:content-['']",
);

const BADGE_TAG_CLASS =
  "inline-block rounded-full bg-[rgba(255,255,255,0.18)] px-[14px] py-1 text-[10px] font-bold tracking-[0.15em] text-white uppercase backdrop-blur-[4px]";

const BADGE_BODY_CLASS = "flex flex-1 flex-col items-center justify-center px-5";

const BADGE_AVATAR_CLASS =
  "relative z-[2] -mt-[30px] flex h-[50px] w-[50px] shrink-0 items-center justify-center rounded-full border-[3px] border-white bg-white shadow-[0_0_0_1.5px_var(--color-border,#e2e8f0),0_2px_12px_rgba(23,89,220,0.08)]";

const BADGE_NAME_CLASS = "mt-1 shrink-0 text-[13px] font-bold text-text-primary";

const BADGE_SOURCE_CLASS = "mt-2 shrink-0 text-[9px] tracking-[0.08em] text-text-muted uppercase";

const BADGE_DESC_CLASS = "mt-[5px] shrink-0 text-center text-[10px] leading-[1.5] text-text-muted";

/** 分隔线（源 `.agent-badge-divider` 的 `::before`/`::after` 虚线段）。 */
const BADGE_DIVIDER_CLASS = cn(
  "mx-5 flex shrink-0 items-center",
  "[&::before,&::after]:flex-1 [&::before,&::after]:border-t [&::before,&::after]:border-dashed [&::before,&::after]:border-border",
  "[&::before,&::after]:content-['']",
);

const BADGE_DOTS_CLASS = "mx-2.5 flex gap-1.5";

const BADGE_DOT_CLASS = "h-[5px] w-[5px] shrink-0 rounded-full bg-[#cbd5e1]";

const BADGE_SKILLS_CLASS = "flex shrink-0 flex-col items-center gap-2 px-5 pt-2.5 pb-[18px]";

const BADGE_SKILLS_LABEL_CLASS = "text-[10px] font-bold tracking-[0.12em] text-text-muted uppercase";

const BADGE_SKILLS_ROW_CLASS = "flex max-w-full flex-nowrap justify-center gap-1.5 overflow-hidden";

const BADGE_SKILLS_HINT_CLASS = "text-[10px] text-text-muted";

const BADGE_SKILLS_NONE_CLASS = "text-[12px] text-text-muted";

/**
 * 技能标签（源 `:where(.agent-badge) .skill-tag`）。
 *
 * 交互态与静态态的 hover 声明互相冲突（源靠规则先后决定：静态态在文件后部、胜出），故按状态二选一，
 * 由 `cn()` 的后者胜出保证结果确定。
 */
const SKILL_TAG_CLASS = cn(
  "inline-flex shrink-0 items-center rounded-full border border-border bg-surface-2 px-[9px] py-[3px]",
  "font-display text-[11px] leading-[1.4] whitespace-nowrap text-text-secondary",
  "[transition:background_0.15s,border-color_0.15s,color_0.15s]",
  "[@media(prefers-color-scheme:dark)]:border-[rgba(255,255,255,0.08)] [@media(prefers-color-scheme:dark)]:bg-[rgba(255,255,255,0.06)]",
);

const SKILL_TAG_INTERACTIVE_CLASS = cn(
  "cursor-pointer hover:border-[var(--color-border-hover,#d1d5db)] hover:bg-surface-3 hover:text-text-primary",
  "[@media(prefers-color-scheme:dark)]:hover:border-[rgba(255,255,255,0.16)] [@media(prefers-color-scheme:dark)]:hover:bg-[rgba(255,255,255,0.12)]",
);

const SKILL_TAG_STATIC_CLASS = "cursor-default hover:border-border hover:bg-surface-2 hover:text-text-secondary";

const BADGE_ACTIONS_CLASS = "flex shrink-0 gap-1 px-5 pt-2.5 pb-[14px]";

const BADGE_ACTION_CLASS = cn(
  "flex h-[26px] flex-1 cursor-pointer items-center justify-center gap-0.5 rounded-md border border-[#d9e2ee]",
  "bg-white text-[10px] font-semibold text-[#65748a] [transition:background_0.15s,border-color_0.15s]",
  "hover:border-[#b9cee8] hover:text-brand disabled:cursor-not-allowed disabled:opacity-60",
);

const BADGE_ACTION_PRIMARY_CLASS = "border-none bg-brand text-white hover:bg-[#0f67df]";

/** 骨架屏共用的脉冲动画（`@keyframes agent-badge-pulse` 定义在 `../css/chat-animations.css`）。 */
const SKELETON_ANIMATION_CLASS = "animate-[agent-badge-pulse_2s_cubic-bezier(0.4,0,0.6,1)_infinite]";

const SKELETON_CIRCLE_CLASS =
  "h-[50px] w-[50px] shrink-0 rounded-full border-[3px] border-white bg-border shadow-[0_2px_12px_rgba(0,0,0,0.04)]";

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
    <div className={cn(BADGE_CLASS, BADGE_WATERMARK_CLASS)} data-badge-name={name} data-slot="agent-badge">
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
      <div className={cn(BADGE_CLASS, BADGE_WATERMARK_CLASS)} data-badge-name="" data-slot="agent-badge">
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
