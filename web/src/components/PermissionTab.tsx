import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { skillConfigApi } from "@/src/api/sdk";
import type { PermissionAction } from "../types/config";

// ── 常量定义 ──

/** 开关型工具列表 */
const TOGGLE_TOOLS = ["todowrite", "question", "webfetch", "websearch", "codesearch", "doom_loop"] as const;

/** 规则型工具列表 */
const RULE_TOOLS = ["read", "edit", "glob", "grep", "list", "bash", "task", "external_directory", "lsp"] as const;

// ── 内部状态类型 ──

type ToggleValue = PermissionAction | "";
interface RuleEntry {
  pattern: string;
  action: PermissionAction;
}
interface RuleToolState {
  global: ToggleValue;
  rules: RuleEntry[];
}
interface SkillPermState {
  global: ToggleValue;
  rules: RuleEntry[];
}

// ── 初始化辅助：从 permission prop 解析内部状态（仅在组件挂载时调用一次） ──

function parsePermission(permission: Record<string, unknown> | null | undefined): {
  globalStrategy: ToggleValue;
  toggleTools: Record<string, ToggleValue>;
  ruleTools: Record<string, RuleToolState>;
  skillPerm: SkillPermState;
  skillValues: Record<string, ToggleValue>;
} {
  if (!permission || typeof permission === "string") {
    return {
      globalStrategy: (permission as unknown as ToggleValue) ?? "",
      toggleTools: Object.fromEntries(TOGGLE_TOOLS.map((t) => [t, ""] as const)) as Record<string, ToggleValue>,
      ruleTools: Object.fromEntries(
        RULE_TOOLS.map((t) => [t, { global: "" as ToggleValue, rules: [] as RuleEntry[] }]),
      ) as Record<string, RuleToolState>,
      skillPerm: { global: "", rules: [] } as SkillPermState,
      skillValues: {} as Record<string, ToggleValue>,
    };
  }
  const perm = permission as Record<string, unknown>;
  const newToggle: Record<string, ToggleValue> = {};
  for (const tool of TOGGLE_TOOLS) {
    const val = perm[tool];
    newToggle[tool] = val === "ask" || val === "allow" || val === "deny" ? val : "";
  }
  const newRule: Record<string, RuleToolState> = {};
  for (const tool of RULE_TOOLS) {
    const val = perm[tool];
    if (val === "ask" || val === "allow" || val === "deny") {
      newRule[tool] = { global: val, rules: [] };
    } else if (val && typeof val === "object") {
      const rules = Object.entries(val as Record<string, unknown>)
        .filter(([, v]) => v === "ask" || v === "allow" || v === "deny")
        .map(([pattern, action]) => ({ pattern, action: action as PermissionAction }));
      newRule[tool] = { global: "", rules };
    } else {
      newRule[tool] = { global: "", rules: [] };
    }
  }
  let skillPerm: SkillPermState = { global: "", rules: [] };
  const skillValues: Record<string, ToggleValue> = {};
  const skillVal = perm.skill;
  if (skillVal === "ask" || skillVal === "allow" || skillVal === "deny") {
    skillPerm = { global: skillVal, rules: [] };
  } else if (skillVal && typeof skillVal === "object") {
    const rules: RuleEntry[] = [];
    for (const [pattern, action] of Object.entries(skillVal as Record<string, unknown>)) {
      if (action === "ask" || action === "allow" || action === "deny") {
        if (pattern.includes("*")) {
          rules.push({ pattern, action });
        } else {
          skillValues[pattern] = action;
        }
      }
    }
    skillPerm = { global: "", rules };
  }
  return { globalStrategy: "" as ToggleValue, toggleTools: newToggle, ruleTools: newRule, skillPerm, skillValues };
}

// ── Props 接口 ──

interface PermissionTabProps {
  agentName: string;
  permission: Record<string, unknown> | null | undefined;
  onPermissionChange: (permission: Record<string, unknown> | null) => void;
}

