import { Check, ChevronDown, ChevronUp, Shield } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { Button } from "../../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import type { SessionMode } from "../types";

/**
 * Session Mode Selector — 从 agent 动态获取的会话模式下拉选择器。
 *
 * 来源：复制自 `packages/agent-runtime/web/components/chat/SessionModeSelector.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
 *
 * 归属说明：该文件不在输入岛组的分组清单内，但它是 `composer-toolbar.tsx`（readOnly 用法）
 * 的唯一消费方，且没有任何并行分组负责复制它——为保证输入岛可用，本组一并复制到
 * `composer/`。若集成阶段决定把它归入 `panels/` 或 `shell/`，只需移动文件并同步
 * `composer-toolbar.tsx` 的一行 import（文件内部只依赖 `../../ui/*`、`../types` 与 `../../i18n/namespace`）。
 *
 * 纯化改动点：`@fenix/chat-channel` 的 `SessionMode` → 包内 `../types`；
 * `@/components/ui/{button,popover}` → 包内 `../../ui/*`；命名空间改为 `UI_COMPONENTS_NS`
 * （键 `chat.components.sessionModeSelector.default`）；结构、交互与类名逐字保留。
 */

interface SessionModeSelectorProps {
  modes: SessionMode[];
  currentModeId: string | null;
  onModeChange: (modeId: string) => void;
  /** 只读模式：仅展示当前模式名，不渲染下拉与切换交互 */
  readOnly?: boolean;
}

/**
 * 当 modes 为空时返回 null（不渲染任何内容），避免在无模式数据时占据布局空间。
 * readOnly 为 true 时降级为静态信息 chip（保留模式名，去掉下拉框）。
 */
export function SessionModeSelector({
  modes,
  currentModeId,
  onModeChange,
  readOnly = false,
}: SessionModeSelectorProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const [open, setOpen] = useState(false);
  const current = modes.find((m) => m.id === currentModeId) ?? modes[0];

  if (modes.length === 0) return null;

  // 只读：静态展示当前模式名，无下拉、无 hover、不可点击
  if (readOnly) {
    const label = current?.name ?? t("chat.components.sessionModeSelector.default");
    return (
      <span
        className="inline-flex h-7 max-w-[132px] min-w-0 items-center gap-[5px] px-[7px] text-[11px] leading-none text-[#7b8799] [@media(max-width:720px)]:px-[5px]"
        data-slot="chat-composer-security-policy"
        title={label}
      >
        <Shield className="h-[13px] w-[13px] flex-[0_0_13px] text-[#909bab]" />
        <span className="overflow-hidden text-ellipsis whitespace-nowrap [@media(max-width:720px)]:hidden">
          {label}
        </span>
      </span>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground hover:text-foreground h-7 px-2">
          <Shield className="h-3 w-3" />
          <span className="max-w-24 truncate">{current?.name ?? t("chat.components.sessionModeSelector.default")}</span>
          {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1" align="start">
        {modes.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => {
              onModeChange(m.id);
              setOpen(false);
            }}
            className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-surface-2 transition-colors"
          >
            <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center">
              {currentModeId === m.id && <Check className="h-3.5 w-3.5 text-brand" />}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-text-primary">{m.name}</div>
              {m.description && <div className="text-xs text-text-muted">{m.description}</div>}
            </div>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
