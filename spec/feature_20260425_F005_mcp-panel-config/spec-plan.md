# MCP 面板配置 执行计划

**目标:** 在 Settings UI 中新增 MCP 配置页面，支持 local/remote 类型 MCP 服务器的 CRUD 管理

**技术栈:** React 19, TypeScript, Hono, Bun, bun:test, shadcn/ui (DataTable/FormDialog/ConfirmDialog/BatchActionBar/StatusBadge)

**设计文档:** spec-design.md

## 改动总览

本次改动新增 MCP 配置管理功能，涉及 5 个 Task：类型定义（config.ts）、后端路由（mcp.ts）、前端 API 客户端（api/client.ts）、MCP 页面组件（McpPage.tsx）、路由集成（App.tsx）。Task 1 创建 MCP 数据模型，Task 2 依赖 Task 1 的类型在后端实现 CRUD 路由，Task 3 依赖 Task 1 的类型扩展前端 API 层，Task 4 依赖 Task 3 的 API 函数构建页面组件，Task 5 依赖 Task 4 的组件导出完成路由集成。类型定义严格对齐 opencode.ai config.json schema 中的 `mcp` 字段结构。

---

### Task 0: 环境准备

**背景:**
确保构建和测试工具链在当前开发环境中可用，避免后续 Task 因环境问题阻塞。

**执行步骤:**

- [ ] 验证 Bun 运行时可用
  - `bun --version`
  - 预期: 输出版本号（v1.x+）
- [ ] 验证前端依赖已安装
  - `cd /Users/konghayao/code/pazhou/remote-control-server/web && ls node_modules/.package-lock.json 2>/dev/null && echo "deps installed" || echo "need install"`
  - 预期: 输出 "deps installed"
- [ ] 验证现有测试可运行
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-skills-page.test.ts 2>&1 | tail -3`
  - 预期: 测试通过，无错误

**检查步骤:**

- [ ] 验证 Bun 可用
  - `bun --version`
  - 预期: 输出版本号
- [ ] 验证现有测试通过
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-types.test.ts 2>&1 | tail -3`
  - 预期: 测试通过，无失败用例

---

### Task 1: 类型定义

**背景:**
当前 `config.ts` 缺少 MCP 相关类型定义，无法支撑后端路由和前端页面的开发。本 Task 在 `config.ts` 中添加 McpLocalConfig、McpRemoteConfig、McpServerConfig 等联合类型，并扩展 OpenCodeConfig 增加 `mcp` 字段，为 Task 2（后端路由）和 Task 3（前端 API 客户端）提供类型基础。

**涉及文件:**

- 修改: `web/src/types/config.ts`
- 新建: `web/src/__tests__/config-mcp-types.test.ts`

**执行步骤:**

- [ ] 在 `web/src/types/config.ts` 中 `OpenCodeAgent` 接口之后、`OpenCodeConfig` 接口之前，插入 MCP 相关类型定义 — 对齐 opencode.ai config.json schema
  - 位置: `web/src/types/config.ts` (~L71, `OpenCodeAgent` 接定义之后)
  - 插入以下类型：

  ```typescript
  // === MCP 类型定义 ===

  /** OAuth 认证配置 */
  export interface McpOAuthConfig {
      clientId?: string;
      clientSecret?: string;
      scope?: string;
      redirectUri?: string;
  }

  /** 本地 MCP 服务器配置（命令行启动） */
  export interface McpLocalConfig {
      type: "local";
      command: string[];
      environment?: Record<string, string>;
      enabled?: boolean;
      timeout?: number;
  }

  /** 远程 MCP 服务器配置（URL 连接） */
  export interface McpRemoteConfig {
      type: "remote";
      url: string;
      enabled?: boolean;
      headers?: Record<string, string>;
      oauth?: McpOAuthConfig | false;
      timeout?: number;
  }

  /** MCP 服务器配置联合类型（含禁用变体） */
  export type McpServerConfig = McpLocalConfig | McpRemoteConfig | { enabled: false };
  ```

- [ ] 在 `web/src/types/config.ts` 中 `OpenCodeConfig` 接口内新增 `mcp` 可选字段 — 使 OpenCodeConfig 包含 MCP 配置入口
  - 位置: `web/src/types/config.ts` `OpenCodeConfig` 接口内部，`plugin?: string[]` 之后、`theme?: string` 之前 (~L80-L81)
  - 在 `plugin?: string[];` 之后插入: `mcp?: Record<string, McpServerConfig>;`
  - 原因: MCP 配置存储在 opencode.json 的 `mcp` 字段中，key 为服务器名称

- [ ] 在 `web/src/types/config.ts` 的 `// === API 响应类型 ===` 区域中，Skills 相关类型之后、`// === Generic API Response ===` 之前，插入 MCP 前端展示类型 — 供前端列表页和编辑对话框使用
  - 位置: `web/src/types/config.ts` (~L182, `SkillDetail` 接口之后，`// === Generic API Response ===` 之前)
  - 插入以下类型：

  ```typescript
  // --- MCP ---

  /** 用于前端列表展示的 MCP 服务器信息 */
  export interface McpServerInfo {
      name: string;
      type: "local" | "remote" | "disabled";
      enabled: boolean;
      summary: string;
      timeout?: number;
  }

  /** MCP 服务器详情（编辑用） */
  export interface McpServerDetail {
      name: string;
      config: McpServerConfig;
  }
  ```

- [ ] 为 MCP 类型定义编写单元测试 — 确保类型在运行时行为正确（联合类型区分、字段可选性、边界值）
  - 测试文件: `web/src/__tests__/config-mcp-types.test.ts`
  - 测试场景:
    - McpLocalConfig 基本构造: `{ type: "local", command: ["npx", "mcp-server"] }` → 类型正确，command 长度为 2
    - McpLocalConfig 含可选字段: 带 `environment`、`enabled`、`timeout` 的完整对象 → 各字段可正确访问
    - McpRemoteConfig 基本构造: `{ type: "remote", url: "https://example.com/mcp" }` → 类型正确，url 匹配
    - McpRemoteConfig 含 headers 和 oauth: 带 `headers`、`oauth: { clientId: "x" }` 的对象 → 字段可正确访问
    - McpRemoteConfig oauth 为 false: `{ type: "remote", url: "...", oauth: false }` → oauth 值为 false
    - McpServerConfig 禁用变体: `{ enabled: false }` → 对象仅含 enabled 字段且值为 false
    - McpServerInfo 列表项构造: `{ name: "test", type: "local", enabled: true, summary: "npx" }` → 字段均可访问
    - McpServerDetail 编辑项构造: `{ name: "test", config: { type: "local", command: ["npx"] } }` → config.type 为 "local"
    - OpenCodeConfig 包含 mcp 字段: `{ mcp: { "server1": { type: "local", command: ["npx"] } } }` → mcp 对象含 server1 键
  - 运行命令: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-mcp-types.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [ ] 验证 MCP 类型定义已导出
  - `grep -c "export.*McpLocalConfig\|export.*McpRemoteConfig\|export.*McpServerConfig\|export.*McpOAuthConfig\|export.*McpServerInfo\|export.*McpServerDetail" web/src/types/config.ts`
  - 预期: 输出 6（6 个 export 声明）
- [ ] 验证 OpenCodeConfig 包含 mcp 字段
  - `grep "mcp?" web/src/types/config.ts`
  - 预期: 匹配到 `mcp?: Record<string, McpServerConfig>;`
