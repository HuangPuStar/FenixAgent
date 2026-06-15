import { Tag, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Input } from "@/components/ui/input";
import { NS } from "@/src/i18n";

interface TagFilterInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  className?: string;
}

/** 标签过滤输入组件 — 简化版，不含 API 自动补全 */
export function TagFilterInput({ value, onChange, placeholder, className }: TagFilterInputProps) {
  const { t } = useTranslation(NS.HINDSIGHT);
  const resolvedPlaceholder = placeholder ?? t("dataView.filterByTagPlaceholder");
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
              <button
                type="button"
                onClick={() => removeTag(tag)}
                className="opacity-50 hover:opacity-100 transition-opacity ml-0.5"
                aria-label={t("dataView.removeTag", { tag })}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-xs text-muted-foreground hover:text-foreground underline"
          >
            {t("common.clear", { defaultValue: "Clear" })}
          </button>
        </div>
      )}
    </div>
  );
}
