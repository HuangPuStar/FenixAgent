// web/src/pages/admin/components/OrganizationSelect.tsx
// 资源池归属组织选择器（可搜索 + 一键回到「全局可用」）。自原 AdminSandboxPage.tsx 拆出。
//
// 与消耗统计里的筛选器（SearchableUsageFilter）形状相似但接口不同：这里的值是 `string | null`
// 且 null 有明确业务含义（全局可用），筛选器只有空串。合并会让 null 语义被压平，故各自独立。

import { Button } from "@fenix/ui-components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@fenix/ui-components/ui/command";
import { Input } from "@fenix/ui-components/ui/input";
import { Label } from "@fenix/ui-components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@fenix/ui-components/ui/popover";
import { Check, ChevronsUpDown } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { SANDBOX_NS } from "../../../../i18n/namespace";
import type { SystemOrganizationOption } from "../../../api/system-organizations";

interface OrganizationSelectProps {
  value: string | null;
  organizations: SystemOrganizationOption[];
  disabled?: boolean;
  onChange: (value: string | null) => void;
}

export function OrganizationSelect({ value, organizations, disabled = false, onChange }: OrganizationSelectProps) {
  const { t } = useTranslation(SANDBOX_NS);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = organizations.find((organization) => organization.id === value);
  const keyword = query.trim().toLowerCase();
  const filteredOrganizations = organizations.filter((organization) =>
    [organization.name, organization.id, organization.slug].some((field) => field.toLowerCase().includes(keyword)),
  );
  const label = selected
    ? t("nameWithId", { name: selected.name, id: selected.id })
    : value
      ? t("organizationUnknown", { id: value })
      : t("organizationGlobal");

  // 只读态：池详情里不允许改归属，用 disabled Input 展示而非禁用整个 Popover。
  if (disabled) {
    return (
      <div>
        <Label>{t("organization")}</Label>
        <Input readOnly aria-label={t("organization")} value={label} className="mt-1" />
      </div>
    );
  }

  return (
    <div>
      <Label>{t("organization")}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-label={t("organization")}
            aria-expanded={open}
            disabled={disabled}
            className="mt-1 w-full justify-between"
          >
            <span className="truncate text-left">{label}</span>
            <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
          {/* shouldFilter=false：本地过滤已包含 name/id/slug 三字段，交给 cmdk 会让 slug 不可搜。 */}
          <Command shouldFilter={false}>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder={t("organizationSearch")}
              aria-label={t("organizationSearch")}
            />
            <CommandList
              className="h-64 max-h-64 overflow-y-auto overscroll-contain"
              onWheel={(event) => event.stopPropagation()}
            >
              {filteredOrganizations.length === 0 && keyword ? (
                <CommandEmpty>{t("organizationEmpty")}</CommandEmpty>
              ) : null}
              <CommandGroup>
                <CommandItem
                  value="__global__"
                  onSelect={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                >
                  <Check className={`mr-2 size-4 ${value === null ? "opacity-100" : "opacity-0"}`} />
                  {t("organizationGlobal")}
                </CommandItem>
                {filteredOrganizations.map((organization) => (
                  <CommandItem
                    key={organization.id}
                    value={`${organization.name} ${organization.id} ${organization.slug}`}
                    onSelect={() => {
                      onChange(organization.id);
                      setOpen(false);
                    }}
                  >
                    <Check className={`mr-2 size-4 ${value === organization.id ? "opacity-100" : "opacity-0"}`} />
                    <span className="min-w-0">
                      <span className="block truncate">{organization.name}</span>
                      <span className="block truncate text-xs text-text-muted">{organization.id}</span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