- [ ] 运行单元测试验证类型正确性
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-mcp-types.test.ts`
  - 预期: 所有测试通过，无类型错误
- [ ] 验证 TypeScript 编译通过
  - `cd /Users/konghayao/code/pazhou/remote-control-server/web && npx tsc --noEmit --pretty 2>&1 | tail -5`
  - 预期: 无错误输出

---

### Task 2: 后端 MCP 路由

**背景:**
本 Task 实现后端 MCP 配置 API，为前端 MCP 管理页面提供数据支撑。当前 `src/routes/web/config/` 下已有 agents/skills/models/providers 四个路由模块，但缺少 MCP 路由。MCP 配置存储在 opencode.json 的 `mcp` 字段中（`Record<string, McpServerConfig>`），需要通过 `getSection`/`replaceSection` 等 config service 方法进行读写。本 Task 的输出被 Task 3（前端 API 客户端）和 Task 4（MCP 页面组件）依赖。

**涉及文件:**

- 新建: `src/routes/web/config/mcp.ts`
- 修改: `src/routes/web/config/index.ts`
- 新建: `src/__tests__/config-mcp.test.ts`

**执行步骤:**

- [ ] 新建 `src/routes/web/config/mcp.ts` 路由文件 — 参照 `agents.ts` 模式，实现 MCP 配置的 CRUD API
  - 位置: `src/routes/web/config/mcp.ts`（新建文件）
  - 文件结构：
    1. 导入 `Hono`、`sessionAuth` 中间件、config service 方法（`getSection`、`replaceSection`）
    2. 定义 MCP 相关的内部类型（后端类型，不依赖前端 `web/src/types/config.ts`）
    3. 实现 7 个 action handler 函数
    4. 创建 Hono 实例并注册路由
    5. `export default app`
  - 关键伪代码：

  ```typescript
  import { Hono } from "hono";
  import { sessionAuth } from "../../../auth/middleware";
  import { getSection, replaceSection } from "../../../services/config";

  // 内部类型定义（与前端 web/src/types/config.ts 对齐）
  type McpLocalConfig = {
    type: "local";
    command: string[];
    environment?: Record<string, string>;
    enabled?: boolean;
    timeout?: number;
  };

  type McpRemoteConfig = {
    type: "remote";
    url: string;
    enabled?: boolean;
    headers?: Record<string, string>;
    oauth?: { clientId?: string; clientSecret?: string; scope?: string; redirectUri?: string } | false;
    timeout?: number;
  };

  type McpDisabledConfig = { enabled: false };

  type McpServerConfig = McpLocalConfig | McpRemoteConfig | McpDisabledConfig;

  type McpRecord = Record<string, McpServerConfig>;

  // 服务器名称校验：1-64 字符，小写字母/数字/连字符
  function isValidMcpName(name: string): boolean {
    return typeof name === "string"
      && name.length >= 1 && name.length <= 64
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name);
  }

  // 配置校验：验证 McpServerConfig 结构
  function validateMcpConfig(config: unknown): string | null {
    if (typeof config !== "object" || config === null) return "INVALID_CONFIG";
    const cfg = config as Record<string, unknown>;

    // 禁用变体
    if ("enabled" in cfg && cfg.enabled === false && Object.keys(cfg).length === 1) return null;

    // 必须有 type 字段
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

  // 从 McpServerConfig 提取列表摘要信息
  function toServerInfo(name: string, config: McpServerConfig) {
    if ("enabled" in config && config.enabled === false && !("type" in config)) {
      return { name, type: "disabled" as const, enabled: false, summary: "Disabled" };
    }
    if (config.type === "local") {
      return {
        name,
        type: "local" as const,
        enabled: config.enabled !== false,
        summary: (config.command as string[])[0] ?? "",
        timeout: config.timeout,
      };
    }
    // remote
    return {
      name,
      type: "remote" as const,
      enabled: config.enabled !== false,
      summary: (config as McpRemoteConfig).url ?? "",
      timeout: (config as McpRemoteConfig).timeout,
    };
  }

  // --- Action Handlers ---

  async function handleList() {
    const mcp = (await getSection<McpRecord>("mcp")) ?? {};
    const servers = Object.entries(mcp).map(([name, config]) => toServerInfo(name, config));
    return { success: true, data: { servers } };
  }

  async function handleGet(name: string) {
    const mcp = (await getSection<McpRecord>("mcp")) ?? {};
    const config = mcp[name];
    if (!config) return { success: false, error: { code: "NOT_FOUND", message: `MCP server '${name}' not found` } };
    return { success: true, data: { name, config } };
  }

  async function handleCreate(name: string, config: McpServerConfig) {
    if (!isValidMcpName(name)) {
      return { success: false, error: { code: "VALIDATION_ERROR", message: "Invalid server name: must be 1-64 lowercase alphanumeric chars with single hyphens" } };
    }
    const validation = validateMcpConfig(config);
    if (validation) return { success: false, error: { code: "VALIDATION_ERROR", message: validation } };

    const mcp = (await getSection<McpRecord>("mcp")) ?? {};
    if (mcp[name]) return { success: false, error: { code: "ALREADY_EXISTS", message: `MCP server '${name}' already exists` } };
    mcp[name] = config;
    await replaceSection("mcp", mcp);
    return { success: true, data: { name } };
  }

  async function handleUpdate(name: string, config: McpServerConfig) {
    const validation = validateMcpConfig(config);
    if (validation) return { success: false, error: { code: "VALIDATION_ERROR", message: validation } };

    const mcp = (await getSection<McpRecord>("mcp")) ?? {};
    if (!mcp[name]) return { success: false, error: { code: "NOT_FOUND", message: `MCP server '${name}' not found` } };
    mcp[name] = config;
    await replaceSection("mcp", mcp);
    return { success: true, data: { name } };
  }

  async function handleDelete(name: string) {
    const mcp = (await getSection<McpRecord>("mcp")) ?? {};
    if (!mcp[name]) return { success: false, error: { code: "NOT_FOUND", message: `MCP server '${name}' not found` } };
    delete mcp[name];
    await replaceSection("mcp", mcp);
    return { success: true };
  }

  async function handleEnable(name: string) {
    const mcp = (await getSection<McpRecord>("mcp")) ?? {};
    const config = mcp[name];
    if (!config) return { success: false, error: { code: "NOT_FOUND", message: `MCP server '${name}' not found` } };

    // 如果当前是禁用变体 { enabled: false }，无法启用（缺少原始配置信息）
    if ("enabled" in config && config.enabled === false && !("type" in config)) {
      return { success: false, error: { code: "VALIDATION_ERROR", message: `Cannot enable '${name}': original config lost, please recreate` } };
    }
    (config as Record<string, unknown>).enabled = true;
    mcp[name] = config;
    await replaceSection("mcp", mcp);
    return { success: true, data: { name, enabled: true } };
  }

  async function handleDisable(name: string) {
    const mcp = (await getSection<McpRecord>("mcp")) ?? {};
    const config = mcp[name];
    if (!config) return { success: false, error: { code: "NOT_FOUND", message: `MCP server '${name}' not found` } };
    (config as Record<string, unknown>).enabled = false;
    mcp[name] = config;
    await replaceSection("mcp", mcp);
    return { success: true, data: { name, enabled: false } };
  }

  // --- 路由注册 ---
  const app = new Hono();

  app.post("/config/mcp", sessionAuth, async (c) => {
    const body = await c.req.json<{ action: string; name?: string; config?: unknown }>()
      .catch((): { action: string; name?: string; config?: unknown } => ({ action: "" }));
    const { action, name, config } = body;

    switch (action) {
      case "list":   return c.json(await handleList());
      case "get":    return c.json(await handleGet(name!));
      case "create": return c.json(await handleCreate(name!, config as McpServerConfig));
      case "update": return c.json(await handleUpdate(name!, config as McpServerConfig));
      case "delete": return c.json(await handleDelete(name!));
      case "enable": return c.json(await handleEnable(name!));
      case "disable": return c.json(await handleDisable(name!));
      default: return c.json({ success: false, error: { code: "VALIDATION_ERROR", message: `Unknown action '${action}'` } }, 400);
    }
  });

  export default app;
  ```

  - 原因: 遵循 agents.ts 的代码结构（内部类型 + 校验函数 + handler 函数 + Hono 路由注册），保持一致性

- [ ] 在 `src/routes/web/config/index.ts` 中注册 MCP 路由 — 使 `/config/mcp` 路径可被访问
  - 位置: `src/routes/web/config/index.ts` 第 2 行（import 区域）
  - 在 `import skills from "./skills";` 之后添加: `import mcp from "./mcp";`
  - 位置: `src/routes/web/config/index.ts` 第 11 行（路由注册区域）
  - 在 `app.route("/", skills);` 之后添加: `app.route("/", mcp);`
  - 原因: 与 agents/skills/models/providers 保持相同的注册模式

- [ ] 为 MCP 路由编写单元测试 — 验证所有 action handler 的输入校验和返回值格式
  - 测试文件: `src/__tests__/config-mcp.test.ts`
  - 测试框架: `bun:test`，参照 agents.ts 的验证模式
  - 测试前需要 mock config service：使用 `bun:test` 的 `mock()` 方法 mock `src/services/config.ts` 的 `getSection` 和 `replaceSection`
  - 测试场景:
    - `handleList` 空配置: `getSection("mcp")` 返回 `undefined` → 返回 `{ success: true, data: { servers: [] } }`
    - `handleList` 含多个服务器: 返回包含 2 个 local + 1 个 remote 的配置 → `servers` 数组长度为 3，每个元素的 `name`、`type`、`enabled`、`summary` 字段正确
    - `handleGet` 存在的服务器: 请求 name="my-local" → 返回 `{ success: true, data: { name: "my-local", config: {...} } }`
    - `handleGet` 不存在的服务器: 请求 name="nonexistent" → 返回 `{ success: false, error: { code: "NOT_FOUND", ... } }`
    - `handleCreate` 正常创建 local 服务器: name="new-server", config 为合法 local 配置 → 返回 `{ success: true, data: { name: "new-server" } }`，`replaceSection` 被调用且 mcp 对象包含新 key
    - `handleCreate` 正常创建 remote 服务器: name="remote-srv", config 为合法 remote 配置 → 返回 `{ success: true, data: { name: "remote-srv" } }`
    - `handleCreate` 重名: name 与已存在服务器同名 → 返回 `{ success: false, error: { code: "ALREADY_EXISTS", ... } }`
    - `handleCreate` 无效名称: name="UPPER_CASE" → 返回 `{ success: false, error: { code: "VALIDATION_ERROR", message: "Invalid server name..." } }`
    - `handleCreate` 无效配置: config 缺少 type 字段 → 返回 `{ success: false, error: { code: "VALIDATION_ERROR", message: "INVALID_CONFIG_TYPE" } }`
    - `handleCreate` local 缺少 command: config `{ type: "local" }` → 返回 `{ success: false, error: { code: "VALIDATION_ERROR", message: "INVALID_COMMAND" } }`
    - `handleCreate` remote 缺少 url: config `{ type: "remote" }` → 返回 `{ success: false, error: { code: "VALIDATION_ERROR", message: "INVALID_URL" } }`
    - `handleUpdate` 正常更新: 修改已存在服务器的 command → 返回 `{ success: true, data: { name: "..." } }`，`replaceSection` 被调用
    - `handleUpdate` 不存在的服务器: → 返回 `{ success: false, error: { code: "NOT_FOUND", ... } }`
    - `handleDelete` 正常删除: → 返回 `{ success: true }`，`replaceSection` 被调用且 mcp 对象不含已删除 key
    - `handleDelete` 不存在的服务器: → 返回 `{ success: false, error: { code: "NOT_FOUND", ... } }`
    - `handleEnable` 正常启用: → 返回 `{ success: true, data: { name: "...", enabled: true } }`
    - `handleEnable` 禁用变体（无原始配置）: config 为 `{ enabled: false }` → 返回 `{ success: false, error: { code: "VALIDATION_ERROR", message: "...original config lost..." } }`
    - `handleDisable` 正常禁用: → 返回 `{ success: true, data: { name: "...", enabled: false } }`
    - `isValidMcpName` 边界: 空字符串→false, "a"→true, 长度65→false, "A"→false, "my-server"→true, "my--server"→false
    - `validateMcpConfig` 非对象输入: 传入 `null` → 返回 `"INVALID_CONFIG"`
  - 运行命令: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/config-mcp.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [ ] 验证 MCP 路由文件已创建且导出 Hono 实例
  - `grep -c "export default app" src/routes/web/config/mcp.ts`
  - 预期: 输出 1
- [ ] 验证 MCP 路由已在 index.ts 中注册
  - `grep "mcp" src/routes/web/config/index.ts`
  - 预期: 匹配到 `import mcp from "./mcp";` 和 `app.route("/", mcp);`
- [ ] 验证 MCP 路由包含所有 7 个 action
  - `grep -oE 'case "[a-z]+"' src/routes/web/config/mcp.ts | sort`
  - 预期: 输出包含 create、delete、disable、enable、get、list、update（7 个 action）
- [ ] 验证路由使用了 sessionAuth 中间件
  - `grep "sessionAuth" src/routes/web/config/mcp.ts`
  - 预期: 匹配到 `sessionAuth` 在路由定义中
- [ ] 运行 MCP 路由单元测试
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/config-mcp.test.ts`
  - 预期: 所有测试通过，无失败用例
- [ ] 验证 TypeScript 编译通过（后端）
  - `cd /Users/konghayao/code/pazhou/remote-control-server && npx tsc --noEmit --pretty 2>&1 | tail -5`
  - 预期: 无错误输出

---

### Task 3: 前端 API 客户端

**背景:**
当前 `api/client.ts` 中 `apiConfigAction` 的 `module` 参数仅支持 `'providers' | 'models' | 'agents' | 'skills'` 四个模块，缺少 MCP 模块。本 Task 扩展 `apiConfigAction` 支持 `'mcp'` 模块，并新增 7 个 MCP API 函数（list/get/create/update/delete/enable/disable），为 Task 4（MCP 页面组件）提供数据访问层。本 Task 依赖 Task 1（McpServerInfo/McpServerDetail 类型定义）和 Task 2（后端 MCP 路由）的输出。

**涉及文件:**

- 修改: `web/src/api/client.ts`
- 新建: `web/src/__tests__/config-mcp-api-client.test.ts`

**执行步骤:**

- [ ] 在 `web/src/api/client.ts` 顶部 import 语句中，从 `../types/config` 添加 MCP 类型导入
  - 位置: `web/src/api/client.ts` 第 2 行
  - 当前: `import type { ProviderInfo, ProviderDetail, ModelConfig, AgentInfo, AgentDetail, SkillInfo, SkillDetail, ApiResponse } from "../types/config";`
  - 替换为: `import type { ProviderInfo, ProviderDetail, ModelConfig, AgentInfo, AgentDetail, SkillInfo, SkillDetail, McpServerInfo, McpServerDetail, McpServerConfig, ApiResponse } from "../types/config";`
  - 原因: MCP API 函数需要引用 McpServerInfo、McpServerDetail、McpServerConfig 类型

- [ ] 扩展 `apiConfigAction` 的 `module` 参数类型，加入 `'mcp'`
  - 位置: `web/src/api/client.ts` 第 140 行，`apiConfigAction` 函数签名
  - 当前: `module: 'providers' | 'models' | 'agents' | 'skills',`
  - 替换为: `module: 'providers' | 'models' | 'agents' | 'skills' | 'mcp',`
  - 原因: 使 apiConfigAction 接受 "mcp" 作为模块名，路由映射到 `POST /web/config/mcp`

- [ ] 在 `web/src/api/client.ts` 文件末尾（Skills 区域之后）添加 MCP API 函数区域
  - 位置: `web/src/api/client.ts` 第 231 行之后（`apiDisableSkill` 函数之后，文件末尾）
  - 插入以下代码块：

  ```typescript
  // --- MCP ---

  export function apiListMcpServers() {
    return apiConfigAction<{ servers: McpServerInfo[] }>("mcp", "list").then(d => d.servers);
  }
  export function apiGetMcpServer(name: string) {
    return apiConfigAction<McpServerDetail>("mcp", "get", { name });
  }
  export function apiCreateMcpServer(name: string, config: McpServerConfig) {
    return apiConfigAction<{ name: string }>("mcp", "create", { name, config });
  }
  export function apiUpdateMcpServer(name: string, config: McpServerConfig) {
    return apiConfigAction<{ name: string }>("mcp", "update", { name, config });
  }
  export function apiDeleteMcpServer(name: string) {
    return apiConfigAction<null>("mcp", "delete", { name });
  }
  export function apiEnableMcpServer(name: string) {
    return apiConfigAction<{ name: string; enabled: boolean }>("mcp", "enable", { name });
  }
  export function apiDisableMcpServer(name: string) {
    return apiConfigAction<{ name: string; enabled: boolean }>("mcp", "disable", { name });
  }
  ```

  - 函数设计说明：
    - `apiListMcpServers`: 调用 `list` action，通过 `.then(d => d.servers)` 展开返回 `McpServerInfo[]`（与 `apiListProviders`/`apiListSkills` 模式一致）
    - `apiGetMcpServer`: 调用 `get` action，传入 `{ name }`，返回 `McpServerDetail`（与 `apiGetSkill` 模式一致）
    - `apiCreateMcpServer`: 调用 `create` action，传入 `{ name, config }`，返回 `{ name: string }`（与 `apiCreateAgent` 模式一致）
    - `apiUpdateMcpServer`: 调用 `update` action，传入 `{ name, config }`，返回 `{ name: string }`
    - `apiDeleteMcpServer`: 调用 `delete` action，传入 `{ name }`，返回 `null`（与 `apiDeleteSkill` 模式一致）
    - `apiEnableMcpServer`/`apiDisableMcpServer`: 调用 `enable`/`disable` action，返回 `{ name: string; enabled: boolean }`（与 `apiEnableSkill`/`apiDisableSkill` 模式一致）
  - 原因: 保持与现有 providers/models/agents/skills API 函数一致的命名和结构模式

- [ ] 为 MCP API 客户端编写单元测试 — 验证所有 MCP API 函数正确调用 fetch 并解析响应
  - 测试文件: `web/src/__tests__/config-mcp-api-client.test.ts`
  - 测试框架: `bun:test`，参照 `web/src/__tests__/config-api-client.test.ts` 的 mock 模式
  - 测试前通过 `mock()` 替换 `globalThis.fetch`，设置 `fetchMock.body` 和 `fetchMock.status` 控制响应
  - 测试场景:
    - `apiListMcpServers` 正常返回: body 为 `{ success: true, data: { servers: [{ name: "my-local", type: "local", enabled: true, summary: "npx" }] } }` → 返回数组长度为 1，元素 `name` 为 `"my-local"`
    - `apiListMcpServers` 发送正确请求: 验证 fetch 调用的 URL 为 `"/web/config/mcp"`，body 中 `action` 为 `"list"`
    - `apiGetMcpServer` 正常返回: body 含 `{ name: "my-local", config: { type: "local", command: ["npx", "mcp-server"] } }` → 返回对象的 `config.type` 为 `"local"`
    - `apiGetMcpServer` 发送正确 payload: 验证 body 中 `action` 为 `"get"`，`name` 为传入值
    - `apiCreateMcpServer` 正常返回: body 为 `{ success: true, data: { name: "new-server" } }` → 返回 `{ name: "new-server" }`
    - `apiCreateMcpServer` 发送正确 payload: 验证 body 中 `action` 为 `"create"`，`name` 和 `config` 正确传递
    - `apiUpdateMcpServer` 发送正确 payload: 验证 body 中 `action` 为 `"update"`，`name` 和 `config` 正确传递
    - `apiDeleteMcpServer` 发送 delete action: 验证 body 中 `action` 为 `"delete"`，`name` 正确传递
    - `apiEnableMcpServer` 正常返回: body 为 `{ success: true, data: { name: "s1", enabled: true } }` → 返回 `{ name: "s1", enabled: true }`
    - `apiDisableMcpServer` 正常返回: body 为 `{ success: true, data: { name: "s1", enabled: false } }` → 返回 `{ name: "s1", enabled: false }`
    - 错误响应抛出异常: body 为 `{ success: false, error: { code: "NOT_FOUND", message: "Server not found" } }` → 调用 `apiGetMcpServer("xxx")` 抛出 `"Server not found"`
  - 运行命令: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-mcp-api-client.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [ ] 验证 MCP 类型已导入到 client.ts
  - `grep "McpServerInfo\|McpServerDetail\|McpServerConfig" web/src/api/client.ts`
  - 预期: 在 import 语句中匹配到 3 个 MCP 类型
- [ ] 验证 apiConfigAction 的 module 参数包含 'mcp'
  - `grep "'mcp'" web/src/api/client.ts`
  - 预期: 在 apiConfigAction 签名行匹配到 `'mcp'`
- [ ] 验证 7 个 MCP API 函数已导出
  - `grep -oE "export function api[A-Z][a-zA-Z]*Mcp[a-zA-Z]*" web/src/api/client.ts | sort`
  - 预期: 输出 7 个函数名：apiCreateMcpServer, apiDeleteMcpServer, apiDisableMcpServer, apiEnableMcpServer, apiGetMcpServer, apiListMcpServers, apiUpdateMcpServer
- [ ] 验证 apiListMcpServers 使用 list action 并展开 servers 字段
  - `grep 'apiConfigAction.*"mcp".*"list"' web/src/api/client.ts`
  - 预期: 匹配到 `apiConfigAction<{ servers: McpServerInfo[] }>("mcp", "list").then(d => d.servers)`
- [ ] 运行 MCP API 客户端单元测试
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-mcp-api-client.test.ts`
  - 预期: 所有测试通过，无失败用例
- [ ] 验证 TypeScript 编译通过（前端）
  - `cd /Users/konghayao/code/pazhou/remote-control-server/web && npx tsc --noEmit --pretty 2>&1 | tail -5`
  - 预期: 无错误输出

---

### Task 4: MCP 页面组件

**背景:**
本 Task 实现 MCP 配置管理的前端页面 `McpPage.tsx`，为用户提供 MCP 服务器的可视化 CRUD 操作界面。当前 Settings UI 已有 SkillsPage/AgentsPage 等配置页面，MCP 页面需保持一致的 UI 风格（DataTable + FormDialog + ConfirmDialog + BatchActionBar + StatusBadge 组合）。本 Task 依赖 Task 1（MCP 类型定义）、Task 2（后端路由）、Task 3（前端 API 客户端）的输出，其输出被 Task 5（路由集成）依赖。

**涉及文件:**

- 新建: `web/src/pages/McpPage.tsx`
- 新建: `web/src/__tests__/config-mcp-page.test.ts`

**执行步骤:**

- [ ] 新建 `web/src/pages/McpPage.tsx` 文件骨架 — 参照 SkillsPage 结构，建立导入和导出的纯工具函数
  - 位置: `web/src/pages/McpPage.tsx`（新建文件）
  - 顶部导入区域：

    ```typescript
    import { useState, useCallback, useEffect } from "react";
    import { toast } from "sonner";
    import { DataTable, type Column } from "@/components/config/DataTable";
    import { FormDialog } from "@/components/config/FormDialog";
    import { ConfirmDialog } from "@/components/config/ConfirmDialog";
    import { BatchActionBar } from "@/components/config/BatchActionBar";
    import { StatusBadge } from "@/components/config/StatusBadge";
    import { Skeleton } from "@/components/ui/skeleton";
    import { Button } from "@/components/ui/button";
    import { Input } from "@/components/ui/input";
    import { Label } from "@/components/ui/label";
    import {
      Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
    } from "@/components/ui/select";
    import {
      apiListMcpServers, apiGetMcpServer, apiCreateMcpServer,
      apiUpdateMcpServer, apiDeleteMcpServer, apiEnableMcpServer, apiDisableMcpServer,
    } from "../api/client";
    import type { McpServerInfo, McpServerConfig, McpLocalConfig, McpRemoteConfig } from "../types/config";
    ```

  - 原因: 保持与 SkillsPage/AgentsPage 一致的导入结构

- [ ] 导出纯工具函数 `validateMcpForm` — 供表单提交前校验使用，同时供单元测试直接 import 测试
  - 位置: `web/src/pages/McpPage.tsx` 紧接 import 之后，组件函数之前
  - 函数签名和实现：

    ```typescript
    /** 键值对列表项类型 */
    export type KeyValueEntry = { key: string; value: string };

    /** 校验 MCP 服务器表单，返回错误消息或 null */
    export function validateMcpForm(
      name: string,
      type: "local" | "remote",
      command: string,
      url: string,
    ): string | null {
      if (!name.trim()) return "名称不能为空";
      if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) {
        return "名称只能包含小写字母、数字和连字符，且不能以连字符开头/结尾";
      }
      if (name.length > 64) return "名称长度不能超过 64 个字符";
      if (type === "local") {
        if (!command.trim()) return "命令不能为空";
        const parts = parseCommandString(command);
        if (parts.length === 0) return "命令格式不正确";
      }
      if (type === "remote") {
        if (!url.trim()) return "URL 不能为空";
        try { new URL(url); } catch { return "URL 格式不正确"; }
      }
      return null;
    }
    ```

  - 原因: 表单校验逻辑抽离为纯函数，便于单元测试覆盖

- [ ] 导出纯工具函数 `parseCommandString` 和 `commandToString` — 处理命令字符串数组与用户输入的转换
  - 位置: `web/src/pages/McpPage.tsx` 紧接 `validateMcpForm` 之后
  - 函数实现：

    ```typescript
    /** 将用户输入的命令字符串按空格拆分为字符串数组（支持引号包裹的参数） */
    export function parseCommandString(input: string): string[] {
      const tokens: string[] = [];
      const regex = /(?:[^\s"]+|"[^"]*")+/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(input)) !== null) {
        tokens.push(match[0].replace(/^"|"$/g, ""));
      }
      return tokens;
    }

    /** 将命令字符串数组转为用户可编辑的空格分隔字符串 */
    export function commandToString(command: string[]): string {
      return command
        .map((part) => (/\s/.test(part) ? `"${part}"` : part))
        .join(" ");
    }
    ```

  - 原因: local 类型的 `command` 字段是 `string[]`，需要双向转换供用户在 Input 中编辑

- [ ] 导出纯工具函数 `buildMcpSummary` — 从 McpServerConfig 提取列表展示用的摘要文本
  - 位置: `web/src/pages/McpPage.tsx` 紧接 `commandToString` 之后
  - 函数实现：

    ```typescript
    /** 从 MCP 配置中构建列表摘要文本 */
    export function buildMcpSummary(config: McpServerConfig): string {
      if ("enabled" in config && config.enabled === false && !("type" in config)) {
        return "已禁用";
      }
      if (config.type === "local") {
        const local = config as McpLocalConfig;
        return local.command[0] ?? "";
      }
      if (config.type === "remote") {
        const remote = config as McpRemoteConfig;
        return remote.url ?? "";
      }
      return "";
    }
    ```

  - 原因: DataTable 的 summary 列需要展示服务器简要描述，local 显示 command[0]，remote 显示 url

- [ ] 导出纯工具函数 `buildMcpPayload` — 从表单 state 构建 API 提交用的 McpServerConfig 对象
  - 位置: `web/src/pages/McpPage.tsx` 紧接 `buildMcpSummary` 之后
  - 函数实现：

    ```typescript
    /** 将表单数据组装为 McpServerConfig 对象 */
    export function buildMcpPayload(
      type: "local" | "remote",
      command: string,
      url: string,
      environment: KeyValueEntry[],
      headers: KeyValueEntry[],
      oauthClientId: string,
      oauthClientSecret: string,
      oauthScope: string,
      oauthRedirectUri: string,
      timeout: string,
    ): McpServerConfig {
      const timeoutNum = timeout ? parseInt(timeout, 10) : undefined;
      const envObj: Record<string, string> | undefined =
        environment.filter((e) => e.key.trim()).length > 0
          ? Object.fromEntries(environment.filter((e) => e.key.trim()).map((e) => [e.key, e.value]))
          : undefined;
      const headersObj: Record<string, string> | undefined =
        headers.filter((h) => h.key.trim()).length > 0
          ? Object.fromEntries(headers.filter((h) => h.key.trim()).map((h) => [h.key, h.value]))
          : undefined;
      const oauthObj =
        oauthClientId || oauthClientSecret || oauthScope || oauthRedirectUri
          ? {
              clientId: oauthClientId || undefined,
              clientSecret: oauthClientSecret || undefined,
              scope: oauthScope || undefined,
              redirectUri: oauthRedirectUri || undefined,
            }
          : undefined;

      if (type === "local") {
        return {
          type: "local",
          command: parseCommandString(command),
          ...(envObj ? { environment: envObj } : {}),
          ...(timeoutNum ? { timeout: timeoutNum } : {}),
        };
      }
      return {
        type: "remote",
        url,
        ...(headersObj ? { headers: headersObj } : {}),
        ...(oauthObj ? { oauth: oauthObj } : {}),
        ...(timeoutNum ? { timeout: timeoutNum } : {}),
      };
    }
    ```

  - 原因: 将分散的表单字段组装为完整的 McpServerConfig 联合类型对象，供 API 提交使用

- [ ] 实现 `McpPage` 组件的 state 声明 — 声明列表数据、对话框、表单字段、批量操作等全部 state
  - 位置: `web/src/pages/McpPage.tsx` `export function McpPage()` 函数体内，紧接函数开头
  - state 声明列表（共 17 个 state）：

    ```typescript
    export function McpPage() {
      // --- 列表数据 ---
      const [servers, setServers] = useState<McpServerInfo[]>([]);
      const [loading, setLoading] = useState(true);

      // --- 对话框控制 ---
      const [dialogOpen, setDialogOpen] = useState(false);
      const [editingServer, setEditingServer] = useState<McpServerInfo | null>(null);
      const [confirmOpen, setConfirmOpen] = useState(false);
      const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

      // --- 批量操作 ---
      const [selected, setSelected] = useState<McpServerInfo[]>([]);
      const [batchAction, setBatchAction] = useState<"enable" | "disable" | "delete" | null>(null);
      const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);

      // --- 表单字段（新建/编辑共用） ---
      const [formName, setFormName] = useState("");
      const [formType, setFormType] = useState<"local" | "remote">("local");
      const [formCommand, setFormCommand] = useState("");
      const [formUrl, setFormUrl] = useState("");
      const [formEnvironment, setFormEnvironment] = useState<KeyValueEntry[]>([{ key: "", value: "" }]);
      const [formHeaders, setFormHeaders] = useState<KeyValueEntry[]>([{ key: "", value: "" }]);
      const [formTimeout, setFormTimeout] = useState("");
      const [formSaving, setFormSaving] = useState(false);

      // --- OAuth 字段（仅 remote 类型使用） ---
      const [formOauthClientId, setFormOauthClientId] = useState("");
      const [formOauthClientSecret, setFormOauthClientSecret] = useState("");
      const [formOauthScope, setFormOauthScope] = useState("");
      const [formOauthRedirectUri, setFormOauthRedirectUri] = useState("");
    ```

  - 原因: 表单字段需覆盖 local（command + environment + timeout）和 remote（url + headers + oauth 四字段 + timeout）两种模式的全部输入

- [ ] 实现 `loadServers` 数据加载函数和 `useEffect` — 页面挂载时加载 MCP 服务器列表
  - 位置: `web/src/pages/McpPage.tsx` state 声明之后
  - 实现逻辑（参照 SkillsPage 的 `loadSkills` 模式）：

    ```typescript
      const loadServers = useCallback(async () => {
        setLoading(true);
        try {
          const data = await apiListMcpServers();
          setServers(data);
        } catch (e) {
          toast.error("加载 MCP 服务器列表失败: " + (e instanceof Error ? e.message : "未知错误"));
        } finally {
          setLoading(false);
        }
      }, []);

      useEffect(() => { loadServers(); }, [loadServers]);
    ```

  - 原因: 页面加载时获取服务器列表，失败时显示 toast 错误提示

- [ ] 定义 DataTable 列配置 `columns` — 声明名称、类型、状态、简要描述、超时 5 列
  - 位置: `web/src/pages/McpPage.tsx` `useEffect` 之后
  - 列定义：

    ```typescript
      const columns: Column<McpServerInfo>[] = [
        { key: "name", header: "名称", sortable: true, filterable: true },
        {
          key: "type",
          header: "类型",
          filterable: true,
          render: (row) => (
            <StatusBadge status={row.type === "local" ? "local" : row.type === "remote" ? "remote" : "disabled"} />
          ),
        },
        {
          key: "enabled",
          header: "状态",
          filterable: true,
          render: (row) => <StatusBadge status={row.enabled ? "enabled" : "disabled"} />,
        },
        { key: "summary", header: "简要描述" },
        {
          key: "timeout",
          header: "超时(ms)",
          render: (row) => row.timeout != null ? `${row.timeout}ms` : "默认",
        },
      ];
    ```

  - 原因: StatusBadge 组件用于类型和状态的彩色标签展示，timeout 列展示配置的超时时间或默认值

- [ ] 实现 `handleOpenCreate` 函数 — 重置全部表单字段并打开新建对话框
  - 位置: `web/src/pages/McpPage.tsx` 列定义之后
  - 实现逻辑：

    ```typescript
      const handleOpenCreate = () => {
        setEditingServer(null);
        setFormName("");
        setFormType("local");
        setFormCommand("");
        setFormUrl("");
        setFormEnvironment([{ key: "", value: "" }]);
        setFormHeaders([{ key: "", value: "" }]);
        setFormTimeout("");
        setFormOauthClientId("");
        setFormOauthClientSecret("");
        setFormOauthScope("");
        setFormOauthRedirectUri("");
        setDialogOpen(true);
      };
    ```

  - 原因: 新建时所有字段重置为空，type 默认为 "local"

- [ ] 实现 `handleOpenEdit` 函数 — 调用 `apiGetMcpServer` 获取详情后填充表单字段并打开编辑对话框
  - 位置: `web/src/pages/McpPage.tsx` `handleOpenCreate` 之后
  - 实现逻辑：

    ```typescript
      const handleOpenEdit = async (server: McpServerInfo) => {
        setEditingServer(server);
        setFormName(server.name);
        try {
          const detail = await apiGetMcpServer(server.name);
          const config = detail.config;
          if (config.type === "local") {
            setFormType("local");
            setFormCommand(commandToString(config.command));
            setFormEnvironment(
              config.environment
                ? Object.entries(config.environment).map(([key, value]) => ({ key, value }))
                : [{ key: "", value: "" }]
            );
            setFormHeaders([{ key: "", value: "" }]);
            setFormTimeout(config.timeout != null ? String(config.timeout) : "");
            setFormUrl("");
            setFormOauthClientId("");
            setFormOauthClientSecret("");
            setFormOauthScope("");
            setFormOauthRedirectUri("");
          } else if (config.type === "remote") {
            setFormType("remote");
            setFormUrl(config.url);
            setFormHeaders(
              config.headers
                ? Object.entries(config.headers).map(([key, value]) => ({ key, value }))
                : [{ key: "", value: "" }]
            );
            setFormEnvironment([{ key: "", value: "" }]);
            setFormCommand("");
            setFormTimeout(config.timeout != null ? String(config.timeout) : "");
            if (config.oauth && typeof config.oauth === "object") {
              setFormOauthClientId(config.oauth.clientId ?? "");
              setFormOauthClientSecret(config.oauth.clientSecret ?? "");
              setFormOauthScope(config.oauth.scope ?? "");
              setFormOauthRedirectUri(config.oauth.redirectUri ?? "");
            } else {
              setFormOauthClientId("");
              setFormOauthClientSecret("");
              setFormOauthScope("");
              setFormOauthRedirectUri("");
            }
          }
        } catch {
          toast.error("加载服务器详情失败");
        }
        setDialogOpen(true);
      };
    ```

  - 原因: 编辑时需根据 config.type 区分 local/remote，分别填充对应字段，`Record<string, string>` 转为 `KeyValueEntry[]`

- [ ] 实现 `handleSave` 函数 — 校验表单后调用 `apiCreateMcpServer` 或 `apiUpdateMcpServer` 提交数据
  - 位置: `web/src/pages/McpPage.tsx` `handleOpenEdit` 之后
  - 实现逻辑：

    ```typescript
      const handleSave = async () => {
        const err = validateMcpForm(formName, formType, formCommand, formUrl);
        if (err) { toast.error(err); return; }
        setFormSaving(true);
        try {
          const payload = buildMcpPayload(
            formType, formCommand, formUrl, formEnvironment, formHeaders,
            formOauthClientId, formOauthClientSecret, formOauthScope, formOauthRedirectUri,
            formTimeout,
          );
          if (editingServer) {
            await apiUpdateMcpServer(formName, payload);
            toast.success("服务器已更新");
          } else {
            await apiCreateMcpServer(formName, payload);
            toast.success("服务器已创建");
          }
          setDialogOpen(false);
          loadServers();
        } catch (e) {
          toast.error("保存失败: " + (e instanceof Error ? e.message : "未知错误"));
        } finally {
          setFormSaving(false);
        }
      };
    ```

  - 原因: 新建/编辑共用一个保存函数，通过 `editingServer` 是否为 null 区分调用 create 还是 update

- [ ] 实现 `handleToggle`、`confirmDelete`、`handleBatchAction`、`confirmBatchAction` 函数 — 处理启用/禁用、删除、批量操作
  - 位置: `web/src/pages/McpPage.tsx` `handleSave` 之后
  - 实现逻辑（参照 SkillsPage 的同名函数模式）：

    ```typescript
      const handleToggle = async (server: McpServerInfo) => {
        try {
          if (server.enabled) {
            await apiDisableMcpServer(server.name);
            toast.success(`已禁用 "${server.name}"`);
          } else {
            await apiEnableMcpServer(server.name);
            toast.success(`已启用 "${server.name}"`);
          }
          loadServers();
        } catch (e) {
          toast.error("操作失败: " + (e instanceof Error ? e.message : "未知错误"));
        }
      };

      const confirmDelete = async () => {
        if (!deleteTarget) return;
        try {
          await apiDeleteMcpServer(deleteTarget);
          toast.success("服务器已删除");
          setConfirmOpen(false);
          loadServers();
        } catch (e) {
          toast.error("删除失败: " + (e instanceof Error ? e.message : "未知错误"));
        }
      };

      const handleBatchAction = (action: "enable" | "disable" | "delete") => {
        setBatchAction(action);
        setBatchConfirmOpen(true);
      };

      const confirmBatchAction = async () => {
        try {
          if (batchAction === "delete") {
            await Promise.all(selected.map((s) => apiDeleteMcpServer(s.name)));
            toast.success(`已删除 ${selected.length} 个服务器`);
          } else if (batchAction === "enable") {
            await Promise.all(selected.filter((s) => !s.enabled).map((s) => apiEnableMcpServer(s.name)));
            toast.success(`已启用 ${selected.length} 个服务器`);
          } else {
            await Promise.all(selected.filter((s) => s.enabled).map((s) => apiDisableMcpServer(s.name)));
            toast.success(`已禁用 ${selected.length} 个服务器`);
          }
          setBatchConfirmOpen(false);
          setSelected([]);
          loadServers();
        } catch (e) {
          toast.error("批量操作失败: " + (e instanceof Error ? e.message : "未知错误"));
        }
      };
    ```

  - 原因: 与 SkillsPage 保持完全一致的启用/禁用/删除/批量操作模式，仅替换 API 调用和 toast 文案

- [ ] 实现 loading 骨架屏 JSX — 页面加载中时展示骨架占位（参照 SkillsPage 的 loading 模式）
  - 位置: `web/src/pages/McpPage.tsx` 事件处理函数之后，return 的第一个分支
  - 实现：

    ```typescript
      if (loading) {
        return (
          <div className="p-6 space-y-4">
            <div className="flex items-center justify-between">
              <Skeleton className="h-7 w-32" />
              <Skeleton className="h-9 w-24" />
            </div>
            <div className="rounded-md border">
              <Skeleton className="h-10 w-full rounded-t-md" />
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full rounded-none border-t" />
              ))}
            </div>
          </div>
        );
      }
    ```

  - 原因: 保持与 SkillsPage/AgentsPage 一致的加载骨架屏样式

- [ ] 实现主渲染 JSX — 包含页面标题、DataTable、BatchActionBar、FormDialog、ConfirmDialog
  - 位置: `web/src/pages/McpPage.tsx` loading 骨架屏之后，作为最终 return
  - DataTable 的 actions 回调（每行操作按钮）：

    ```typescript
    actions={(row) => (
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => handleToggle(row)}>
          {row.enabled ? "禁用" : "启用"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => handleOpenEdit(row)}>编辑</Button>
        <Button size="sm" variant="destructive"
          onClick={() => { setDeleteTarget(row.name); setConfirmOpen(true); }}>删除</Button>
      </div>
    )}
    ```

  - BatchActionBar 配置（参照 SkillsPage）：

    ```typescript
    {selected.length > 0 && (
      <BatchActionBar
        selectedCount={selected.length}
        onClear={() => setSelected([])}
        actions={[
          { label: "批量启用", onClick: () => handleBatchAction("enable") },
          { label: "批量禁用", onClick: () => handleBatchAction("disable") },
          { label: "批量删除", variant: "destructive", onClick: () => handleBatchAction("delete") },
        ]}
      />
    )}
    ```

  - ConfirmDialog（单个删除）：

    ```typescript
    <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen}
      title="确认删除" description={`此操作不可逆。确定要删除 MCP 服务器 "${deleteTarget}" 吗？`}
      variant="destructive" onConfirm={confirmDelete} />
    ```

  - ConfirmDialog（批量操作）：

    ```typescript
    <ConfirmDialog open={batchConfirmOpen} onOpenChange={setBatchConfirmOpen}
      title={`批量${batchAction === "delete" ? "删除" : batchAction === "enable" ? "启用" : "禁用"}确认`}
      description={`确定要${batchAction === "delete" ? "删除" : batchAction === "enable" ? "启用" : "禁用"}选中的 ${selected.length} 个服务器吗？${batchAction === "delete" ? "此操作不可逆。" : ""}`}
      variant={batchAction === "delete" ? "destructive" : "default"}
      onConfirm={confirmBatchAction} />
    ```

  - 原因: DataTable/FormDialog/ConfirmDialog/BatchActionBar 的组合使用与 SkillsPage 完全一致

- [ ] 实现 FormDialog 表单内容 JSX — 根据 `formType` 动态切换 local/remote 表单字段
  - 位置: `web/src/pages/McpPage.tsx` 主渲染 JSX 内，在 ConfirmDialog 之前
  - FormDialog 包裹：

    ```typescript
    <FormDialog open={dialogOpen} onOpenChange={setDialogOpen}
      title={editingServer ? "编辑 MCP 服务器" : "新建 MCP 服务器"}
      onSubmit={handleSave} loading={formSaving} width="sm:max-w-2xl">
      <div className="space-y-4">
    ```

  - 通用字段（名称 + 类型选择 + 超时）：

    ```typescript
        <div>
          <Label>名称</Label>
          <Input value={formName} onChange={(e) => setFormName(e.target.value)}
            disabled={!!editingServer} placeholder="例如 my-mcp-server" />
        </div>
        <div>
          <Label>类型</Label>
          <Select value={formType} onValueChange={(v) => setFormType(v as "local" | "remote")}
            disabled={!!editingServer}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="local">Local（命令行启动）</SelectItem>
              <SelectItem value="remote">Remote（URL 连接）</SelectItem>
            </SelectContent>
          </Select>
        </div>
    ```

  - Local 类型字段（命令 + 环境变量键值对列表），使用条件渲染 `{formType === "local" && (...)}`：

    ```typescript
        {formType === "local" && (
          <>
            <div>
              <Label>命令（空格分隔，含引号参数用双引号包裹）</Label>
              <Input value={formCommand} onChange={(e) => setFormCommand(e.target.value)}
                placeholder="npx @anthropic/mcp-server-xxx --arg1 val1" />
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label>环境变量</Label>
                <Button type="button" size="sm" variant="outline"
                  onClick={() => setFormEnvironment([...formEnvironment, { key: "", value: "" }])}>
                  添加
                </Button>
              </div>
              {formEnvironment.map((entry, idx) => (
                <div key={idx} className="flex gap-2 mb-2 items-center">
                  <Input placeholder="KEY" value={entry.key}
                    onChange={(e) => {
                      const next = [...formEnvironment];
                      next[idx] = { ...next[idx], key: e.target.value };
                      setFormEnvironment(next);
                    }} className="flex-1" />
                  <Input placeholder="VALUE" value={entry.value}
                    onChange={(e) => {
                      const next = [...formEnvironment];
                      next[idx] = { ...next[idx], value: e.target.value };
                      setFormEnvironment(next);
                    }} className="flex-1" />
                  <Button type="button" size="sm" variant="ghost"
                    onClick={() => setFormEnvironment(formEnvironment.filter((_, i) => i !== idx))}>
                    删除
                  </Button>
                </div>
              ))}
            </div>
          </>
        )}
    ```

  - Remote 类型字段（URL + 请求头键值对列表 + OAuth 四字段），使用条件渲染 `{formType === "remote" && (...)}`：

    ```typescript
        {formType === "remote" && (
          <>
            <div>
              <Label>URL</Label>
              <Input value={formUrl} onChange={(e) => setFormUrl(e.target.value)}
                placeholder="https://example.com/mcp" />
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label>请求头</Label>
                <Button type="button" size="sm" variant="outline"
                  onClick={() => setFormHeaders([...formHeaders, { key: "", value: "" }])}>
                  添加
                </Button>
              </div>
              {formHeaders.map((entry, idx) => (
                <div key={idx} className="flex gap-2 mb-2 items-center">
                  <Input placeholder="Header Name" value={entry.key}
                    onChange={(e) => {
                      const next = [...formHeaders];
                      next[idx] = { ...next[idx], key: e.target.value };
                      setFormHeaders(next);
                    }} className="flex-1" />
                  <Input placeholder="Header Value" value={entry.value}
                    onChange={(e) => {
                      const next = [...formHeaders];
                      next[idx] = { ...next[idx], value: e.target.value };
                      setFormHeaders(next);
                    }} className="flex-1" />
                  <Button type="button" size="sm" variant="ghost"
                    onClick={() => setFormHeaders(formHeaders.filter((_, i) => i !== idx))}>
                    删除
                  </Button>
                </div>
              ))}
            </div>
            <div className="space-y-4 rounded-lg border p-4">
              <Label className="text-sm font-medium">OAuth 配置（可选）</Label>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Client ID</Label>
                  <Input value={formOauthClientId}
                    onChange={(e) => setFormOauthClientId(e.target.value)} placeholder="可选" />
                </div>
                <div>
                  <Label>Client Secret</Label>
                  <Input type="password" value={formOauthClientSecret}
                    onChange={(e) => setFormOauthClientSecret(e.target.value)} placeholder="可选" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Scope</Label>
                  <Input value={formOauthScope}
                    onChange={(e) => setFormOauthScope(e.target.value)} placeholder="可选" />
                </div>
                <div>
                  <Label>Redirect URI</Label>
                  <Input value={formOauthRedirectUri}
                    onChange={(e) => setFormOauthRedirectUri(e.target.value)} placeholder="可选" />
                </div>
              </div>
            </div>
          </>
        )}
    ```

  - 超时字段（两种类型共用，放在条件渲染之后）：

    ```typescript
        <div>
          <Label>超时时间（毫秒，留空使用默认值）</Label>
          <Input type="number" value={formTimeout}
            onChange={(e) => setFormTimeout(e.target.value)}
            placeholder="例如 5000" min={1} />
        </div>
      </div>
    </FormDialog>
    ```

  - 键值对列表编辑器的实现思路说明：每行包含两个 Input（key/value）和一个删除 Button，底部有"添加"按钮。通过 `map` 遍历 `KeyValueEntry[]` 数组渲染行，修改时通过索引替换对应元素，删除时通过 `filter` 移除对应索引项。编辑模式下名称和类型字段置为 disabled，防止修改已有服务器的标识。
  - 原因: local 和 remote 表单字段差异大，使用条件渲染动态切换；键值对编辑器复用于 environment 和 headers

- [ ] 为 McpPage 导出的纯工具函数编写单元测试 — 验证校验、转换、组装逻辑的正确性
  - 测试文件: `web/src/__tests__/config-mcp-page.test.ts`
  - 测试框架: `bun:test`，参照 `config-skills-page.test.ts` 的 import 模式（从页面文件直接导入导出函数）
  - 测试场景:
    - `validateMcpForm` 空名称: `validateMcpForm("", "local", "npx", "")` → 返回 `"名称不能为空"`
    - `validateMcpForm` 无效名称（大写）: `validateMcpForm("UPPER", "local", "npx", "")` → 返回包含"小写字母"的错误
    - `validateMcpForm` 名称含连字符开头: `validateMcpForm("-abc", "local", "npx", "")` → 返回名称格式错误
    - `validateMcpForm` 名称超长: `validateMcpForm("a".repeat(65), "local", "npx", "")` → 返回长度超限错误
    - `validateMcpForm` local 缺少命令: `validateMcpForm("test", "local", "", "")` → 返回 `"命令不能为空"`
    - `validateMcpForm` remote 缺少 URL: `validateMcpForm("test", "remote", "", "")` → 返回 `"URL 不能为空"`
    - `validateMcpForm` remote 无效 URL: `validateMcpForm("test", "remote", "", "not-a-url")` → 返回 `"URL 格式不正确"`
    - `validateMcpForm` 合法 local: `validateMcpForm("my-server", "local", "npx mcp-srv", "")` → 返回 `null`
    - `validateMcpForm` 合法 remote: `validateMcpForm("my-server", "remote", "", "https://example.com/mcp")` → 返回 `null`
    - `parseCommandString` 基本拆分: `parseCommandString("npx mcp-server --arg val")` → `["npx", "mcp-server", "--arg", "val"]`
    - `parseCommandString` 含引号参数: `parseCommandString('cmd "arg with space" last')` → `["cmd", "arg with space", "last"]`
    - `parseCommandString` 空字符串: `parseCommandString("")` → `[]`
    - `commandToString` 基本转换: `commandToString(["npx", "mcp-server"])` → `"npx mcp-server"`
    - `commandToString` 含空格参数加引号: `commandToString(["cmd", "arg with space"])` → `'cmd "arg with space"'`
    - `buildMcpSummary` local 配置: `buildMcpSummary({ type: "local", command: ["npx", "srv"] })` → `"npx"`
    - `buildMcpSummary` remote 配置: `buildMcpSummary({ type: "remote", url: "https://x.com" })` → `"https://x.com"`
    - `buildMcpSummary` 禁用变体: `buildMcpSummary({ enabled: false })` → `"已禁用"`
    - `buildMcpPayload` local 完整: `buildMcpPayload("local", "npx srv", "", [{ key: "K", value: "V" }], [], "", "", "", "", "5000")` → 对象 type 为 "local"，command 为 `["npx", "srv"]`，environment 为 `{ K: "V" }`，timeout 为 5000
    - `buildMcpPayload` remote 带 OAuth: `buildMcpPayload("remote", "", "https://x.com", [], [{ key: "Auth", value: "Bearer t" }], "id1", "sec1", "read", "https://cb", "")` → 对象 type 为 "remote"，url 为 "<https://x.com"，headers> 为 `{ Auth: "Bearer t" }`，oauth 包含四个字段
    - `buildMcpPayload` 过滤空键值对: 传入含空 key 的 environment 条目 → environment 为 undefined（被过滤掉）
  - 运行命令: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-mcp-page.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [ ] 验证 McpPage.tsx 文件已创建且导出 McpPage 组件
  - `grep -c "export function McpPage" web/src/pages/McpPage.tsx`
  - 预期: 输出 1
- [ ] 验证导出的纯工具函数数量（validateMcpForm、parseCommandString、commandToString、buildMcpSummary、buildMcpPayload 共 5 个，加 KeyValueEntry 类型）
  - `grep -c "export function\|export type" web/src/pages/McpPage.tsx`
  - 预期: 输出 6（5 个函数 + 1 个类型）
- [ ] 验证 McpPage 引用了全部 7 个 MCP API 函数
  - `grep -oE "api[A-Z][a-zA-Z]*Mcp[a-zA-Z]*" web/src/pages/McpPage.tsx | sort -u`
  - 预期: 输出 7 个函数名：apiCreateMcpServer, apiDeleteMcpServer, apiDisableMcpServer, apiEnableMcpServer, apiGetMcpServer, apiListMcpServers, apiUpdateMcpServer
- [ ] 验证 DataTable 包含 5 列（name, type, enabled, summary, timeout）
  - `grep -oE 'key: "[a-z]+"' web/src/pages/McpPage.tsx | head -5`
  - 预期: 输出包含 name、type、enabled、summary、timeout
- [ ] 验证表单包含 local/remote 条件渲染
  - `grep -c 'formType === "local"\|formType === "remote"' web/src/pages/McpPage.tsx`
  - 预期: 输出至少 2（两处条件渲染）
- [ ] 验证键值对编辑器包含"添加"和"删除"按钮
  - `grep -c "添加\|删除" web/src/pages/McpPage.tsx`
  - 预期: 输出至少 4（environment 添加/删除 + headers 添加/删除）
- [ ] 验证 OAuth 字段存在
  - `grep "formOauthClientId\|formOauthClientSecret\|formOauthScope\|formOauthRedirectUri" web/src/pages/McpPage.tsx | wc -l`
  - 预期: 输出大于 4（useState + onChange/setState 多处引用）
- [ ] 验证使用了 DataTable、FormDialog、ConfirmDialog、BatchActionBar、StatusBadge 五个配置组件
  - `grep -c "DataTable\|FormDialog\|ConfirmDialog\|BatchActionBar\|StatusBadge" web/src/pages/McpPage.tsx`
  - 预期: 输出至少 8（import + JSX 使用）
- [ ] 运行 McpPage 纯函数单元测试
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-mcp-page.test.ts`
  - 预期: 所有测试通过，无失败用例
