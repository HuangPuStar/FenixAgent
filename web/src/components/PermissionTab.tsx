import { useState, useEffect, useCallback, useRef } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { apiListSkills } from "../api/client";
import type { PermissionAction, PermissionObjectConfig } from "../types/config";

// ── 常量定义 ──

/** 开关型工具列表 */
const TOGGLE_TOOLS = [
  "todowrite", "question", "webfetch", "websearch", "codesearch", "doom_loop",
] as const;

/** 规则型工具列表 */
const RULE_TOOLS = [
  "read", "edit", "glob", "grep", "list", "bash", "task", "external_directory", "lsp",
] as const;

/** Select 选项: 未设置 + 三态 */
const PERMISSION_OPTIONS = [
  { value: "", label: "未设置" },
  { value: "ask", label: "ask" },
  { value: "allow", label: "allow" },
  { value: "deny", label: "deny" },
] as const;

/** 规则型 Select 选项（排除"未设置"，使用全局策略兜底） */
const RULE_ACTION_OPTIONS = [
  { value: "ask", label: "ask" },
  { value: "allow", label: "allow" },
  { value: "deny", label: "deny" },
] as const;

// ── 内部状态类型 ──

type ToggleValue = PermissionAction | "";
interface RuleEntry { pattern: string; action: PermissionAction; }
interface RuleToolState { global: ToggleValue; rules: RuleEntry[]; }
interface SkillPermState { global: ToggleValue; rules: RuleEntry[]; }

// ── Props 接口 ──

interface PermissionTabProps {
  agentName: string;
  permission: Record<string, unknown> | null | undefined;
  onPermissionChange: (permission: Record<string, unknown> | null) => void;
}

