import { Check, ChevronDown, ChevronUp, Cpu } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

/** 会话级模型条目（与 Session Doc modelState.availableModels 结构一致） */
export interface SessionModel {
  /** 引擎模型标识（model.modelId，服务端预选注入/拦截校验都以此为准） */
  modelId: string;
  /** 展示名（displayName，可回退 modelId） */
  name: string;
}

interface SessionModelSelectorProps {
  models: SessionModel[];
  currentModelId: string | null;
  onModelChange: (modelId: string) => void;
}

/**
 * Session Model Selector — 会话级模型下拉选择器（设计 §5.3 运行时切换模型）。
 *
 * 当 models 为空时返回 null（不渲染任何内容），避免在无模型数据时占据布局空间。
 * 切换动作由 ChatPanel 发送 set_session_model，服务端在 SessionChannel 拦截层校验
 * 预选列表（设计 §5.2 保守拒绝），失败经 action_error 回显。
 */
export function SessionModelSelector({ models, currentModelId, onModelChange }: SessionModelSelectorProps) {
  const { t } = useTranslation("components");
  const [open, setOpen] = useState(false);
  const current = models.find((m) => m.modelId === currentModelId) ?? models[0];

  if (models.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground hover:text-foreground h-7 px-2">
          <Cpu className="h-3 w-3" />
          <span className="max-w-24 truncate">{current?.name ?? t("sessionModelSelector.default")}</span>
          {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1" align="start">
        {models.map((m) => (
          <button
            key={m.modelId}
            type="button"
            onClick={() => {
              onModelChange(m.modelId);
              setOpen(false);
            }}
            className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-surface-2 transition-colors"
          >
            <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center">
              {currentModelId === m.modelId && <Check className="h-3.5 w-3.5 text-brand" />}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-text-primary">{m.name}</div>
              {m.modelId !== m.name && <div className="text-xs text-text-muted truncate">{m.modelId}</div>}
            </div>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