- [ ] 验证 TypeScript 编译通过
  - `cd /Users/konghayao/code/pazhou/remote-control-server/web && npx tsc --noEmit --pretty 2>&1 | tail -5`
  - 预期: 无错误输出

---

### Task 5: 路由集成

**背景:**
Task 4 已完成 McpPage.tsx 页面组件的开发，但该页面尚未接入应用路由系统。当前 App.tsx 的 `configViews` 数组仅包含 `["models", "agents", "skills"]`，`ViewId` 类型缺少 `"mcp"`，侧栏 footer 没有 MCP 入口，主渲染区域也没有对应的路由分支。本 Task 将 MCP 页面集成到 App.tsx 的路由体系中，使用户可通过侧栏导航访问 MCP 配置页面。本 Task 依赖 Task 4（McpPage 组件导出）的输出。

**涉及文件:**

- 修改: `web/src/App.tsx`
- 新建: `web/src/__tests__/config-mcp-routing.test.ts`

**执行步骤:**

- [ ] 在 `web/src/App.tsx` 的 lucide-react 导入语句中添加 `Plug` 图标
  - 位置: `web/src/App.tsx` 第 8-16 行，lucide-react import 块
  - 当前导入列表末尾为 `Wrench,`
  - 在 `Wrench` 之后添加: `Plug,`
  - 替换后的完整导入:

    ```typescript
    import {
      LayoutDashboard,
      MessageSquare,
      KeyRound,
      LogOut,
      Cpu,
      Bot,
      Wrench,
      Plug,
    } from "lucide-react";
    ```

  - 原因: 侧栏 MCP 入口需要图标，`Plug` 语义契合 MCP（Model Context Protocol）的"插件/连接"概念