export function PermissionTab({ agentName, permission, onPermissionChange }: PermissionTabProps) {
  // ── 状态 ──
  const [globalStrategy, setGlobalStrategy] = useState<ToggleValue>("");
  const [toggleTools, setToggleTools] = useState<Record<string, ToggleValue>>(() =>
    Object.fromEntries(TOGGLE_TOOLS.map(t => [t, ""]))
  );
  const [ruleTools, setRuleTools] = useState<Record<string, RuleToolState>>(() =>
    Object.fromEntries(RULE_TOOLS.map(t => [t, { global: "", rules: [] }]))
  );
  const [skillPerm, setSkillPerm] = useState<SkillPermState>({ global: "", rules: [] });
  const [skillNames, setSkillNames] = useState<string[]>([]);
  const [skillValues, setSkillValues] = useState<Record<string, ToggleValue>>({});
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [skillLoading, setSkillLoading] = useState(false);

  // ── 从 permission prop 解析为 UI 状态 ──
  const lastSentRef = useRef<string>("");
  useEffect(() => {
    lastSentRef.current = JSON.stringify(permission);
  }, [permission]);
  useEffect(() => {
    if (!permission || typeof permission === "string") {
      setGlobalStrategy((permission as ToggleValue) ?? "");
      setToggleTools(Object.fromEntries(TOGGLE_TOOLS.map(t => [t, ""])));
      setRuleTools(Object.fromEntries(RULE_TOOLS.map(t => [t, { global: "", rules: [] }])));
      setSkillPerm({ global: "", rules: [] });
      setSkillValues({});
      return;
    }
    setGlobalStrategy("");
    const perm = permission as Record<string, unknown>;
    // 开关型工具
    const newToggle: Record<string, ToggleValue> = {};
    for (const tool of TOGGLE_TOOLS) {
      const val = perm[tool];
      newToggle[tool] = (val === "ask" || val === "allow" || val === "deny") ? val : "";
    }
    setToggleTools(prev => ({ ...Object.fromEntries(TOGGLE_TOOLS.map(t => [t, ""])), ...newToggle }));
    // 规则型工具
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
    setRuleTools(prev => ({ ...Object.fromEntries(RULE_TOOLS.map(t => [t, { global: "", rules: [] }])), ...newRule }));
    // Skill 权限
    const skillVal = perm["skill"];
    if (skillVal === "ask" || skillVal === "allow" || skillVal === "deny") {
      setSkillPerm({ global: skillVal, rules: [] });
      setSkillValues({});
    } else if (skillVal && typeof skillVal === "object") {
      const rules: RuleEntry[] = [];
      const values: Record<string, ToggleValue> = {};
      for (const [pattern, action] of Object.entries(skillVal as Record<string, unknown>)) {
        if (action === "ask" || action === "allow" || action === "deny") {
          if (pattern.includes("*")) {
            rules.push({ pattern, action });
          } else {
            values[pattern] = action;
          }
        }
      }
      setSkillPerm({ global: "", rules });
      setSkillValues(values);
    } else {
      setSkillPerm({ global: "", rules: [] });
      setSkillValues({});
    }
  }, [permission]);

  // ── 加载 skill 列表 ──
  useEffect(() => {
    let cancelled = false;
    setSkillLoading(true);
    apiListSkills()
      .then(skills => {
        if (!cancelled) {
          const names = skills.map(s => s.name);
          setSkillNames(names);
          setSkillValues(prev => {
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
    return () => { cancelled = true; };
  }, [agentName]);

  // ── 通用通知辅助：状态更新后通知父组件 ──
  const notifyParent = useCallback((
    nextToggle: typeof toggleTools,
    nextRule: typeof ruleTools,
    nextSkillPerm: typeof skillPerm,
    nextSkillValues: typeof skillValues,
    nextGlobal: typeof globalStrategy,
  ) => {
    // Build permission inline to use latest values
    if (nextGlobal) {
      const serialized = JSON.stringify(nextGlobal as unknown as Record<string, unknown>);
      if (serialized !== lastSentRef.current) {
        lastSentRef.current = serialized;
        onPermissionChange(nextGlobal as unknown as Record<string, unknown>);
      }
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
      result["skill"] = nextSkillPerm.global;
    } else if (Object.keys(skillEntries).length > 0) {
      result["skill"] = skillEntries;
    }
    const perm = Object.keys(result).length > 0 ? result : null;
    const serialized = JSON.stringify(perm);
    if (serialized !== lastSentRef.current) {
      lastSentRef.current = serialized;
      onPermissionChange(perm);
    }
  }, [skillNames, onPermissionChange]);

  // ── 开关型工具变更 ──
  const handleToggleChange = (tool: string, value: string) => {
    setToggleTools(prev => {
      const next = { ...prev, [tool]: value as ToggleValue };
      notifyParent(next, ruleTools, skillPerm, skillValues, globalStrategy);
      return next;
    });
  };

  // ── 规则型工具全局策略变更 ──
  const handleRuleGlobalChange = (tool: string, value: string) => {
    setRuleTools(prev => {
      const next = {
        ...prev,
        [tool]: { ...prev[tool], global: value as ToggleValue },
      };
      notifyParent(toggleTools, next, skillPerm, skillValues, globalStrategy);
      return next;
    });
  };

  // ── 规则型工具展开/折叠 ──
  const toggleExpand = (tool: string) => {
    setExpandedTools(prev => {
      const next = new Set(prev);
      if (next.has(tool)) next.delete(tool);
      else next.add(tool);
      return next;
    });
  };

  // ── 规则型工具: 添加规则 ──
  const handleAddRule = (tool: string) => {
    setRuleTools(prev => {
      const next = {
        ...prev,
        [tool]: {
          ...prev[tool],
          rules: [...prev[tool].rules, { pattern: "", action: "deny" }],
        },
      };
      notifyParent(toggleTools, next, skillPerm, skillValues, globalStrategy);
      return next;
    });
    setExpandedTools(prev => new Set(prev).add(tool));
  };

  // ── 规则型工具: 更新规则 pattern ──
  const handleRulePatternChange = (tool: string, index: number, pattern: string) => {
    setRuleTools(prev => {
      const rules = [...prev[tool].rules];
      rules[index] = { ...rules[index], pattern };
      const next = { ...prev, [tool]: { ...prev[tool], rules } };
      notifyParent(toggleTools, next, skillPerm, skillValues, globalStrategy);
      return next;
    });
  };

  // ── 规则型工具: 更新规则 action ──
  const handleRuleActionChange = (tool: string, index: number, action: string) => {
    setRuleTools(prev => {
      const rules = [...prev[tool].rules];
      rules[index] = { ...rules[index], action: action as PermissionAction };
      const next = { ...prev, [tool]: { ...prev[tool], rules } };
      notifyParent(toggleTools, next, skillPerm, skillValues, globalStrategy);
      return next;
    });
  };

  // ── 规则型工具: 删除规则 ──
  const handleDeleteRule = (tool: string, index: number) => {
    setRuleTools(prev => {
      const rules = prev[tool].rules.filter((_, i) => i !== index);
      const next = { ...prev, [tool]: { ...prev[tool], rules } };
      notifyParent(toggleTools, next, skillPerm, skillValues, globalStrategy);
      return next;
    });
  };

  // ── Skill 精确名称权限变更 ──
  const handleSkillValueChange = (name: string, value: string) => {
    setSkillValues(prev => {
      const next = { ...prev, [name]: value as ToggleValue };
      notifyParent(toggleTools, ruleTools, skillPerm, next, globalStrategy);
      return next;
    });
  };

  // ── Skill 全局策略变更 ──
  const handleSkillGlobalChange = (value: string) => {
    setSkillPerm(prev => {
      const next = { ...prev, global: value as ToggleValue };
      notifyParent(toggleTools, ruleTools, next, skillValues, globalStrategy);
      return next;
    });
  };

  // ── Skill 自定义规则: 添加 ──
  const handleAddSkillRule = () => {
    setSkillPerm(prev => {
      const next = {
        ...prev,
        rules: [...prev.rules, { pattern: "", action: "deny" }],
      };
      notifyParent(toggleTools, ruleTools, next, skillValues, globalStrategy);
      return next;
    });
  };

  // ── Skill 自定义规则: 更新 pattern ──
  const handleSkillRulePatternChange = (index: number, pattern: string) => {
    setSkillPerm(prev => {
      const rules = [...prev.rules];
      rules[index] = { ...rules[index], pattern };
      const next = { ...prev, rules };
      notifyParent(toggleTools, ruleTools, next, skillValues, globalStrategy);
      return next;
    });
  };

  // ── Skill 自定义规则: 更新 action ──
  const handleSkillRuleActionChange = (index: number, action: string) => {
    setSkillPerm(prev => {
      const rules = [...prev.rules];
      rules[index] = { ...rules[index], action: action as PermissionAction };
      const next = { ...prev, rules };
      notifyParent(toggleTools, ruleTools, next, skillValues, globalStrategy);
      return next;
    });
  };

  // ── Skill 自定义规则: 删除 ──
  const handleDeleteSkillRule = (index: number) => {
    setSkillPerm(prev => {
      const next = {
        ...prev,
        rules: prev.rules.filter((_, i) => i !== index),
      };
      notifyParent(toggleTools, ruleTools, next, skillValues, globalStrategy);
      return next;
    });
  };

  return (
    <div className="space-y-6 max-h-[55vh] overflow-y-auto pt-2">
      {/* ── 全局策略 ── */}
      <div>
        <Label className="text-sm font-medium">全局策略</Label>
        <p className="text-xs text-muted-foreground mb-1">
          设置后所有工具继承此策略，未设置则使用 OpenCode 内置默认值
        </p>
        <Select value={globalStrategy} onValueChange={v => {
          const next = v === "__unset__" ? "" : v as ToggleValue;
          setGlobalStrategy(next);
          notifyParent(toggleTools, ruleTools, skillPerm, skillValues, next);
        }}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="未设置" />
          </SelectTrigger>
          <SelectContent>
            {PERMISSION_OPTIONS.map(opt => (
              <SelectItem key={opt.value} value={opt.value || "__unset__"}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* ── 工具权限 ── */}
      <div>
        <div className="text-sm font-medium mb-3 border-b pb-1">工具权限</div>

        {/* 开关型工具 */}
        <div className="space-y-2 mb-4">
          <div className="text-xs text-muted-foreground">开关型工具</div>
          {TOGGLE_TOOLS.map(tool => (
            <div key={tool} className="flex items-center gap-3">
              <span className="text-sm w-36 font-mono">{tool}</span>
              <Select
                value={toggleTools[tool] || "__unset__"}
                onValueChange={v => handleToggleChange(tool, v === "__unset__" ? "" : v)}
              >
                <SelectTrigger className="w-32">
                  <SelectValue placeholder="未设置" />
                </SelectTrigger>
                <SelectContent>
                  {PERMISSION_OPTIONS.map(opt => (
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
          <div className="text-xs text-muted-foreground">规则型工具（支持通配符规则）</div>
          {RULE_TOOLS.map(tool => (
            <Collapsible
              key={tool}
              open={expandedTools.has(tool)}
              onOpenChange={() => toggleExpand(tool)}
            >
              <div className="flex items-center gap-3">
                <span className="text-sm w-36 font-mono">{tool}</span>
                <Select
                  value={ruleTools[tool]?.global || "__unset__"}
                  onValueChange={v => handleRuleGlobalChange(tool, v === "__unset__" ? "" : v)}
                >
                  <SelectTrigger className="w-32">
                    <SelectValue placeholder="未设置" />
                  </SelectTrigger>
                  <SelectContent>
                    {PERMISSION_OPTIONS.map(opt => (
                      <SelectItem key={opt.value} value={opt.value || "__unset__"}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" type="button">
                    {expandedTools.has(tool) ? "收起" : "展开"}
                  </Button>
                </CollapsibleTrigger>
              </div>
              <CollapsibleContent>
                <div className="ml-40 mt-1 space-y-2 border-l-2 border-muted pl-3">
                  {ruleTools[tool]?.rules.map((rule, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <Input
                        value={rule.pattern}
                        onChange={e => handleRulePatternChange(tool, idx, e.target.value)}
                        placeholder="通配符，如 *.env"
                        className="w-44 h-8 text-sm"
                      />
                      <span className="text-muted-foreground text-xs">&rarr;</span>
                      <Select
                        value={rule.action}
                        onValueChange={v => handleRuleActionChange(tool, idx, v)}
                      >
                        <SelectTrigger className="w-24 h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {RULE_ACTION_OPTIONS.map(opt => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        onClick={() => handleDeleteRule(tool, idx)}
                      >
                        &times;
                      </Button>
                    </div>
                  ))}
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    onClick={() => handleAddRule(tool)}
                  >
                    + 添加规则
                  </Button>
                </div>
              </CollapsibleContent>
            </Collapsible>
          ))}
        </div>
      </div>

      {/* ── Skill 权限 ── */}
      <div>
        <div className="text-sm font-medium mb-3 border-b pb-1">Skill 权限</div>
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <span className="text-sm w-36">全局策略</span>
            <Select
              value={skillPerm.global || "__unset__"}
              onValueChange={v => handleSkillGlobalChange(v === "__unset__" ? "" : v)}
            >
              <SelectTrigger className="w-32">
                <SelectValue placeholder="未设置" />
              </SelectTrigger>
              <SelectContent>
                {PERMISSION_OPTIONS.map(opt => (
                  <SelectItem key={opt.value} value={opt.value || "__unset__"}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {skillLoading && (
            <div className="text-xs text-muted-foreground py-2">加载 Skill 列表...</div>
          )}

          {!skillLoading && skillNames.map(name => (
            <div key={name} className="flex items-center gap-3">
              <span className="text-sm w-36 truncate" title={name}>{name}</span>
              <Select
                value={skillValues[name] || "__unset__"}
                onValueChange={v => handleSkillValueChange(name, v === "__unset__" ? "" : v)}
              >
                <SelectTrigger className="w-32">
                  <SelectValue placeholder="未设置" />
                </SelectTrigger>
                <SelectContent>
                  {PERMISSION_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={opt.value || "__unset__"}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}

          {/* 自定义规则 */}
          <div className="text-xs text-muted-foreground mt-3 pt-2 border-t">自定义规则（通配符模式）</div>
          {skillPerm.rules.map((rule, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <Input
                value={rule.pattern}
                onChange={e => handleSkillRulePatternChange(idx, e.target.value)}
                placeholder='通配符，如 "internal-*"'
                className="w-44 h-8 text-sm"
              />
              <span className="text-muted-foreground text-xs">&rarr;</span>
              <Select
                value={rule.action}
                onValueChange={v => handleSkillRuleActionChange(idx, v)}
              >
                <SelectTrigger className="w-24 h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RULE_ACTION_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => handleDeleteSkillRule(idx)}
              >
                &times;
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={handleAddSkillRule}
          >
            + 添加自定义规则
          </Button>
        </div>
      </div>
    </div>
  );
}
