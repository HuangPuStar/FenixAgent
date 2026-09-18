/**
 * 标签过滤输入（源实现来自记忆模块 hindsight 数据视图，组件名保持 `TagFilterInput`）。
 *
 * 来源：`packages/resources/memory/web/pages/hindsight/components/TagFilterInput.tsx`。
 *
 * 纯化取舍：
 * - i18n 命名空间由宿主 `NS.HINDSIGHT` 换为包内 `UI_COMPONENTS_NS`，并把三个宿主键改为包内键：
 *   `dataView.filterByTagPlaceholder` → `tagInput.placeholder`、`dataView.removeTag` → `tagInput.removeTag`、
 *   `common.clear` → `tagInput.clear`（文案值逐字复制进包内字典，en / zh 同步）；
 * - `common.clear` 上原本挂的 `defaultValue: "Clear"` 一并去掉：入包后包内字典是唯一真相来源，
 *   保留英文兜底会在英文之外的语言缺失时提供一个与字典不一致的第二处文案；
 * - 组件结构、样式类名与交互（Enter / 逗号提交、Backspace 删除末尾标签、`#` 前缀展示）逐字保留。
 */
import { Tag, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { UI_COMPONENTS_NS } from "../lib/i18n";
import { Button } from "./button";
import { Input } from "./input";

interface TagFilterInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  className?: string;
}

/** 标签过滤输入组件 — 简化版，不含 API 自动补全 */
export function TagFilterInput({ value, onChange, placeholder, className }: TagFilterInputProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const resolvedPlaceholder = placeholder ?? t("tagInput.placeholder");
  const [input, setInput] = useState("");

  const addTag = (tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed || value.includes(trimmed)) {
      setInput("");
      return;
    }
    onChange([...value, trimmed]);
    setInput("");
  };

  const removeTag = (tag: string) => {
    onChange(value.filter((existing) => existing !== tag));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (input.trim()) {
        addTag(input);
      }
      return;
    }
    if (e.key === "Backspace" && !input && value.length > 0) {
      removeTag(value[value.length - 1]);
    }
  };

  return (
    <div className={`flex items-center gap-2 flex-wrap ${className ?? ""}`}>
      <div className="relative w-56">
        <Tag className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={resolvedPlaceholder}
          className="pl-8 h-9"
        />
      </div>

      {value.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {value.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md bg-primary/10 text-primary border border-primary/20 font-medium leading-none"
            >
              <span className="opacity-50 select-none font-mono">#</span>
              {tag}
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => removeTag(tag)}
                className="ml-0.5 size-4 opacity-50 hover:opacity-100"
                aria-label={t("tagInput.removeTag", { tag })}
              >
                <X className="size-3" />
              </Button>
            </span>
          ))}
          <Button variant="link" size="xs" onClick={() => onChange([])} className="text-muted-foreground">
            {t("tagInput.clear")}
          </Button>
        </div>
      )}
    </div>
  );
}