- [ ] 在 `web/src/App.tsx` 的 lazy import 区域添加 McpPage 的懒加载导入
  - 位置: `web/src/App.tsx` 第 22 行（`SkillsPage` 的 lazy import 之后）
  - 在 SkillsPage 的 lazy import 之后插入:

    ```typescript
    const McpPage = lazy(() => import("./pages/McpPage").then((m) => ({ default: m.McpPage })));
    ```

  - 原因: 与 ModelsPage/AgentsPage/SkillsPage 保持一致的 lazy import 模式，实现路由级代码分割

- [ ] 在 `parseConfigView` 函数中将 `"mcp"` 加入 `configViews` 数组
  - 位置: `web/src/App.tsx` 第 25 行
  - 当前: `const configViews = ["models", "agents", "skills"];`
  - 替换为: `const configViews = ["models", "agents", "skills", "mcp"];`
  - 原因: 使 `parseConfigView("/code/mcp")` 返回 `"mcp"`，正确解析 MCP 路由路径

- [ ] 扩展 `ViewId` 类型，加入 `"mcp"`
  - 位置: `web/src/App.tsx` 第 30 行
  - 当前: `type ViewId = "dashboard" | "session" | "apikeys" | "login" | "models" | "agents" | "skills";`
  - 替换为: `type ViewId = "dashboard" | "session" | "apikeys" | "login" | "models" | "agents" | "skills" | "mcp";`
  - 原因: `configView as ViewId` 的类型断言需要 ViewId 包含 "mcp"，否则编译报错

