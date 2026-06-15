import { Loader2, MessageSquare, Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";

// =============================================================================
// AgentBadge — 工牌卡组件，双模式：空状态展示（ChatView）+ 管理卡片（AgentManagementPage）
// 渐变头部 + 挂绳孔 + AgentAvatar SVG + 水印 + Skills tag + 可选操作按钮
// =============================================================================

export interface AgentSkillInfo {
  id: string;
  label: string;
}

/** 工牌卡 — 空状态/管理模式共用 */
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
}: {
  name: string;
  description?: string;
  skills: AgentSkillInfo[];
  status?: "running" | "stopped";
  onEnter?: () => void;
  onEdit?: () => void;
  isBusy?: boolean;
  sourceOrg?: string;
}) {
  const { t } = useTranslation("components");
  // 管理模式激活条件：任一管理 prop 存在
  const isManagement = status !== undefined || onEnter !== undefined || onEdit !== undefined;

  const badge = (
    <div className="agent-badge" data-badge-name={name}>
      {/* 渐变头部 + 挂绳孔 */}
      <div className="agent-badge-header">
        <span className="agent-badge-tag">AGENT</span>
      </div>

      {/* 头像 + 名称 + 描述 */}
      <div className="agent-badge-body">
        <div className="agent-badge-avatar">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="6" r="2.5" fill="var(--color-brand)" />
            <circle cx="6" cy="16" r="2.5" fill="var(--color-brand)" opacity=".85" />
            <circle cx="18" cy="16" r="2.5" fill="var(--color-brand)" opacity=".85" />
            <circle cx="12" cy="12" r="1.5" fill="var(--color-brand)" opacity=".6" />
            <line x1="12" y1="8.5" x2="12" y2="10.5" stroke="var(--color-brand)" strokeWidth="1.2" opacity=".5" />
            <line x1="12" y1="13.5" x2="7.2" y2="15.2" stroke="var(--color-brand)" strokeWidth="1.2" opacity=".5" />
            <line x1="12" y1="13.5" x2="16.8" y2="15.2" stroke="var(--color-brand)" strokeWidth="1.2" opacity=".5" />
            <line x1="8.2" y1="16" x2="15.8" y2="16" stroke="var(--color-brand)" strokeWidth="1" opacity=".3" />
          </svg>
        </div>
        {sourceOrg && <div className="agent-badge-source">{sourceOrg}</div>}
        <div className="agent-badge-name">{name}</div>
        {description && <div className="agent-badge-desc">{description}</div>}
      </div>

      {/* 分隔线 */}
      <div className="agent-badge-divider">
        <span className="agent-badge-dots">
          <span className="agent-badge-dot" />
          <span className="agent-badge-dot" />
          <span className="agent-badge-dot" />
        </span>
      </div>

      {/* Skills 区 — 管理模式下去掉 label/hint 和点击交互 */}
      <div className="agent-badge-skills">
        {skills.length > 0 ? (
          <>
            {!isManagement && <span className="agent-badge-skills-label">📚 {t("chatEmpty.skills")}</span>}
            <div className="agent-badge-skills-row">
              {skills.map((s) =>
                isManagement ? (
                  <span key={s.id} className="skill-tag skill-tag-static">
                    {s.label}
                  </span>
                ) : (
                  <button
                    type="button"
                    key={s.id}
                    className="skill-tag"
                    onClick={() =>
                      window.dispatchEvent(new CustomEvent("chat:inject-skill", { detail: { name: s.label } }))
                    }
                  >
                    {s.label}
                  </button>
                ),
              )}
            </div>
            {!isManagement && <span className="agent-badge-skills-hint">{t("chatEmpty.skillsHint")}</span>}
          </>
        ) : (
          <>
            <span className="agent-badge-skills-none">{t("chatEmpty.noSkills")}</span>
            {!isManagement && <span className="agent-badge-skills-hint">{t("chatEmpty.skillsHint")}</span>}
          </>
        )}
      </div>

      {/* 管理模式：操作按钮 */}
      {isManagement && (onEnter || onEdit) && (
        <div className="agent-badge-actions">
          {onEnter && (
            <button
              type="button"
              disabled={isBusy}
              onClick={onEnter}
              className="agent-badge-action agent-badge-action-primary"
            >
              {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <MessageSquare className="h-3 w-3" />}
              {t("agentBadge.enterChat")}
            </button>
          )}
          {onEdit && (
            <button type="button" disabled={isBusy} onClick={onEdit} className="agent-badge-action">
              <Pencil className="h-3 w-3" />
              {t("agentBadge.edit")}
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

/** 工牌骨架屏 — 加载态 */
export function AgentBadgeSkeleton() {
  return (
    <div className="flex size-full items-center justify-center p-8">
      <div className="agent-badge">
        <div className="agent-badge-header">
          <span className="agent-badge-tag">AGENT</span>
        </div>
        <div className="agent-badge-body">
          <div className="agent-badge-skeleton-circle agent-badge-skeleton" />
          <div
            className="agent-badge-skeleton-line agent-badge-skeleton"
            style={{ width: 100, height: 13, marginTop: 10 }}
          />
          <div
            className="agent-badge-skeleton-line agent-badge-skeleton"
            style={{ width: 160, height: 12, marginTop: 8 }}
          />
        </div>
        <div className="agent-badge-divider">
          <span className="agent-badge-dots">
            <span className="agent-badge-dot" />
            <span className="agent-badge-dot" />
            <span className="agent-badge-dot" />
          </span>
        </div>
        <div className="agent-badge-skills">
          <div className="agent-badge-skeleton-line agent-badge-skeleton" style={{ width: 80, height: 12 }} />
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <div className="agent-badge-skeleton-tag agent-badge-skeleton" style={{ width: 72, height: 24 }} />
            <div className="agent-badge-skeleton-tag agent-badge-skeleton" style={{ width: 56, height: 24 }} />
            <div className="agent-badge-skeleton-tag agent-badge-skeleton" style={{ width: 48, height: 24 }} />
          </div>
        </div>
      </div>
    </div>
  );
}
