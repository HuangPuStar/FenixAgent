import { ChevronsUpDown } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface SearchableUsageFilterOption {
  value: string;
  label: string;
}

interface SearchableUsageFilterProps {
  allLabel: string;
  emptyLabel: string;
  options: SearchableUsageFilterOption[];
  searchPlaceholder: string;
  triggerClassName?: string;
  value: string;
  onSearchChange?: (keyword: string) => void;
  onValueChange: (value: string) => void;
}

/** 消耗统计的主体筛选器：支持输入检索并可一键清空。 */
export function SearchableUsageFilter({
  allLabel,
  emptyLabel,
  options,
  searchPlaceholder,
  triggerClassName,
  value,
  onSearchChange,
  onValueChange,
}: SearchableUsageFilterProps) {
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
