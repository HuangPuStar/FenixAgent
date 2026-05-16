# Config Route 验证与转换逻辑下沉到 Service 层

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 config 路由中的验证逻辑和数据转换函数下沉到 `src/services/config/` 各子模块，使路由层只负责提取参数、调用 service、格式化 HTTP 响应。

**Architecture:** 在每个 config 子模块中新增 `validate` 函数和 `normalizeXxx` / `toXxxResponse` 转换函数。路由调用 `validate` 后由 service 抛出 `ValidationError`。路由层保留 `configSuccess` / `configError` 响应包装。测试从验证 service 层开始，路由测试保留集成覆盖。

**Tech Stack:** TypeScript, Elysia, Drizzle ORM, Bun test

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/services/config/agent-config.ts` | Modify | 新增 `validateAgentData`, `normalizeAgentData`, `toAgentResponse` |
| `src/services/config/mcp-server.ts` | Modify | 新增 `validateMcpConfig`, `toServerInfo` |
| `src/services/config/provider.ts` | Modify | 新增 `validateProviderData`, `buildModelData` |
| `src/routes/web/config/agents.ts` | Modify | 删除验证/转换函数，改调 service |
| `src/routes/web/config/mcp.ts` | Modify | 删除验证/转换函数，改调 service |
| `src/routes/web/config/providers.ts` | Modify | 删除转换函数，改调 service |
| `src/__tests__/config-agents.test.ts` | Modify | 适配 service 层函数签名变化 |
| `src/__tests__/config-mcp.test.ts` | Modify | 适配 service 层函数签名变化 |
| `src/__tests__/config-providers.test.ts` | Modify | 适配 service 层函数签名变化 |
| `src/__tests__/services/config-agent-config.test.ts` | Create | 新增 service 层验证/转换单元测试 |
| `src/__tests__/services/config-mcp-server.test.ts` | Create | 新增 service 层验证/转换单元测试 |

---

### Task 1: Agent Config — 下沉验证和转换逻辑

**Files:**
- Modify: `src/services/config/agent-config.ts`
- Create: `src/__tests__/services/config-agent-config.test.ts`
- Modify: `src/routes/web/config/agents.ts`

- [ ] **Step 1: 创建 agent-config service 层验证/转换的单元测试**

```typescript
// src/__tests__/services/config-agent-config.test.ts
import { describe, test, expect } from "bun:test";
import {
  validateAgentData,
  normalizeKnowledgeConfig,
  toolsToPermission,
  AGENT_SETTABLE_FIELDS,
} from "../../services/config/agent-config";

describe("validateAgentData", () => {
  test("有效数据返回 null", () => {
    expect(validateAgentData({ model: "gpt-4o", steps: 50, mode: "primary" })).toBeNull();
  });

  test("无效 mode 返回 INVALID_MODE", () => {
    expect(validateAgentData({ mode: "invalid" })).toBe("INVALID_MODE");
  });

  test("无效 steps 返回 INVALID_STEPS", () => {
    expect(validateAgentData({ steps: 999 })).toBe("INVALID_STEPS");
    expect(validateAgentData({ steps: 0 })).toBe("INVALID_STEPS");
    expect(validateAgentData({ steps: 1.5 })).toBe("INVALID_STEPS");
  });

  test("无效 temperature 返回 INVALID_TEMPERATURE", () => {
    expect(validateAgentData({ temperature: -1 })).toBe("INVALID_TEMPERATURE");
    expect(validateAgentData({ temperature: 3 })).toBe("INVALID_TEMPERATURE");
    expect(validateAgentData({ temperature: "hot" as any })).toBe("INVALID_TEMPERATURE");
  });

  test("有效 temperature 边界", () => {
    expect(validateAgentData({ temperature: 0 })).toBeNull();
    expect(validateAgentData({ temperature: 2 })).toBeNull();
  });

  test("无效 top_p 返回 INVALID_TOP_P", () => {
    expect(validateAgentData({ top_p: -0.1 })).toBe("INVALID_TOP_P");
    expect(validateAgentData({ top_p: 1.5 })).toBe("INVALID_TOP_P");
  });

  test("有效 top_p 边界", () => {
    expect(validateAgentData({ top_p: 0 })).toBeNull();
    expect(validateAgentData({ top_p: 1 })).toBeNull();
  });

  test("无效 color 返回 INVALID_COLOR", () => {
    expect(validateAgentData({ color: "notacolor" })).toBe("INVALID_COLOR");
    expect(validateAgentData({ color: "#GGGGGG" })).toBe("INVALID_COLOR");
  });

  test("有效 color — hex 和预设", () => {
    expect(validateAgentData({ color: "#FF5500" })).toBeNull();
    expect(validateAgentData({ color: "primary" })).toBeNull();
  });

  test("无效 permission — string 返回 INVALID_PERMISSION", () => {
    expect(validateAgentData({ permission: "allow" })).toBe("INVALID_PERMISSION");
  });

  test("有效 permission — object", () => {
    expect(validateAgentData({ permission: { bash: "allow" } })).toBeNull();
  });

  test("有效 permission — null", () => {
    expect(validateAgentData({ permission: null })).toBeNull();
  });

  test("无效 knowledge 返回错误码", () => {
    expect(validateAgentData({ knowledge: "bad" })).toBe("INVALID_KNOWLEDGE");
  });

  test("空对象返回 null", () => {
    expect(validateAgentData({})).toBeNull();
  });
});

