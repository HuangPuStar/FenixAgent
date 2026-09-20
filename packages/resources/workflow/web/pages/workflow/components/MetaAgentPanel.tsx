import { ChatPanel } from "@fenix/agent-runtime";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface MetaAgentPanelProps {
  /** 面板是否展开 */
  chatOpen: boolean;
  /** 设置面板展开状态 */
  setChatOpen: (open: boolean) => void;
  /** Meta Agent environment ID */
  metaAgentId: string | null;
  /** 可选的场景提示，workflow 场景传入 workflow 上下文，skills 场景不传 */
  scenePrompt?: string;
  /** 上下文标识：变化时自动触发新会话 */
  contextKey?: string;
  /** 会话完成后的回调，如刷新数据 */
  onPromptComplete?: () => void;
  /**
   * toggle 拉手按钮位置。
   * - `"right"`（默认）：拉手在面板右侧，适用于面板在画布左侧的场景
   * - `"left"`：拉手在面板左侧
   */
  togglePosition?: "left" | "right";
}

/**
 * Meta Agent 嵌入式聊天面板（工作流编辑器右侧/左侧拉手）。
 *
 * **为什么本组件住在工作流包**：搬迁前它位于宿主 `apps/web/components/MetaAgentPanel.tsx`，唯一消费方是
 * `WorkflowEditor`（`grep -rn "MetaAgentPanel" apps packages` 仅命中该处），属于工作流编辑器自身的视图，
 * 按「键/组件归属消费方域」迁入本包；否则包内 `WorkflowEditor` 必须 import 宿主路径，违反静态条件 2
 * （包 `web/**` 不得出现 `@/`）。宿主那份与 `.meta-agent-*` 样式清理登记在任务 1.3 的 sharedPatches。
 *
 * **依赖边界**：聊天实现来自 `@fenix/agent-runtime` 的**根**浏览器出口（`ChatPanel` 与 YJS/会话状态同批导出，
 * 且宿主 Vite 已把它指向同一份实现），因此这里只负责「拉手 + 面板外壳」，不复制会话/连接逻辑，
 * 也不会产生第二份 ACP 连接。收起时整块卸载面板，避免保持连接。
 *
 * **样式约定**：`meta-agent-panel` / `meta-agent-toggle-btn` 两个类名是宿主窄屏样式（`apps/web/src/index.css`
 * 的 `.meta-agent-panel .acp-main-root` 等作用域收紧规则）的钩子，故意保持不变；这批窄屏规则的归属收敛
 * 同属 sharedPatches（宿主改动不由本包执行）。
 */
export function MetaAgentPanel({
  chatOpen,
  setChatOpen,
  metaAgentId,
  scenePrompt,
  contextKey,
  onPromptComplete,
  togglePosition = "right",
}: MetaAgentPanelProps) {
  const { t } = useTranslation("workflows");

  const isLeft = togglePosition === "left";

  // 面板边框方向：拉手在左时面板右边框、拉手在右时面板左边框（贴拉手侧无边框）
  const panelBorder = isLeft
    ? { borderRight: "1px solid var(--color-border-subtle)" }
    : { borderLeft: "1px solid var(--color-border-subtle)" };

  // 拉手箭头的语义：
  // - 拉手在左：展开态显示右箭头（收起面板）、收起态显示左箭头（展开面板）
  // - 拉手在右：展开态显示左箭头（收起面板）、收起态显示右箭头（展开面板）
  const chevronIcon = (() => {
    if (chatOpen) return isLeft ? <ChevronRight size={14} /> : <ChevronLeft size={14} />;
    return isLeft ? <ChevronLeft size={14} /> : <ChevronRight size={14} />;
  })();

  const toggleBtn = (
    <button
      type="button"
      className={`meta-agent-toggle-btn${chatOpen ? " open" : ""}${isLeft ? " left" : ""}`}
      onClick={() => setChatOpen(!chatOpen)}
      title={chatOpen ? t("editor.chat_collapse") : t("editor.chat_expand")}
      aria-label={chatOpen ? t("editor.chat_collapse") : t("editor.chat_expand")}
      aria-expanded={chatOpen}
    >
      {chevronIcon}
    </button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "row", height: "100%" }}>
      {/* 拉手在左时先渲染拉手 */}
      {isLeft && toggleBtn}

      {/* 主面板 — 仅在展开时渲染，避免收起后继续持有 ACP 连接 */}
      {chatOpen && (
        <div
          // meta-agent-panel：作为窄屏样式的作用域钩子（宿主 index.css 按该类名收紧 padding、隐藏 avatar、
          // 简化 ChatComposer 元信息条），类名不可随意重命名
          className="meta-agent-panel"
          style={{
            width: 400,
            minWidth: 400,
            display: "flex",
            flexDirection: "column",
            background: "#fff",
            ...panelBorder,
            position: "relative",
          }}
        >
          {/* 聊天区域 — ChatHeader 内部已提供历史会话 popover，无需外层 header */}
          <div style={{ flex: 1, overflow: "hidden" }}>
            <ChatPanel
              agentId={metaAgentId}
              hideSidebar
              scenePrompt={scenePrompt}
              contextKey={contextKey}
              onPromptComplete={onPromptComplete}
            />
          </div>
        </div>
      )}

      {/* 拉手在右时在后面渲染拉手 */}
      {!isLeft && toggleBtn}
    </div>
  );
}