- [ ] 在 `parseRoute` 回调中将 `"mcp"` 加入 `configViews` 数组
  - 位置: `web/src/App.tsx` 第 41 行
  - 当前: `const configViews = ["models", "agents", "skills"];`
  - 替换为: `const configViews = ["models", "agents", "skills", "mcp"];`
  - 原因: `parseRoute` 内部的 configViews 数组与 `parseConfigView` 必须保持一致，否则运行时路由解析与导出函数行为不一致

- [ ] 在 `footerItems` useMemo 中添加 MCP 侧栏入口 — 插入到 skills 和 logout 之间
  - 位置: `web/src/App.tsx` 第 145 行（skills 对象的 `},` 之后，logout 对象之前）
  - 在 skills 的 `},` 之后插入:

    ```typescript
    {
      id: "mcp",
      label: "MCP",
      icon: <Plug className="h-4 w-4" />,
      active: activeView === "mcp",
      onClick: () => navigateToConfig("mcp"),
    },
    ```

  - 原因: MCP 入口位于 skills 下方、logout 上方，与 models/agents/skills 保持一致的侧栏排列顺序

- [ ] 在 `pageTitle` useMemo 的 `titles` 对象中添加 mcp 的中文标题
  - 位置: `web/src/App.tsx` 第 157 行
  - 当前: `const titles: Record<string, string> = { models: "模型", agents: "Agent", skills: "技能" };`
  - 替换为: `const titles: Record<string, string> = { models: "模型", agents: "Agent", skills: "技能", mcp: "MCP" };`
  - 原因: 使页面顶部标题栏在 MCP 页面时显示 "MCP"（MCP 作为行业术语不翻译为中文）