export function PermissionTab({ agentName: _agentName, permission, onPermissionChange }: PermissionTabProps) {
  const { t } = useTranslation("components");

  // Permission options built from translations
  const PERMISSION_OPTIONS = [
    { value: "", label: t("permission.notSet") },
    { value: "ask", label: t("permission.ask") },
    { value: "allow", label: t("permission.allow") },
    { value: "deny", label: t("permission.deny") },
  ] as const;

  const RULE_ACTION_OPTIONS = [
    { value: "ask", label: t("permission.ask") },
    { value: "allow", label: t("permission.allow") },
    { value: "deny", label: t("permission.deny") },
  ] as const;

  // ── 状态（仅初始化一次，不再双向同步 prop） ──
  const [initialParsed] = useState(() => parsePermission(permission));
  const [globalStrategy, setGlobalStrategy] = useState<ToggleValue>(initialParsed.globalStrategy);
  const [toggleTools, setToggleTools] = useState<Record<string, ToggleValue>>(initialParsed.toggleTools);
  const [ruleTools, setRuleTools] = useState<Record<string, RuleToolState>>(initialParsed.ruleTools);
  const [skillPerm, setSkillPerm] = useState<SkillPermState>(initialParsed.skillPerm);
  const [skillNames, setSkillNames] = useState<string[]>([]);
  const [skillValues, setSkillValues] = useState<Record<string, ToggleValue>>(initialParsed.skillValues);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [skillLoading, setSkillLoading] = useState(false);

  // ── 加载 skill 列表 ──
  useEffect(() => {
    let cancelled = false;
    setSkillLoading(true);
    skillConfigApi
      .list()
      .then(({ data }) => {
        if (!cancelled) {
          const skills = Array.isArray(data) ? data : [];
          const names = skills.map((s: Record<string, unknown>) => String(s.name ?? ""));
          setSkillNames(names);
          setSkillValues((prev) => {
            const next = { ...prev };
            for (const name of names) {
              if (!(name in next)) next[name] = "";
            }
            return next;
          });
        }
      })
      .catch(() => {
        if (!cancelled) setSkillNames([]);
      })
      .finally(() => {
        if (!cancelled) setSkillLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── 通用通知辅助：状态更新后通知父组件 ──
  const notifyParent = useCallback(
    (
      nextToggle: typeof toggleTools,
      nextRule: typeof ruleTools,
      nextSkillPerm: typeof skillPerm,
      nextSkillValues: typeof skillValues,
      nextGlobal: typeof globalStrategy,
    ) => {
      if (nextGlobal) {
        // 全局策略展开为所有工具的对象，不发送裸字符串
        const result: Record<string, unknown> = {};
        for (const tool of TOGGLE_TOOLS) result[tool] = nextGlobal;
        for (const tool of RULE_TOOLS) result[tool] = nextGlobal;
        result.skill = nextGlobal;
        onPermissionChange(result);
        return;
      }
      const result: Record<string, unknown> = {};
      for (const tool of TOGGLE_TOOLS) {
        const val = nextToggle[tool];
        if (val) result[tool] = val;
      }
      for (const tool of RULE_TOOLS) {
        const state = nextRule[tool];
        if (state.global) {
          result[tool] = state.global;
        } else if (state.rules.length > 0) {
          const ruleMap: Record<string, PermissionAction> = {};
          for (const r of state.rules) {
            if (r.pattern) ruleMap[r.pattern] = r.action;
          }
          if (Object.keys(ruleMap).length > 0) result[tool] = ruleMap;
        }
      }
      const skillEntries: Record<string, PermissionAction> = {};
      for (const name of skillNames) {
        const val = nextSkillValues[name];
        if (val) skillEntries[name] = val;
      }
      for (const r of nextSkillPerm.rules) {
        if (r.pattern) skillEntries[r.pattern] = r.action;
      }
      if (nextSkillPerm.global) {
        result.skill = nextSkillPerm.global;
      } else if (Object.keys(skillEntries).length > 0) {
        result.skill = skillEntries;
      }
      onPermissionChange(Object.keys(result).length > 0 ? result : null);
    },
    [skillNames, onPermissionChange],
  );

  // ── 开关型工具变更 ──
  const handleToggleChange = (tool: string, value: string) => {
    const next = { ...toggleTools, [tool]: value as ToggleValue };
    setToggleTools(next);
    notifyParent(next, ruleTools, skillPerm, skillValues, globalStrategy);
  };

  // ── 规则型工具全局策略变更 ──
  const handleRuleGlobalChange = (tool: string, value: string) => {
    const next = {
      ...ruleTools,
      [tool]: { ...ruleTools[tool], global: value as ToggleValue },
    };
    setRuleTools(next);
    notifyParent(toggleTools, next, skillPerm, skillValues, globalStrategy);
  };

  // ── 规则型工具展开/折叠 ──
  const toggleExpand = (tool: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(tool)) next.delete(tool);
      else next.add(tool);
      return next;
    });
  };

  // ── 规则型工具: 添加规则 ──
  const handleAddRule = (tool: string) => {
    const updated: Record<string, RuleToolState> = {
      ...ruleTools,
      [tool]: {
        ...ruleTools[tool],
        rules: [...ruleTools[tool].rules, { pattern: "", action: "deny" }],
      },
    };
    setRuleTools(updated);
    notifyParent(toggleTools, updated, skillPerm, skillValues, globalStrategy);
    setExpandedTools((prev) => new Set(prev).add(tool));
  };

  // ── 规则型工具: 更新规则 pattern ──
  const handleRulePatternChange = (tool: string, index: number, pattern: string) => {
    const rules = [...ruleTools[tool].rules];
    rules[index] = { ...rules[index], pattern };
    const next = { ...ruleTools, [tool]: { ...ruleTools[tool], rules } };
    setRuleTools(next);
    notifyParent(toggleTools, next, skillPerm, skillValues, globalStrategy);
  };

  // ── 规则型工具: 更新规则 action ──
  const handleRuleActionChange = (tool: string, index: number, action: string) => {
    const rules = [...ruleTools[tool].rules];
    rules[index] = { ...rules[index], action: action as PermissionAction };
    const next = { ...ruleTools, [tool]: { ...ruleTools[tool], rules } };
    setRuleTools(next);
    notifyParent(toggleTools, next, skillPerm, skillValues, globalStrategy);
  };

  // ── 规则型工具: 删除规则 ──
  const handleDeleteRule = (tool: string, index: number) => {
    const rules = ruleTools[tool].rules.filter((_, i) => i !== index);
    const next = { ...ruleTools, [tool]: { ...ruleTools[tool], rules } };
    setRuleTools(next);
    notifyParent(toggleTools, next, skillPerm, skillValues, globalStrategy);
  };

  // ── Skill 精确名称权限变更 ──
  const handleSkillValueChange = (name: string, value: string) => {
    const next = { ...skillValues, [name]: value as ToggleValue };
    setSkillValues(next);
    notifyParent(toggleTools, ruleTools, skillPerm, next, globalStrategy);
  };

  // ── Skill 全局策略变更 ──
  const handleSkillGlobalChange = (value: string) => {
    const next = { ...skillPerm, global: value as ToggleValue };
    setSkillPerm(next);
    notifyParent(toggleTools, ruleTools, next, skillValues, globalStrategy);
  };

  // ── Skill 自定义规则: 添加 ──
  const handleAddSkillRule = () => {
    const next: SkillPermState = {
      ...skillPerm,
      rules: [...skillPerm.rules, { pattern: "", action: "deny" }],
    };
    setSkillPerm(next);
    notifyParent(toggleTools, ruleTools, next, skillValues, globalStrategy);
  };

  // ── Skill 自定义规则: 更新 pattern ──
  const handleSkillRulePatternChange = (index: number, pattern: string) => {
    const rules = [...skillPerm.rules];
    rules[index] = { ...rules[index], pattern };
    const next = { ...skillPerm, rules };
    setSkillPerm(next);
    notifyParent(toggleTools, ruleTools, next, skillValues, globalStrategy);
  };

  // ── Skill 自定义规则: 更新 action ──
  const handleSkillRuleActionChange = (index: number, action: string) => {
    const rules = [...skillPerm.rules];
    rules[index] = { ...rules[index], action: action as PermissionAction };
    const next = { ...skillPerm, rules };
    setSkillPerm(next);
    notifyParent(toggleTools, ruleTools, next, skillValues, globalStrategy);
  };

  // ── Skill 自定义规则: 删除 ──
  const handleDeleteSkillRule = (index: number) => {
    const next = {
      ...skillPerm,
      rules: skillPerm.rules.filter((_, i) => i !== index),
    };
    setSkillPerm(next);
    notifyParent(toggleTools, ruleTools, next, skillValues, globalStrategy);
  };

  return (
    <div className="space-y-6 max-h-[55vh] overflow-y-auto pt-2">
      {/* ── 全局策略 ── */}
      <div>
        <Label className="text-sm font-medium">{t("permission.globalStrategy")}</Label>
        <p className="text-xs text-muted-foreground mb-1">{t("permission.globalStrategyDesc")}</p>
        <Select
          value={globalStrategy}
          onValueChange={(v) => {
            const next = v === "__unset__" ? "" : (v as ToggleValue);
            setGlobalStrategy(next);
            notifyParent(toggleTools, ruleTools, skillPerm, skillValues, next);
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder={t("permission.notSet")} />
          </SelectTrigger>
          <SelectContent>
            {PERMISSION_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value || "__unset__"}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* ── 工具权限 ── */}
      <div>
        <div className="text-sm font-medium mb-3 border-b pb-1">{t("permission.toolPermissions")}</div>

        {/* 开关型工具 */}
        <div className="space-y-2 mb-4">
          <div className="text-xs text-muted-foreground">{t("permission.toggleTools")}</div>
          {TOGGLE_TOOLS.map((tool) => (
            <div key={tool} className="flex items-center gap-3">
              <span className="text-sm w-36 font-mono">{tool}</span>
              <Select
                value={toggleTools[tool] || "__unset__"}
                onValueChange={(v) => handleToggleChange(tool, v === "__unset__" ? "" : v)}
              >
                <SelectTrigger className="w-32">
                  <SelectValue placeholder={t("permission.notSet")} />
                </SelectTrigger>
                <SelectContent>
                  {PERMISSION_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value || "__unset__"}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>

        {/* 规则型工具 */}
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">{t("permission.ruleTools")}</div>
          {RULE_TOOLS.map((tool) => (
            <Collapsible key={tool} open={expandedTools.has(tool)} onOpenChange={() => toggleExpand(tool)}>
              <div className="flex items-center gap-3">
                <span className="text-sm w-36 font-mono">{tool}</span>
                <Select
                  value={ruleTools[tool]?.global || "__unset__"}
                  onValueChange={(v) => handleRuleGlobalChange(tool, v === "__unset__" ? "" : v)}
                >
                  <SelectTrigger className="w-32">
                    <SelectValue placeholder={t("permission.notSet")} />
                  </SelectTrigger>
                  <SelectContent>
                    {PERMISSION_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value || "__unset__"}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" type="button">
                    {expandedTools.has(tool) ? t("permission.collapse") : t("permission.expand")}
                  </Button>
                </CollapsibleTrigger>
              </div>
              <CollapsibleContent>
                <div className="ml-40 mt-1 space-y-2 border-l-2 border-muted pl-3">
                  {ruleTools[tool]?.rules.map((rule, idx) => (
                    <div key={rule.pattern} className="flex items-center gap-2">
                      <Input
                        value={rule.pattern}
                        onChange={(e) => handleRulePatternChange(tool, idx, e.target.value)}
                        placeholder={t("permission.wildcardPlaceholder")}
                        className="w-44 h-8 text-sm"
                      />
                      <span className="text-muted-foreground text-xs">&rarr;</span>
                      <Select value={rule.action} onValueChange={(v) => handleRuleActionChange(tool, idx, v)}>
                        <SelectTrigger className="w-24 h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {RULE_ACTION_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button variant="ghost" size="sm" type="button" onClick={() => handleDeleteRule(tool, idx)}>
                        &times;
                      </Button>
                    </div>
                  ))}
                  <Button variant="outline" size="sm" type="button" onClick={() => handleAddRule(tool)}>
                    {t("permission.addRule")}
                  </Button>
                </div>
              </CollapsibleContent>
            </Collapsible>
          ))}
        </div>
      </div>

      {/* ── Skill 权限 ── */}
      <div>
        <div className="text-sm font-medium mb-3 border-b pb-1">{t("permission.skillPermissions")}</div>
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <span className="text-sm w-36">{t("permission.globalStrategy")}</span>
            <Select
              value={skillPerm.global || "__unset__"}
              onValueChange={(v) => handleSkillGlobalChange(v === "__unset__" ? "" : v)}
            >
              <SelectTrigger className="w-32">
                <SelectValue placeholder={t("permission.notSet")} />
              </SelectTrigger>
              <SelectContent>
                {PERMISSION_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value || "__unset__"}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {skillLoading && <div className="text-xs text-muted-foreground py-2">{t("permission.loadingSkills")}</div>}

          {!skillLoading &&
            skillNames.map((name) => (
              <div key={name} className="flex items-center gap-3">
                <span className="text-sm w-36 truncate" title={name}>
                  {name}
                </span>
                <Select
                  value={skillValues[name] || "__unset__"}
                  onValueChange={(v) => handleSkillValueChange(name, v === "__unset__" ? "" : v)}
                >
                  <SelectTrigger className="w-32">
                    <SelectValue placeholder={t("permission.notSet")} />
                  </SelectTrigger>
                  <SelectContent>
                    {PERMISSION_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value || "__unset__"}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}

          {/* 自定义规则 */}
          <div className="text-xs text-muted-foreground mt-3 pt-2 border-t">{t("permission.customRules")}</div>
          {skillPerm.rules.map((rule, idx) => (
            <div key={rule.pattern || `rule-${idx}`} className="flex items-center gap-2">
              <Input
                value={rule.pattern}
                onChange={(e) => handleSkillRulePatternChange(idx, e.target.value)}
                placeholder={t("permission.skillWildcardPlaceholder")}
                className="w-44 h-8 text-sm"
              />
              <span className="text-muted-foreground text-xs">&rarr;</span>
              <Select value={rule.action} onValueChange={(v) => handleSkillRuleActionChange(idx, v)}>
                <SelectTrigger className="w-24 h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RULE_ACTION_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="ghost" size="sm" type="button" onClick={() => handleDeleteSkillRule(idx)}>
                &times;
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" type="button" onClick={handleAddSkillRule}>
            {t("permission.addCustomRule")}
          </Button>
        </div>
      </div>
    </div>
  );
}