describe("toolsToPermission", () => {
  test("布尔值映射", () => {
    expect(toolsToPermission({ bash: true, read: false })).toEqual({ bash: "allow", read: "deny" });
  });
});

describe("normalizeKnowledgeConfig", () => {
  test("null 返回 null", () => {
    expect(normalizeKnowledgeConfig(null)).toBeNull();
  });

  test("正常输入去重和 trim", () => {
    const result = normalizeKnowledgeConfig({
      knowledgeBaseIds: ["  kb_a  ", "kb_a", "kb_b"],
      policy: { searchFirst: true, maxResults: 5 },
    });
    expect(result!.knowledgeBaseIds).toEqual(["kb_a", "kb_b"]);
  });
});

describe("AGENT_SETTABLE_FIELDS", () => {
  test("包含 knowledge 字段", () => {
    expect(AGENT_SETTABLE_FIELDS).toContain("knowledge");
  });
  test("不包含非法字段", () => {
    expect(AGENT_SETTABLE_FIELDS).not.toContain("evil");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/__tests__/services/config-agent-config.test.ts`
Expected: FAIL — 函数未导出

- [ ] **Step 3: 在 agent-config.ts 中添加验证和转换函数**

在 `src/services/config/agent-config.ts` 末尾（`export { AGENT_SETTABLE_FIELDS }` 之后）追加以下函数：

```typescript
import { resolveAgentKnowledgePolicy } from "../agent-knowledge";
import type { AgentKnowledgeConfig, AgentKnowledgePolicy } from "../agent-knowledge";

// ────────────────────────────────────────────
// Agent Config 验证与转换
// ────────────────────────────────────────────

type PermissionAction = "ask" | "allow" | "deny";

const BUILT_IN_AGENTS = new Set(["build", "plan", "general", "explore", "title", "summary", "compaction"]);

function isValidMode(mode: string): boolean {
  return ["primary", "subagent", "all"].includes(mode);
}

function isValidSteps(steps: number): boolean {
  return Number.isInteger(steps) && steps >= 1 && steps <= 200;
}

/** 校验 agent 数据字段，返回错误码或 null */
export function validateAgentData(data: Record<string, unknown>): string | null {
  if (data.mode !== undefined && !isValidMode(data.mode as string)) return "INVALID_MODE";
  if (data.steps !== undefined && !isValidSteps(data.steps as number)) return "INVALID_STEPS";
  if (data.temperature !== undefined) {
    const t = data.temperature as number;
    if (typeof t !== "number" || t < 0 || t > 2) return "INVALID_TEMPERATURE";
  }
  if (data.top_p !== undefined) {
    const p = data.top_p as number;
    if (typeof p !== "number" || p < 0 || p > 1) return "INVALID_TOP_P";
  }
  if (data.color !== undefined) {
    const c = data.color as string;
    const PRESET_COLORS = ["primary", "secondary", "accent", "success", "warning", "error", "info"];
    const isHex = /^#[0-9a-fA-F]{6}$/.test(c);
    if (typeof c !== "string" || (!isHex && !PRESET_COLORS.includes(c))) return "INVALID_COLOR";
  }
  if (data.permission !== undefined && data.permission !== null) {
    if (typeof data.permission === "string") return "INVALID_PERMISSION";
    if (typeof data.permission !== "object" || Array.isArray(data.permission)) return "INVALID_PERMISSION";
  }
  if (data.knowledge !== undefined) {
    const error = validateKnowledgeConfig(data.knowledge);
    if (error) return error;
  }
  return null;
}

function validateKnowledgeConfig(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "object") return "INVALID_KNOWLEDGE";

  const config = value as Record<string, unknown>;
  if (!Array.isArray(config.knowledgeBaseIds)) {
    return "INVALID_KNOWLEDGE_BASE_IDS";
  }
  if (config.knowledgeBaseIds.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    return "INVALID_KNOWLEDGE_BASE_IDS";
  }

  if (config.policy !== undefined && config.policy !== null) {
    if (typeof config.policy !== "object") {
      return "INVALID_KNOWLEDGE_POLICY";
    }
    const policy = config.policy as Record<string, unknown>;
    if (policy.searchFirst !== undefined && typeof policy.searchFirst !== "boolean") {
      return "INVALID_KNOWLEDGE_SEARCH_FIRST";
    }
    if (
      policy.maxResults !== undefined
      && (!Number.isInteger(policy.maxResults) || (policy.maxResults as number) < 1 || (policy.maxResults as number) > 20)
    ) {
      return "INVALID_KNOWLEDGE_MAX_RESULTS";
    }
    if (
      policy.defaultNamespaces !== undefined
      && (
        !Array.isArray(policy.defaultNamespaces)
        || policy.defaultNamespaces.some((item) => typeof item !== "string" || item.trim().length === 0)
      )
    ) {
      return "INVALID_KNOWLEDGE_DEFAULT_NAMESPACES";
    }
  }

  return null;
}

/** 将旧 tools 格式转换为 permission 格式 */
export function toolsToPermission(tools: Record<string, boolean>): Record<string, PermissionAction> {
  const result: Record<string, PermissionAction> = {};
  for (const [key, val] of Object.entries(tools)) {
    result[key] = val ? "allow" : "deny";
  }
  return result;
}

/** 规范化 knowledge config：去重、trim */
export function normalizeKnowledgeConfig(value: unknown): AgentKnowledgeConfig | null {
  if (value == null) return null;
  const input = value as AgentKnowledgeConfig;
  return {
    knowledgeBaseIds: Array.from(
      new Set(
        (Array.isArray(input.knowledgeBaseIds) ? input.knowledgeBaseIds : [])
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ),
    policy: normalizeKnowledgePolicy(input.policy),
  };
}

function normalizeKnowledgePolicy(value: AgentKnowledgePolicy | null | undefined) {
  const policy = resolveAgentKnowledgePolicy(value);
  return {
    searchFirst: policy.searchFirst,
    maxResults: policy.maxResults,
    defaultNamespaces: policy.defaultNamespaces,
  };
}

/** 判断 agent 是否为内置 */
export function isBuiltInAgent(name: string): boolean {
  return BUILT_IN_AGENTS.has(name);
}
```

注意：需要在文件顶部添加 import：
```typescript
import { resolveAgentKnowledgePolicy } from "../agent-knowledge";
import type { AgentKnowledgeConfig, AgentKnowledgePolicy } from "../agent-knowledge";
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/__tests__/services/config-agent-config.test.ts`
Expected: PASS

- [ ] **Step 5: 更新 agents 路由，删除验证/转换函数，改为调用 service**

修改 `src/routes/web/config/agents.ts`：

1. 删除以下本地定义（已被 service 层替代）：
   - `BUILT_IN_AGENTS` 常量
   - `PermissionAction`, `RuleBasedPermission`, `TogglePermission`, `PermissionObjectConfig`, `PermissionConfig`, `AgentConfig` 类型
   - `isValidAgentName` (改用 `isValidResourceName` 直接)
   - `isValidMode`, `isValidSteps` 函数
   - `toolsToPermission` 函数
   - `validateAgentData` 函数
   - `normalizeKnowledgePolicy`, `normalizeKnowledgeConfig`, `validateKnowledgeConfig` 函数
   - `pgRowToAgentFields` 函数（未使用，可删除）

2. 添加从 service 层导入：
```typescript
import {
  validateAgentData,
  normalizeKnowledgeConfig,
  toolsToPermission,
  isBuiltInAgent,
} from "../../../services/config/agent-config";
```

3. 更新所有引用：
   - `BUILT_IN_AGENTS.has(x)` → `isBuiltInAgent(x)`
   - `AGENT_SETTABLE_FIELDS` → 从 service 层导入 `import { AGENT_SETTABLE_FIELDS } from "../../../services/config/agent-config"`
   - 删除本地 `AGENT_SETTABLE_FIELDS` 定义

- [ ] **Step 6: 运行 agents 路由测试确认通过**

Run: `bun test src/__tests__/config-agents.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/services/config/agent-config.ts src/routes/web/config/agents.ts src/__tests__/services/config-agent-config.test.ts
git commit -m "refactor: 下沉 Agent Config 验证和转换逻辑到 service 层

- 将 validateAgentData、normalizeKnowledgeConfig、toolsToPermission 移入 config/agent-config.ts
- agents 路由删除本地验证/转换函数，改为调用 service 层
- 新增 service 层验证/转换单元测试

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2: MCP Server — 下沉验证和转换逻辑

**Files:**
- Modify: `src/services/config/mcp-server.ts`
- Create: `src/__tests__/services/config-mcp-server.test.ts`
- Modify: `src/routes/web/config/mcp.ts`

- [ ] **Step 1: 创建 mcp-server service 层验证/转换的单元测试**

```typescript
// src/__tests__/services/config-mcp-server.test.ts
import { describe, test, expect } from "bun:test";
import { validateMcpConfig, isValidMcpName, toServerInfo } from "../../services/config/mcp-server";

describe("validateMcpConfig", () => {
  test("local 有效配置", () => {
    expect(validateMcpConfig({ type: "local", command: ["npx", "server"] })).toBeNull();
  });

  test("local 缺少 command", () => {
    expect(validateMcpConfig({ type: "local" })).toBe("INVALID_COMMAND");
  });

  test("local command 为空数组", () => {
    expect(validateMcpConfig({ type: "local", command: [] })).toBe("INVALID_COMMAND");
  });

  test("local command 含非 string", () => {
    expect(validateMcpConfig({ type: "local", command: [123 as any] })).toBe("INVALID_COMMAND");
  });

  test("remote 有效配置", () => {
    expect(validateMcpConfig({ type: "remote", url: "https://example.com" })).toBeNull();
  });

  test("remote 缺少 url", () => {
    expect(validateMcpConfig({ type: "remote" })).toBe("INVALID_URL");
  });

  test("remote url 为空字符串", () => {
    expect(validateMcpConfig({ type: "remote", url: "" })).toBe("INVALID_URL");
  });

  test("缺少 type", () => {
    expect(validateMcpConfig({ command: ["npx"] })).toBe("INVALID_CONFIG_TYPE");
  });

  test("无效 type", () => {
    expect(validateMcpConfig({ type: "other", command: ["npx"] })).toBe("INVALID_CONFIG_TYPE");
  });

  test("disabled 变体 — enabled: false 唯一字段", () => {
    expect(validateMcpConfig({ enabled: false })).toBeNull();
  });

  test("null 输入", () => {
    expect(validateMcpConfig(null)).toBe("INVALID_CONFIG");
  });

  test("非对象输入", () => {
    expect(validateMcpConfig("bad")).toBe("INVALID_CONFIG");
  });

  test("local 无效 environment", () => {
    expect(validateMcpConfig({ type: "local", command: ["npx"], environment: "bad" })).toBe("INVALID_ENVIRONMENT");
  });

  test("local 无效 timeout", () => {
    expect(validateMcpConfig({ type: "local", command: ["npx"], timeout: -1 })).toBe("INVALID_TIMEOUT");
  });

  test("remote 无效 headers", () => {
    expect(validateMcpConfig({ type: "remote", url: "https://x.com", headers: "bad" })).toBe("INVALID_HEADERS");
  });

  test("remote 无效 timeout", () => {
    expect(validateMcpConfig({ type: "remote", url: "https://x.com", timeout: 0 })).toBe("INVALID_TIMEOUT");
  });
});

describe("isValidMcpName", () => {
  test("my-server → true", () => {
    expect(isValidMcpName("my-server")).toBe(true);
  });
  test("a → true", () => {
    expect(isValidMcpName("a")).toBe(true);
  });
  test("空字符串 → false", () => {
    expect(isValidMcpName("")).toBe(false);
  });
  test("UPPER → false", () => {
    expect(isValidMcpName("UPPER")).toBe(false);
  });
  test("连续连字符 → false", () => {
    expect(isValidMcpName("my--server")).toBe(false);
  });
  test("连字符开头 → false", () => {
    expect(isValidMcpName("-abc")).toBe(false);
  });
});

describe("toServerInfo", () => {
  test("local 类型", () => {
    const info = toServerInfo("test", { type: "local", config: { type: "local", command: ["npx", "server"] }, enabled: true });
    expect(info).toEqual({
      name: "test",
      type: "local",
      enabled: true,
      summary: "npx",
      timeout: undefined,
    });
  });

  test("remote 类型", () => {
    const info = toServerInfo("test", { type: "remote", config: { type: "remote", url: "https://example.com" }, enabled: true });
    expect(info).toEqual({
      name: "test",
      type: "remote",
      enabled: true,
      summary: "https://example.com",
      timeout: undefined,
    });
  });

  test("disabled — 无 type 字段", () => {
    const info = toServerInfo("test", { type: "disabled", config: { enabled: false }, enabled: false });
    expect(info).toEqual({
      name: "test",
      type: "disabled",
      enabled: false,
      summary: "已禁用",
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/__tests__/services/config-mcp-server.test.ts`
Expected: FAIL — 函数未导出

- [ ] **Step 3: 在 mcp-server.ts 中添加验证和转换函数**

在 `src/services/config/mcp-server.ts` 末尾追加：

```typescript
// ────────────────────────────────────────────
// MCP Server 验证与转换
// ────────────────────────────────────────────

/** MCP 服务器名称校验 */
export function isValidMcpName(name: string): boolean {
  return typeof name === "string"
    && name.length >= 1 && name.length <= 64
    && !/--/.test(name)
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name);
}

/** 校验 MCP 配置结构，返回错误码或 null */
export function validateMcpConfig(config: unknown): string | null {
  if (typeof config !== "object" || config === null) return "INVALID_CONFIG";
  const cfg = config as Record<string, unknown>;

  if ("enabled" in cfg && cfg.enabled === false && Object.keys(cfg).length === 1) return null;

  if (!("type" in cfg) || typeof cfg.type !== "string") return "INVALID_CONFIG_TYPE";
  const type = cfg.type as string;

  if (type === "local") {
    if (!Array.isArray(cfg.command) || cfg.command.length === 0 || !cfg.command.every((c: unknown) => typeof c === "string")) {
      return "INVALID_COMMAND";
    }
    if (cfg.environment !== undefined && (typeof cfg.environment !== "object" || cfg.environment === null)) {
      return "INVALID_ENVIRONMENT";
    }
    if (cfg.timeout !== undefined && (typeof cfg.timeout !== "number" || cfg.timeout <= 0)) {
      return "INVALID_TIMEOUT";
    }
  } else if (type === "remote") {
    if (typeof cfg.url !== "string" || cfg.url.length === 0) return "INVALID_URL";
    if (cfg.headers !== undefined && (typeof cfg.headers !== "object" || cfg.headers === null)) {
      return "INVALID_HEADERS";
    }
    if (cfg.timeout !== undefined && (typeof cfg.timeout !== "number" || cfg.timeout <= 0)) {
      return "INVALID_TIMEOUT";
    }
  } else {
    return "INVALID_CONFIG_TYPE";
  }
  return null;
}

/** 将 PG 行数据转为前端展示信息 */
export function toServerInfo(name: string, row: { type: string; config: unknown; enabled: boolean }) {
  const config = row.config as Record<string, unknown>;
  if (!row.enabled && !("type" in config)) {
    return { name, type: "disabled" as const, enabled: false, summary: "已禁用" };
  }
  const cfgType = config.type as string;
  if (cfgType === "local") {
    const command = config.command as string[];
    return {
      name,
      type: "local" as const,
      enabled: row.enabled,
      summary: command[0] ?? "",
      timeout: config.timeout,
    };
  }
  return {
    name,
    type: "remote" as const,
    enabled: row.enabled,
    summary: (config as Record<string, unknown>).url ?? "",
    timeout: (config as Record<string, unknown>).timeout,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/__tests__/services/config-mcp-server.test.ts`
Expected: PASS

- [ ] **Step 5: 更新 mcp 路由，删除本地验证/转换函数，改为调用 service**

修改 `src/routes/web/config/mcp.ts`：

1. 删除以下本地定义：
   - `McpLocalConfig`, `McpRemoteConfig`, `McpDisabledConfig`, `McpServerConfig` 类型（路由内部不再需要类型判断）
   - `isValidMcpName` 函数
   - `validateMcpConfig` 函数
   - `toServerInfo` 函数

2. 添加从 service 层导入：
```typescript
import { validateMcpConfig, isValidMcpName, toServerInfo } from "../../../services/config/mcp-server";
```

3. 路由中的 `handleList`、`handleCreate`、`handleUpdate` 等函数引用保持不变，只是改为使用 service 层导入的同名函数。

4. 删除 `import { db } from "../../../db"`、`import { mcpTool } from "../../../db/schema"`、`import { eq } from "drizzle-orm"` —— 这些会在 Task 2（候选 2）中被 mcpTool service 替代。但在本 Task 中先保留 db 直访，等后续 Task 统一处理。

- [ ] **Step 6: 运行 mcp 路由测试确认通过**

Run: `bun test src/__tests__/config-mcp.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/services/config/mcp-server.ts src/routes/web/config/mcp.ts src/__tests__/services/config-mcp-server.test.ts
git commit -m "refactor: 下沉 MCP Server 验证和转换逻辑到 service 层

- 将 validateMcpConfig、isValidMcpName、toServerInfo 移入 config/mcp-server.ts
- mcp 路由删除本地验证/转换函数，改为调用 service 层
- 新增 service 层验证/转换单元测试

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: Provider — 下沉 buildModelData 转换逻辑

**Files:**
- Modify: `src/services/config/provider.ts`
- Modify: `src/routes/web/config/providers.ts`

- [ ] **Step 1: 在 provider.ts 中添加 buildModelData 函数**

在 `src/services/config/provider.ts` 末尾追加：

```typescript
/** 将前端数据映射为 PG model 字段 */
export function buildModelData(data: Record<string, unknown>): {
  displayName?: string;
  modalities?: unknown;
  limitConfig?: unknown;
  cost?: unknown;
  options?: unknown;
} {
  const result: { displayName?: string; modalities?: unknown; limitConfig?: unknown; cost?: unknown; options?: unknown } = {};
  if (data.name) result.displayName = data.name as string;
  if (data.modalities) result.modalities = data.modalities;
  if (data.limit) result.limitConfig = data.limit;
  if (data.cost) result.cost = data.cost;
  if (data.options) result.options = data.options;
  return result;
}
```

- [ ] **Step 2: 更新 providers 路由**

修改 `src/routes/web/config/providers.ts`：

1. 添加导入：
```typescript
import { buildModelData } from "../../../services/config/provider";
```

2. 删除本地 `buildModelData` 函数定义（`providers.ts` 第 196-204 行）。

- [ ] **Step 3: 运行 providers 路由测试确认通过**

Run: `bun test src/__tests__/config-providers.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/config/provider.ts src/routes/web/config/providers.ts
git commit -m "refactor: 下沉 Provider buildModelData 到 service 层

- 将 buildModelData 移入 config/provider.ts
- providers 路由删除本地转换函数

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 4: 更新 config-pg barrel export

**Files:**
- Modify: `src/services/config/index.ts`

- [ ] **Step 1: 导出新函数**

修改 `src/services/config/index.ts`，追加导出：

```typescript
export { validateAgentData, normalizeKnowledgeConfig, toolsToPermission, isBuiltInAgent } from "./agent-config";
export { validateMcpConfig, isValidMcpName, toServerInfo } from "./mcp-server";
export { buildModelData } from "./provider";
```

- [ ] **Step 2: 运行全量 config 测试确认通过**

Run: `bun test src/__tests__/config-agents.test.ts src/__tests__/config-mcp.test.ts src/__tests__/config-providers.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/config/index.ts
git commit -m "refactor: 导出 config 子模块新增的验证和转换函数

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```