- [ ] 在主渲染区域的 Suspense 内添加 `configView === "mcp"` 路由分支
  - 位置: `web/src/App.tsx` 第 199 行（`configView === "skills"` 分支的 `)` 之后，`currentSessionId` 分支之前）
  - 在 `) : configView === "skills" ? (\n            <SkillsPage />\n          )` 之后插入:

    ```typescript
          ) : configView === "mcp" ? (
            <McpPage />
    ```

  - 原因: 当 `configView` 为 `"mcp"` 时渲染 McpPage 组件，位于 skills 分支之后、session 分支之前

- [ ] 为 MCP 路由集成编写单元测试 — 验证 parseConfigView 正确识别 mcp 路径
  - 测试文件: `web/src/__tests__/config-mcp-routing.test.ts`
  - 测试框架: `bun:test`，参照 `web/src/__tests__/config-routing.test.ts` 的 import 和测试模式
  - 测试场景:
    - `/code/mcp → mcp`: 调用 `parseConfigView("/code/mcp")` → 返回 `"mcp"`
    - `/code/mcp/ → mcp`: 调用 `parseConfigView("/code/mcp/")` → 返回 `"mcp"`（尾部斜杠不影响）
    - 现有路由不受影响: `parseConfigView("/code/models")` → 返回 `"models"`，`parseConfigView("/code/agents")` → 返回 `"agents"`，`parseConfigView("/code/skills")` → 返回 `"skills"`
    - 非 config 路径返回 null: `parseConfigView("/code/")` → 返回 `null`，`parseConfigView("/code/session-123")` → 返回 `null`
  - 运行命令: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-mcp-routing.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [ ] 验证 Plug 图标已导入
  - `grep "Plug" web/src/App.tsx`
  - 预期: 匹配到 `Plug` 在 lucide-react 导入列表中
