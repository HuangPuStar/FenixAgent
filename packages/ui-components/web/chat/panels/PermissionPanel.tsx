// =============================================================================
// 权限请求面板 — 固定在输入框上方（Anthropic warm token style）
//
// 复制自 packages/agent-runtime/web/components/chat/PermissionPanel.tsx（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
// 纯化改动：PendingPermission 改从包内 ../types 导入（不依赖 @fenix/* 与宿主 @/src）；
//   cn 改为包内 ../../lib/cn；Button 改为包内 ../../ui/button；
//   i18n 由宿主 ns=components 收敛到 UI_COMPONENTS_NS 的 chat.components.* key。
//   视觉、结构、交互与 data-* 契约均未改动。
//
// 深层样式（两条子代选择器）下沉到同目录 `./PermissionPanel.css`，语义类名为
// `.chat-permission-badge`（图标徽标）与 `.chat-permission-audit-note`（审计脚注），
// 源选择器分别是 `.chat-interaction-icon svg` 与 `.chat-permission-audit svg`。
// =============================================================================

import "./PermissionPanel.css";

import { KeyRound, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { Button } from "../../ui/button";
import type { PendingPermission } from "../types";
import { ChatInteractionRegion, ChatInteractionStack } from "./chat-interaction-region";

interface PermissionPanelProps {
  requests: PendingPermission[];
  onRespond?: (requestId: string, optionId: string | null) => void;
  className?: string;
}

/**
 * 权限请求面板：把待确认的 ACP 权限请求渲染成输入框上方的暖色警示卡片列表。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/PermissionPanel.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
 * 纯化改动：类型、cn、Button 与 i18n 改为包内导入；请求数据与应答全部由 props 注入，
 * 组件自身不订阅任何传输或会话状态；空列表返回 null（不占位）。
 */
export function PermissionPanel({ requests, onRespond, className }: PermissionPanelProps) {
  if (requests.length === 0) return null;

  return (
    <ChatInteractionStack className={className}>
      {requests.map((req) => (
        <PermissionCard key={req.requestId} request={req} onRespond={onRespond} />
      ))}
    </ChatInteractionStack>
  );
}

// =============================================================================
// 单个权限卡片 — warm warning tokens + left-border accent
// =============================================================================

interface PermissionCardProps {
  request: PendingPermission;
  onRespond?: (requestId: string, optionId: string | null) => void;
}

function PermissionCard({ request, onRespond }: PermissionCardProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const [collapsed, setCollapsed] = useState(false);
  const inputSummary = Object.keys(request.toolInput).length > 0 ? JSON.stringify(request.toolInput) : null;
  return (
    <ChatInteractionRegion
      slot="chat-permission-region"
      label={t("chat.components.permissionPanel.title")}
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed((value) => !value)}
      badge={
        // 源 `.chat-interaction-icon`（25px 方块 + 14px 图标；图标尺寸在 ./PermissionPanel.css）。
        <span className="chat-permission-badge grid h-6.25 w-6.25 place-items-center rounded-md bg-indigo-50 text-blue-600">
          <KeyRound />
        </span>
      }
      title={t("chat.components.permissionPanel.title")}
      hint={t("chat.components.permissionPanel.waiting")}
      footer={(request.options ?? []).map((option) => (
        <Button
          key={option.optionId}
          type="button"
          variant={option.kind.startsWith("reject") ? "ghost" : option.kind === "allow_once" ? "default" : "outline"}
          size="sm"
          onClick={() => onRespond?.(request.requestId, option.optionId)}
        >
          {option.name}
        </Button>
      ))}
    >
      <div>
        <span className="block text-3xs text-gray-400">{t("chat.components.permissionPanel.aboutToRun")}</span>
        <strong className="mt-0.75 block text-sm text-slate-700">{request.toolName}</strong>
        {request.description && <p className="mt-0.75 text-xs text-slate-500">{request.description}</p>}
      </div>
      {inputSummary && (
        <code className="mt-2.25 block overflow-hidden rounded-md bg-slate-100 px-2.5 py-2 text-3xs text-ellipsis whitespace-nowrap text-gray-500">
          {inputSummary}
        </code>
      )}
      {/* 源 `.chat-permission-audit`（13px 图标尺寸在 ./PermissionPanel.css）。 */}
      <p className="chat-permission-audit-note mt-2 flex items-center gap-1.25 text-3xs text-slate-400">
        <ShieldCheck />
        {t("chat.components.permissionPanel.audit")}
      </p>
    </ChatInteractionRegion>
  );
}
