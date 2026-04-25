import { describe, test, expect } from "bun:test";
import type { ProviderInfo, ModelEntry, ModelConfig, AgentInfo, SkillInfo, ApiResponse } from "../types/config";

describe("config types", () => {
  test("ApiResponse success structure", () => {
    const response: ApiResponse<{ name: string }> = { success: true, data: { name: "test" } };
    expect(response.success).toBe(true);
    expect(response.data?.name).toBe("test");
  });

  test("ApiResponse error structure", () => {
    const response: ApiResponse<never> = { success: false, error: { code: "NOT_FOUND", message: "Not found" } };
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe("NOT_FOUND");
  });
});

import type { PermissionAction, RuleBasedPermission, PermissionObjectConfig, PermissionConfig, AgentDetail, ModelConfig } from "../types/config";

// ── PermissionConfig 类型编译验证 ──

describe("PermissionConfig types", () => {
  test("PermissionAction 接受 ask/allow/deny 字面量", () => {
    const ask: PermissionAction = "ask";
    const allow: PermissionAction = "allow";
    const deny: PermissionAction = "deny";
    expect([ask, allow, deny]).toEqual(["ask", "allow", "deny"]);
  });

  test("RuleBasedPermission 接受字符串和 pattern 映射", () => {
    const str: RuleBasedPermission = "allow";
    const map: RuleBasedPermission = { "*.env": "deny", "*.ts": "allow" };
    expect(str).toBe("allow");
    expect(map).toEqual({ "*.env": "deny", "*.ts": "allow" });
  });

  test("PermissionObjectConfig 可构建完整的工具权限对象", () => {
    const config: PermissionObjectConfig = {
      read: { "*.secret": "deny" },
      edit: "allow",
      bash: "deny",
      skill: { "internal-*": "allow", "pr-review": "deny" },
      todowrite: "ask",
      webfetch: "deny",
      doom_loop: "allow",
    };
    expect(config.read).toEqual({ "*.secret": "deny" });
    expect(config.todowrite).toBe("ask");
  });

  test("PermissionConfig 接受全局字符串策略", () => {
    const global: PermissionConfig = "ask";
    expect(global).toBe("ask");
  });

  test("PermissionConfig 接受对象模式", () => {
    const obj: PermissionConfig = { bash: "deny", read: { "*.env": "deny" } };
    expect(obj).toEqual({ bash: "deny", read: { "*.env": "deny" } });
  });

  // ── AgentDetail 新字段类型验证 ──

  test("AgentDetail 包含新字段且类型正确", () => {
    const detail: AgentDetail = {
      name: "test",
      builtIn: false,
      model: "gpt-4o",
      prompt: "You are a helper",
      tools: null,
      steps: 50,
      mode: "primary",
      permission: { bash: "allow" },
      variant: "thinking",
      temperature: 0.7,
      top_p: 0.9,
      disable: false,
      hidden: true,
      color: "#FF5500",
      description: "测试代理",
    };
    expect(detail.variant).toBe("thinking");
    expect(detail.temperature).toBe(0.7);
    expect(detail.top_p).toBe(0.9);
    expect(detail.disable).toBe(false);
    expect(detail.hidden).toBe(true);
    expect(detail.color).toBe("#FF5500");
    expect(detail.description).toBe("测试代理");
  });

  test("AgentDetail 新字段可为 null（除 disable 和 hidden）", () => {
    const detail: AgentDetail = {
      name: "test",
      builtIn: false,
      model: null,
      prompt: null,
      tools: null,
      steps: null,
      mode: null,
      permission: null,
      variant: null,
      temperature: null,
      top_p: null,
      disable: false,
      hidden: false,
      color: null,
      description: null,
    };
    expect(detail.variant).toBeNull();
    expect(detail.temperature).toBeNull();
    expect(detail.top_p).toBeNull();
    expect(detail.disable).toBe(false);
    expect(detail.hidden).toBe(false);
  });

  // ── AgentInfo 新字段类型验证 ──

  test("AgentInfo 包含 description 和 color 字段", () => {
    const info: AgentInfo = {
      name: "build",
      builtIn: true,
      model: "claude-sonnet-4-6",
      mode: "primary",
      description: "构建代理",
      color: "primary",
    };
    expect(info.description).toBe("构建代理");
    expect(info.color).toBe("primary");
  });

  test("AgentInfo description 和 color 可为 null", () => {
    const info: AgentInfo = {
      name: "test",
      builtIn: false,
      model: null,
      mode: null,
      description: null,
      color: null,
    };
    expect(info.description).toBeNull();
    expect(info.color).toBeNull();
  });

  // ── ModelConfig 新增 permission 字段验证 ──

  test("ModelConfig.current 包含 permission 字段", () => {
    const config: ModelConfig = {
      current: {
        model: "gpt-4o",
        small_model: "gpt-4o-mini",
        permission: { bash: "deny" },
      },
      available: [],
    };
    expect(config.current.permission).toEqual({ bash: "deny" });
  });

  test("ModelConfig.current.permission 可为 null", () => {
    const config: ModelConfig = {
      current: {
        model: null,
        small_model: null,
        permission: null,
      },
      available: [],
    };
    expect(config.current.permission).toBeNull();
  });

  test("ModelConfig.current.permission 可为全局字符串", () => {
    const config: ModelConfig = {
      current: {
        model: null,
        small_model: null,
        permission: "ask",
      },
      available: [],
    };
    expect(config.current.permission).toBe("ask");
  });
});

import type { PermissionObjectConfig, PermissionConfig } from "../types/config";

// ── PermissionTab 数据流验证 ──

describe("PermissionTab data flow", () => {
  test("PermissionObjectConfig 全 16 个工具字段可同时赋值", () => {
    const full: PermissionObjectConfig = {
      read: "allow", edit: "allow", glob: "allow", grep: "allow",
      list: "allow", bash: "allow", task: "allow",
      external_directory: "allow", lsp: "allow", skill: "allow",
      todowrite: "ask", question: "ask", webfetch: "ask",
      websearch: "ask", codesearch: "ask", doom_loop: "ask",
    };
    expect(Object.keys(full)).toHaveLength(16);
  });

  test("PermissionConfig 混合模式: 规则型通配符 + 开关型三态 + skill 规则", () => {
    const perm: PermissionConfig = {
      read: { "*.env": "deny" },
      edit: "allow",
      bash: { "rm *": "deny" },
      todowrite: "ask",
      skill: { "pr-review": "deny", "internal-*": "allow" },
    };
    expect(perm).toBeDefined();
    expect(typeof perm).toBe("object");
  });
});