- [ ] 验证 McpPage 的 lazy import 存在
  - `grep "McpPage.*lazy" web/src/App.tsx`
  - 预期: 匹配到 `const McpPage = lazy(...)`
- [ ] 验证 parseConfigView 中 configViews 包含 "mcp"
  - `grep -A1 'export function parseConfigView' web/src/App.tsx | grep "mcp"`
  - 预期: 匹配到包含 "mcp" 的 configViews 数组
- [ ] 验证 parseRoute 中 configViews 包含 "mcp"
  - `grep -n 'configViews.*mcp' web/src/App.tsx | wc -l`
  - 预期: 输出 2（parseConfigView 和 parseRoute 两处）
- [ ] 验证 ViewId 类型包含 "mcp"
  - `grep 'ViewId.*mcp' web/src/App.tsx`
  - 预期: 匹配到 `"mcp"` 在 ViewId 联合类型中
- [ ] 验证 footerItems 包含 MCP 入口
  - `grep -A2 'id: "mcp"' web/src/App.tsx`
  - 预期: 匹配到 `id: "mcp"`、`label: "MCP"`、`Plug`
- [ ] 验证 pageTitle 的 titles 对象包含 mcp 键
  - `grep 'mcp: "MCP"' web/src/App.tsx`
  - 预期: 匹配到 `mcp: "MCP"`
