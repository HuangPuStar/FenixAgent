/**
 * 可检索单选下拉框（源实现名 `SearchableUsageFilter`）。
 *
 * 来源：`packages/resources/sandbox/web/src/pages/admin/components/SearchableUsageFilter.tsx`。
 *
 * 纯化取舍：
 * - 仅把宿主 alias 引用换成包内同目录基础组件（`@/components/ui/{button,command,popover}`），
 *   组件结构、样式类名与交互逻辑逐字保留；
 * - 文案（`allLabel` / `emptyLabel` / `searchPlaceholder`）全部由 props 传入：本组件零 i18n 依赖，
 *   既不读宿主字典也不读包内字典，文案来源由调用方决定；
 * - 原名的 `Usage` 属消耗统计领域词，入包后与组件能力无关，故改名 `SearchableUsageFilter` →
 *   `SearchableSelect`、`SearchableUsageFilterOption` → `SearchableSelectOption`；props 名与行为未变，
 *   宿主迁移时只需同步改名。
 */
import { ChevronsUpDown } from "lucide-react";
import { useState } from "react";

import { Button } from "./button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./command";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

export interface SearchableSelectOption {
  value: string;
  label: string;
}

interface SearchableSelectProps {
  allLabel: string;
  emptyLabel: string;
  options: SearchableSelectOption[];
  searchPlaceholder: string;
  triggerClassName?: string;
  value: string;
  onSearchChange?: (keyword: string) => void;
  onValueChange: (value: string) => void;
}

/** 通用可检索单选下拉框：支持输入检索、检索词回传，并可一键清空回到「全部」。 */
export function SearchableSelect({
  allLabel,
  emptyLabel,
  options,
  searchPlaceholder,
  triggerClassName,
  value,
  onSearchChange,
  onValueChange,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const selectedLabel = options.find((option) => option.value === value)?.label ?? allLabel;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className={`h-8 min-w-0 justify-between px-2 font-normal ${triggerClassName ?? ""}`}>
          <span className="truncate">{selectedLabel}</span>
          <ChevronsUpDown className="ml-2 size-3.5 shrink-0 text-text-muted" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput
            placeholder={searchPlaceholder}
            value={keyword}
            onValueChange={(nextKeyword) => {
              setKeyword(nextKeyword);
              onSearchChange?.(nextKeyword);
            }}
          />
          <CommandList>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value={allLabel}
                onSelect={() => {
                  onValueChange("");
                  setOpen(false);
                }}
              >
                {allLabel}
              </CommandItem>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.label}
                  onSelect={() => {
                    onValueChange(option.value);
                    setOpen(false);
                  }}
                >
                  {option.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