- [ ] 验证主渲染区域包含 mcp 路由分支
  - `grep 'configView === "mcp"' web/src/App.tsx`
  - 预期: 匹配到 1 处（主渲染条件分支）
- [ ] 运行 MCP 路由集成单元测试
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-mcp-routing.test.ts`
  - 预期: 所有测试通过，无失败用例
- [ ] 验证现有 config-routing 测试不受影响
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-routing.test.ts`
  - 预期: 所有测试通过（models/agents/skills 路由正常解析）
- [ ] 验证 TypeScript 编译通过
  - `cd /Users/konghayao/code/pazhou/remote-control-server/web && npx tsc --noEmit --pretty 2>&1 | tail -5`
  - 预期: 无错误输出

---

### Task 6: MCP 面板配置 验收

**前置条件:**

- 启动命令: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run src/index.ts`
- 测试数据准备: 确保 `~/.config/opencode/opencode.json` 存在（不存在则创建空对象 `{}`）
- 前端开发服务器: `cd /Users/konghayao/code/pazhou/remote-control-server/web && bunx vite`（浏览器访问 `http://localhost:5173`）

**端到端验证:**

1. 运行完整测试套件确保无回归
   - `cd /Users/konghayao/code/pazhou/remote-control-server && bun test`
   - 预期: 全部测试通过
   - 失败排查: 检查各 Task 的单元测试步骤（Task 1-5 各自的测试文件）

2. 验证 MCP 后端 API 可访问且返回空列表
   - `curl -s -b <session-cookie> http://localhost:3001/web/config/mcp -H 'Content-Type: application/json' -d '{"action":"list"}' | jq .data.servers`
   - 预期: 返回空数组 `[]`
   - 失败排查: 检查 Task 2（后端 MCP 路由）的路由注册和 sessionAuth 中间件

3. 验证创建 local 类型 MCP 服务器
   - `curl -s -b <session-cookie> http://localhost:3001/web/config/mcp -H 'Content-Type: application/json' -d '{"action":"create","name":"test-local","config":{"type":"local","command":["npx","mcp-server"],"environment":{"KEY":"VALUE"},"timeout":5000}}' | jq .data`
   - 预期: 返回 `{ "name": "test-local" }`
   - 失败排查: 检查 Task 2 的 handleCreate 校验逻辑

4. 验证创建 remote 类型 MCP 服务器
   - `curl -s -b <session-cookie> http://localhost:3001/web/config/mcp -H 'Content-Type: application/json' -d '{"action":"create","name":"test-remote","config":{"type":"remote","url":"https://example.com/mcp","headers":{"Auth":"Bearer t"},"timeout":10000}}' | jq .data`
   - 预期: 返回 `{ "name": "test-remote" }`
   - 失败排查: 检查 Task 2 的 validateMcpConfig 对 remote 类型的校验

5. 验证列表返回两个服务器且类型和摘要正确
   - `curl -s -b <session-cookie> <http://localhost:3001/web/config/mcp> -H 'Content-Type: application/json' -d '{"action":"list"}' | jq '.data.servers[] | {name, type, summary, enabled}'
   - 预期: 返回两个服务器，test-local 的 type 为 "local"、summary 为 "npx"，test-remote 的 type 为 "remote"、summary 为 URL
   - 失败排查: 检查 Task 2 的 toServerInfo 函数

6. 验证 opencode.json 中 mcp 字段已正确写入
   - `cat ~/.config/opencode/opencode.json | jq .mcp`
   - 预期: 包含 test-local 和 test-remote 两个键，结构与创建请求一致
   - 失败排查: 检查 Task 2 的 replaceSection 调用

7. 验证禁用/启用服务器
   - `curl -s -b <session-cookie> http://localhost:3001/web/config/mcp -H 'Content-Type: application/json' -d '{"action":"disable","name":"test-local"}' && curl -s -b <session-cookie> http://localhost:3001/web/config/mcp -H 'Content-Type: application/json' -d '{"action":"list"}' | jq '.data.servers[] | select(.name=="test-local") | .enabled'`
   - 预期: 输出 `false`，再启用后输出 `true`
   - 失败排查: 检查 Task 2 的 handleDisable/handleEnable

8. 验证删除服务器
   - `curl -s -b <session-cookie> http://localhost:3001/web/config/mcp -H 'Content-Type: application/json' -d '{"action":"delete","name":"test-local"}' | jq .success`
   - 预期: 返回 `true`
   - 失败排查: 检查 Task 2 的 handleDelete

9. 验证前端构建无错误
   - `cd /Users/konghayao/code/pazhou/remote-control-server/web && npx vite build 2>&1 | tail -5`
   - 预期: 构建成功，输出包含 "built in"
   - 失败排查: 检查 Task 1-5 的 TypeScript 类型是否一致

10. 验证前端页面可通过侧栏导航访问
    - 浏览器访问 `http://localhost:5173/code/mcp`（需先登录）
    - 预期: 页面显示 "MCP" 标题、空服务器列表、"新建 MCP 服务器" 按钮
    - 失败排查: 检查 Task 5（路由集成）的 configViews 和渲染分支

11. 验证前端新建 local 类型 MCP 服务器完整流程
    - 先通过步骤 3 的 curl 创建 test-local 服务器（确保列表非空）
    - 浏览器访问 `http://localhost:5173/code/mcp`
    - 点击"新建 MCP 服务器"按钮，选择 Local 类型
    - 填写名称 "ui-local-test"，命令 "npx mcp-server-test"，添加环境变量 KEY=VALUE，超时 3000
    - 点击保存
    - 预期: 对话框关闭，列表中出现 "ui-local-test"，类型为 local，简要描述显示 "npx"，状态为已启用
    - 失败排查: 检查 Task 4（McpPage）的 handleSave 和 FormDialog 表单逻辑

12. 验证前端新建 remote 类型 MCP 服务器完整流程
    - 点击"新建 MCP 服务器"按钮，选择 Remote 类型
    - 填写名称 "ui-remote-test"，URL "<https://example.com/mcp"，添加请求头> Auth=Bearer t，填写 OAuth Client ID "test-id"
    - 点击保存
    - 预期: 对话框关闭，列表中出现 "ui-remote-test"，类型为 remote，简要描述显示 URL，状态为已启用
    - 失败排查: 检查 Task 4 的 FormDialog remote 条件渲染和 buildMcpPayload

13. 验证前端编辑服务器流程
    - 点击 ui-local-test 行的"编辑"按钮
    - 预期: 对话框打开，名称字段为 disabled，类型字段为 disabled，命令字段已填充，环境变量已填充
    - 修改超时时间为 8000，点击保存
    - 预期: 保存成功，重新获取列表后超时列显示 "8000ms"
    - 失败排查: 检查 Task 4 的 handleOpenEdit（apiGetMcpServer + 表单填充）和 handleSave（apiUpdateMcpServer）

14. 验证前端启用/禁用切换
    - 点击 ui-local-test 行的"禁用"按钮
    - 预期: 按钮文字变为"启用"，状态列显示为 disabled 样式
    - 再次点击"启用"按钮
    - 预期: 按钮文字变为"禁用"，状态列恢复为 enabled 样式
    - 失败排查: 检查 Task 4 的 handleToggle 函数

15. 验证前端删除服务器流程
    - 点击 ui-local-test 行的"删除"按钮
    - 预期: 弹出确认对话框，提示"此操作不可逆"
    - 点击确认
    - 预期: 对话框关闭，列表中不再显示 ui-local-test
    - 失败排查: 检查 Task 4 的 confirmDelete 函数和 ConfirmDialog 组件

16. 验证前端批量操作
    - 勾选列表中的多个服务器，验证批量操作栏出现
    - 点击"批量禁用"，确认后验证所有选中服务器状态变为 disabled
    - 点击"批量删除"，确认后验证所有选中服务器从列表中移除
    - 预期: 批量操作正确生效，toast 提示显示操作数量
    - 失败排查: 检查 Task 4 的 handleBatchAction 和 confirmBatchAction 函数

17. 验证配置数据正确写入 opencode.json
    - 通过前端操作确保至少一个服务器存在后，执行: `cat ~/.config/opencode/opencode.json | jq .mcp`
    - 预期: mcp 字段包含已创建的服务器，结构符合 opencode.ai schema（type/command/url 等字段正确）
    - 失败排查: 检查 Task 2 的 replaceSection 调用

18. 清理测试数据
    - `curl -s -b <session-cookie> http://localhost:3001/web/config/mcp -H 'Content-Type: application/json' -d '{"action":"delete","name":"test-remote"}'`
    - 预期: 清理完成，opencode.json 的 mcp 字段恢复为空或不存在

---
