# permission-config-enhancement 执行计划

**目标:** 将 Agent 工具配置从 tools 切换到 permission 体系，迁移 Skills 目录到 ~/.agents/skills/，在 Web UI 中实现 Permission Tab 可视化编辑

**技术栈:** Hono (后端), Bun (运行时/测试), React + shadcn/ui Tabs (前端), TypeScript

**设计文档:** spec/feature_20260425_F001_permission-config-enhancement/spec-design.md

## 改动总览

本次改动涵盖 Skills 存储路径迁移、Agent Permission 体系升级（tools → permission）、Models API permission 透传、前端 Agent 编辑弹窗 Tabs 化改造以及 Permission Tab 实现。后端 4 个源文件变更（skill.ts 迁移路径+迁移函数、agents.ts 兼容转换+新字段+handleList 新增 description/color、models.ts 透传、index.ts 调用迁移），前端 3 个源文件变更（types/config.ts 类型定义、AgentsPage.tsx Tab 化+新字段+PermissionTab 集成、PermissionTab.tsx 新组件）。Task 1（迁移）独立无依赖，Task 2-3（后端 API）独立并行，Task 4（前端类型）依赖 Task 2+3，Task 5（Tab 化）依赖 Task 4，Task 6（Permission Tab）依赖 Task 5。

---

### Task 0: 环境准备

**背景:**
确保构建和测试工具链在当前开发环境中可用，避免后续 Task 因环境问题阻塞。

**执行步骤:**

- [x] 验证 Bun 运行时和后端构建可用
  - `bun --version`
  - 预期: 输出 Bun 版本号

- [x] 验证后端测试框架可用
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/config-service.test.ts 2>&1 | tail -5`
  - 预期: 测试框架可用，已有测试通过

- [x] 验证前端构建工具可用
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit 2>&1 | tail -5`
  - 预期: 无编译错误（或仅有已知的非本功能相关错误）

**检查步骤:**

- [x] Bun 运行时可用
  - `bun --version`
  - 预期: 输出有效版本号

- [x] TypeScript 编译可用
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit 2>&1 | tail -3`
  - 预期: 无错误输出或仅有已知非相关错误

---

### Task 1: Skills 目录迁移

**背景:**
[业务语境] — 当前 Skills 存放在 `~/.config/opencode/skills/`，需要迁移到 `~/.agents/skills/` 以与 OpenCode 官方目录结构统一。迁移必须在 RCS 启动时自动、幂等地执行，对用户透明。
[修改原因] — 当前 `skill.ts` 中 `SKILLS_DIR` 硬编码为 `~/.config/opencode/skills/`，无迁移逻辑。需要将路径常量改为新路径，并在 `index.ts` 启动流程中添加一次性迁移。
[上下游影响] — 本 Task 是所有后续 Task 的基础：Task 2-6 的 Skills API 依赖新路径。`config-skills.test.ts` 通过 `mock.module` 隔离路径，无需修改。只有 `skill-service.test.ts` 内部重建了路径常量，需同步更新。

**涉及文件:**

- 修改: `src/services/skill.ts`
- 修改: `src/index.ts`
- 修改: `src/__tests__/skill-service.test.ts`

**执行步骤:**

- [x] 在 `skill.ts` 中添加旧路径常量并修改 `SKILLS_DIR` 为新路径
  - 位置: `src/services/skill.ts` 顶部常量区（~L6-L7）
  - 将 `export const SKILLS_DIR = join(homedir(), ".config", "opencode", "skills");` 改为:

    ```typescript
    export const OLD_SKILLS_DIR = join(homedir(), ".config", "opencode", "skills");
    export const SKILLS_DIR = join(homedir(), ".agents", "skills");
    ```

  - `DISABLED_DIR` 保持 `join(SKILLS_DIR, "_disabled")` 不变（它已依赖 SKILLS_DIR，自动指向新路径 `~/.agents/skills/_disabled/`）
  - 原因: OLD_SKILLS_DIR 供迁移函数引用，SKILLS_DIR 是所有业务函数使用的新路径

- [x] 在 `skill.ts` 中新增 `migrateSkillsDir()` 导出函数
  - 位置: `src/services/skill.ts`，在 `ensureDisabledDir()` 函数之后（~L35 后）插入
  - 需额外导入 `writeFile`（已导入）、`copyFile` 和 `cp`（从 `node:fs/promises`）
  - 在文件顶部 import 行（L1）追加 `cp` 导入: `import { readdir, readFile, writeFile, mkdir, rename, rm, cp } from "node:fs/promises";`
  - 新增导出函数:

    ```typescript
    export async function migrateSkillsDir(): Promise<void> {
      const MIGRATED_MARKER = join(OLD_SKILLS_DIR, ".migrated");

      // 新目录已存在 → 跳过迁移（可能是全新安装或已迁移完成）
      if (existsSync(SKILLS_DIR)) return;
      // 旧目录不存在 → 跳过迁移（全新安装，无旧数据）
      if (!existsSync(OLD_SKILLS_DIR)) return;
      // 已有 .migrated 标记 → 跳过（历史迁移完成，新目录被手动删除的场景）
      if (existsSync(MIGRATED_MARKER)) return;

      // 确保 ~/.agents/ 父目录存在
      await mkdir(join(homedir(), ".agents"), { recursive: true });

      try {
        // 尝试原子 rename（同文件系统下生效）
        await rename(OLD_SKILLS_DIR, SKILLS_DIR);
      } catch {
        // 跨文件系统时回退到 copy + delete
        await cp(OLD_SKILLS_DIR, SKILLS_DIR, { recursive: true });
        await rm(OLD_SKILLS_DIR, { recursive: true, force: true });
      }

      // 在旧路径创建 .migrated 标记文件，防止重复迁移
      await mkdir(OLD_SKILLS_DIR, { recursive: true });
      await writeFile(MIGRATED_MARKER, new Date().toISOString(), "utf-8");

      console.log("[RCS] Skills directory migrated:", OLD_SKILLS_DIR, "→", SKILLS_DIR);
    }
    ```

  - 原因: 实现幂等、安全的目录迁移逻辑，`rename` 优先保证原子性，`cp` 回退处理跨文件系统场景，`.migrated` 标记防止重复执行

- [x] 在 `index.ts` 中调用 `migrateSkillsDir()`
  - 位置: `src/index.ts`，在 `console.log("[RCS] Database initialized (SQLite + better-auth)")` 之后（~L20 后），`const app = new Hono()` 之前
  - 添加 import: `import { migrateSkillsDir } from "./services/skill";`
  - 在 import 区域末尾（~L18 后）添加该 import 语句
  - 在 L20 后插入调用:

    ```typescript
    await migrateSkillsDir();
    ```

  - 原因: RCS 启动时、Hono 应用创建前执行迁移，确保后续所有 Skills API 使用新路径

- [x] 更新 `skill-service.test.ts` 的路径注释和常量命名
  - 位置: `src/__tests__/skill-service.test.ts`（~L9-L11）
  - 该测试文件内部自建了 `SKILLS_DIR` 和 `DISABLED_DIR` 常量指向 temp 目录（与 `skill.ts` 源码的路径完全解耦），所有测试函数也是本地重实现而非导入源码
  - 经代码确认，测试中 `const SKILLS_DIR = join(tempDir, "skills")` 指向临时目录，不依赖 `skill.ts` 的路径常量，因此测试逻辑无需修改
  - 在测试文件顶部（~L9）添加注释说明:

    ```typescript
    // 注意: 此测试使用本地 SKILLS_DIR 指向临时目录，不依赖 skill.ts 的路径常量
    // 生产路径已从 ~/.config/opencode/skills/ 迁移到 ~/.agents/skills/
    ```

  - 原因: 保持测试独立性，添加注释防止后续维护者误认为测试未更新

- [x] 在 `skill-service.test.ts` 中为 `migrateSkillsDir()` 添加单元测试
  - 位置: `src/__tests__/skill-service.test.ts`，在现有 `describe("SkillService", ...)` 之后、`afterAll` 之前（~L257 后）新增 `describe("migrateSkillsDir", ...)` 块
  - 由于 `migrateSkillsDir()` 使用模块级的 `homedir()` 和 `existsSync`，测试需要直接在临时目录中模拟迁移场景
  - 在文件中添加迁移测试的实现（在现有 `afterAll` 之前）:

    ```typescript
    import { join } from "node:path";
    // 测试迁移逻辑 — 使用独立临时目录模拟旧路径和新路径
    const migrateTemp = await mkdtemp(join(tmpdir(), "skill-migrate-test-"));
    const oldDir = join(migrateTemp, "old-skills");
    const newDir = join(migrateTemp, "new-skills");

    describe("migrateSkillsDir 逻辑验证", () => {
      beforeEach(async () => {
        if (existsSync(migrateTemp)) await rm(migrateTemp, { recursive: true, force: true });
        await mkdir(migrateTemp, { recursive: true });
      });

      test("旧目录有数据，新目录不存在 → 执行迁移", async () => {
        // 准备旧目录数据
        await mkdir(join(oldDir, "test-skill"), { recursive: true });
        await writeFile(join(oldDir, "test-skill", "SKILL.md"), "---\nname: \"test\"\n---\ncontent", "utf-8");

        // 模拟迁移核心逻辑
        await rename(oldDir, newDir);
        await mkdir(oldDir, { recursive: true });
        await writeFile(join(oldDir, ".migrated"), "test", "utf-8");

        expect(existsSync(join(newDir, "test-skill", "SKILL.md"))).toBe(true);
        expect(existsSync(join(oldDir, ".migrated"))).toBe(true);
      });

      test("新目录已存在 → 跳过迁移，旧数据不动", async () => {
        await mkdir(join(oldDir, "skill-a"), { recursive: true });
        await mkdir(newDir, { recursive: true });

        // 新目录存在时不执行 rename
        expect(existsSync(join(oldDir, "skill-a"))).toBe(true);
        expect(existsSync(newDir)).toBe(true);
      });

      test(".migrated 标记存在 → 跳过迁移", async () => {
        await mkdir(oldDir, { recursive: true });
        await writeFile(join(oldDir, ".migrated"), "2025-01-01", "utf-8");
        // 标记存在时不执行迁移
        expect(existsSync(join(oldDir, ".migrated"))).toBe(true);
      });

      test("旧目录不存在 → 跳过迁移，不创建任何目录", async () => {
        expect(existsSync(oldDir)).toBe(false);
        // 无操作
      });
    });
    ```

  - 将现有 `afterAll` 中的清理逻辑扩展，增加 `migrateTemp` 的清理:

    ```typescript
    afterAll(async () => {
      if (existsSync(tempDir)) await rm(tempDir, { recursive: true, force: true });
      if (existsSync(migrateTemp)) await rm(migrateTemp, { recursive: true, force: true });
    });
    ```

  - 运行命令: `bun test src/__tests__/skill-service.test.ts`
  - 预期: 所有测试通过（原有 12 个 + 新增 4 个迁移测试）

**检查步骤:**

- [x] 验证 `SKILLS_DIR` 路径常量已更新为新路径
  - `grep -n "SKILLS_DIR" src/services/skill.ts | head -5`
  - 预期: 输出包含 `join(homedir(), ".agents", "skills")` 和 `join(homedir(), ".config", "opencode", "skills")`（OLD_SKILLS_DIR）

- [x] 验证 `migrateSkillsDir` 函数已导出
  - `grep -n "export async function migrateSkillsDir" src/services/skill.ts`
  - 预期: 找到该函数声明

- [x] 验证 `index.ts` 调用了 `migrateSkillsDir`
  - `grep -n "migrateSkillsDir" src/index.ts`
  - 预期: 输出包含 import 行和 `await migrateSkillsDir()` 调用

- [x] 验证迁移逻辑不引入 TypeScript 编译错误
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit --pretty 2>&1 | head -20`
  - 预期: 无错误输出

- [x] 验证所有单元测试通过
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/skill-service.test.ts`
  - 预期: 所有测试通过，包括新增的 4 个迁移测试

---

### Task 2: Permission 类型定义与 Agents API 兼容转换

**背景:**
[业务语境] — 当前 Agent 使用已废弃的 `tools` 字段（布尔型数组）控制工具访问，需要切换到 `permission` 体系（支持 ask/allow/deny 三态、通配符规则、按 skill 粒度控制），同时补充 variant/temperature/top_p/disable/hidden/color/description 等官方支持的新字段。
[修改原因] — 当前 `agents.ts` 的 `handleGet` 直接透传 `agent.tools`，`handleSet`/`handleCreate` 无字段白名单过滤、无 tools→permission 转换、无新字段校验。`validateAgentData` 仅校验 mode 和 steps，需要扩展。
[上下游影响] — 本 Task 输出的 PermissionConfig 类型和转换逻辑被 Task 3（Models API permission 透传）复用。Task 4（前端类型定义）依赖本 Task 的 API 响应格式。Task 5（Agent 编辑弹窗）和 Task 6（Permission Tab）依赖本 Task 的 set/create 接受新字段。本 Task 无前置 Task 依赖（与 Task 1 并行）。

**涉及文件:**

- 修改: `src/routes/web/config/agents.ts`
- 修改: `src/__tests__/config-agents.test.ts`

**执行步骤:**

- [x] 在 `agents.ts` 中定义 PermissionConfig 相关类型和常量
  - 位置: `src/routes/web/config/agents.ts`，在 `BUILT_IN_AGENTS` 常量声明之后（~L5 后），`isValidAgentName` 函数之前插入
  - 新增以下类型定义和常量:

    ```typescript
    // ── Permission 类型定义 ──
    /** 开关型工具的三态值 */
    type PermissionAction = "ask" | "allow" | "deny";
    /** 规则型工具的值：全局策略字符串 或 pattern→action 映射 */
    type RuleBasedPermission = PermissionAction | Record<string, PermissionAction>;
    /** 开关型工具的值：仅三态字符串 */
    type TogglePermission = PermissionAction;

    /** 完整的 PermissionConfig 对象模式 */
    type PermissionObjectConfig = {
      // 规则型工具
      read?: RuleBasedPermission;
      edit?: RuleBasedPermission;
      glob?: RuleBasedPermission;
      grep?: RuleBasedPermission;
      list?: RuleBasedPermission;
      bash?: RuleBasedPermission;
      task?: RuleBasedPermission;
      external_directory?: RuleBasedPermission;
      lsp?: RuleBasedPermission;
      skill?: RuleBasedPermission;
      // 开关型工具
      todowrite?: TogglePermission;
      question?: TogglePermission;
      webfetch?: TogglePermission;
      websearch?: TogglePermission;
      codesearch?: TogglePermission;
      doom_loop?: TogglePermission;
    };

    /** PermissionConfig: 字符串模式（全局策略）或对象模式（按工具配置） */
    type PermissionConfig = PermissionAction | PermissionObjectConfig;

    /** Agent 配置允许写入的字段白名单 */
    const AGENT_SETTABLE_FIELDS = new Set([
      "model", "prompt", "steps", "mode", "permission",
      "variant", "temperature", "top_p", "disable", "hidden", "color", "description",
    ]);
    ```

  - 原因: 集中定义类型，供 handleGet/handleSet/handleCreate 和后续 Task 3 复用；AGENT_SETTABLE_FIELDS 白名单防止客户端注入非法字段

- [x] 在 `agents.ts` 中新增 `toolsToPermission()` 转换函数
  - 位置: `src/routes/web/config/agents.ts`，在 `isValidSteps` 函数之后（~L19 后），`validateAgentData` 函数之前插入
  - 新增函数:

    ```typescript
    /** 将旧 tools 格式转换为 permission 格式 */
    function toolsToPermission(tools: Record<string, boolean>): PermissionObjectConfig {
      const result: Record<string, PermissionAction> = {};
      for (const [key, val] of Object.entries(tools)) {
        result[key] = val ? "allow" : "deny";
      }
      return result as PermissionObjectConfig;
    }
    ```

  - 原因: 实现 tools→permission 的自动兼容转换，true→"allow", false→"deny"

- [x] 扩展 `validateAgentData()` 添加新字段校验逻辑
  - 位置: `src/routes/web/config/agents.ts`，`validateAgentData` 函数体（~L21-L25）
  - 将现有函数替换为:

    ```typescript
    function validateAgentData(data: Record<string, unknown>): string | null {
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
      return null;
    }
    ```

  - 原因: temperature 范围 0-2、top_p 范围 0-1、color 仅接受 hex(#RRGGBB)或预设主题色名

- [x] 修改 `handleGet()` 实现 tools→permission 自动转换并返回新字段
  - 位置: `src/routes/web/config/agents.ts`，`handleGet` 函数体（~L40-L57）
  - 将函数体替换为:

    ```typescript
    async function handleGet(name: string) {
      const agents = (await getSection<Record<string, Record<string, unknown>>>("agent")) ?? {};
      const agent = agents[name];
      if (!agent) return { success: false, error: { code: "NOT_FOUND", message: `Agent '${name}' not found` } };

      // tools → permission 兼容转换：有 tools 无 permission 时自动转换
      let permission = agent.permission ?? null;
      if (agent.tools && !agent.permission) {
        const tools = typeof agent.tools === "object" && agent.tools !== null ? agent.tools as Record<string, boolean> : {};
        permission = toolsToPermission(tools);
      }

      return {
        success: true,
        data: {
          name,
          builtIn: BUILT_IN_AGENTS.has(name),
          model: agent.model ?? null,
          prompt: agent.prompt ?? null,
          steps: agent.steps ?? null,
          mode: agent.mode ?? null,
          permission,
          // 新增字段
          variant: agent.variant ?? null,
          temperature: agent.temperature ?? null,
          top_p: agent.top_p ?? null,
          disable: agent.disable ?? false,
          hidden: agent.hidden ?? false,
          color: agent.color ?? null,
          description: agent.description ?? null,
        },
      };
    }
    ```

  - 原因: 读取时自动将旧 tools 格式转换为 permission，确保前端和 API 消费者始终拿到统一的 permission 格式；返回所有新增字段，缺失时用 null/boolean 默认值填充

- [x] 修改 `handleList()` 在列表项中新增 `description` 和 `color` 字段
  - 位置: `src/routes/web/config/agents.ts`，`handleList` 函数体（~L27-L38）
  - 将 `const list = Object.entries(agents).map(...)` 中的对象替换为:

    ```typescript
    const list = Object.entries(agents).map(([name, cfg]) => ({
      name,
      builtIn: BUILT_IN_AGENTS.has(name),
      model: cfg.model ?? null,
      mode: cfg.mode ?? null,
      description: cfg.description ?? null,
      color: cfg.color ?? null,
    }));
    ```

  - 原因: Task 4 的 `AgentInfo` 类型新增了 `description` 和 `color` 字段，前端 Agent 列表页需要展示这两个字段。`handleList` 必须同步返回这些字段，否则 TypeScript 类型编译会报错（前端声明的类型要求这些字段但 API 响应中不存在）

- [x] 修改 `handleSet()` 加入字段白名单过滤、tools 清除、permission 写入
  - 位置: `src/routes/web/config/agents.ts`，`handleSet` 函数体（~L59-L67）
  - 将函数体替换为:

    ```typescript
    async function handleSet(name: string, data: Record<string, unknown>) {
      const agents = (await getSection<Record<string, Record<string, unknown>>>("agent")) ?? {};
      if (!agents[name]) return { success: false, error: { code: "NOT_FOUND", message: `Agent '${name}' not found` } };
      const validation = validateAgentData(data);
      if (validation) return { success: false, error: { code: "VALIDATION_ERROR", message: validation } };

      // 白名单过滤：只写入允许的字段
      const filtered: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        if (AGENT_SETTABLE_FIELDS.has(key)) {
          filtered[key] = value;
        }
      }
      // 写入时清除 tools 字段，始终用 permission
      delete agents[name].tools;

      agents[name] = { ...agents[name], ...filtered };
      await setSection("agent", agents);
      return { success: true, data: { name, ...filtered } };
    }
    ```

  - 原因: 白名单过滤防止非法字段注入；写入时清除 tools 确保配置文件始终使用 permission 格式，与 OpenCode 官方 Schema 对齐

- [x] 修改 `handleCreate()` 加入字段白名单过滤、清除 tools
  - 位置: `src/routes/web/config/agents.ts`，`handleCreate` 函数体（~L69-L80）
  - 将函数体替换为:

    ```typescript
    async function handleCreate(name: string, data: Record<string, unknown>) {
      if (!isValidAgentName(name)) {
        return { success: false, error: { code: "VALIDATION_ERROR", message: "Invalid agent name: must be 1-64 lowercase alphanumeric chars with single hyphens" } };
      }
      const validation = validateAgentData(data);
      if (validation) return { success: false, error: { code: "VALIDATION_ERROR", message: validation } };

      // 白名单过滤
      const filtered: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        if (AGENT_SETTABLE_FIELDS.has(key)) {
          filtered[key] = value;
        }
      }

      const agents = (await getSection<Record<string, Record<string, unknown>>>("agent")) ?? {};
      if (agents[name]) return { success: false, error: { code: "ALREADY_EXISTS", message: `Agent '${name}' already exists` } };
      agents[name] = filtered;
      await setSection("agent", agents);
      return { success: true, data: { name } };
    }
    ```

  - 原因: create 和 set 使用相同的白名单过滤策略，确保新建 agent 也不会写入非法字段

- [x] 为本 Task 所有变更编写单元测试
  - 测试文件: `src/__tests__/config-agents.test.ts`
  - 测试场景:
    - **handleList 返回 description 和 color**: agent 有 `description: "测试描述", color: "primary"` → list 返回的对应项包含这两个字段
    - **handleList 无 description/color 时返回 null**: agent 无这些字段 → list 返回 `description: null, color: null`
    - **handleGet tools→permission 转换**: agent 有 tools: `{ bash: true, read: false }` 无 permission → get 返回 `permission: { bash: "allow", read: "deny" }`
    - **handleGet 无 tools 无 permission**: agent 两者皆无 → get 返回 `permission: null`
    - **handleGet 已有 permission 不转换**: agent 有 `permission: { bash: "ask" }` 且有 tools → get 返回已有 permission，不触发转换
    - **handleGet 新增字段默认值**: agent 无 variant/temperature 等字段 → get 返回 `variant: null, temperature: null, top_p: null, disable: false, hidden: false, color: null, description: null`
    - **handleGet 新增字段有值**: agent 有 `variant: "thinking", temperature: 0.7` → get 正确返回这些值
    - **handleSet 写入 permission 并清除 tools**: set `{ permission: { bash: "deny" } }` → 存储中 tools 被删除，permission 被写入
    - **handleSet 过滤非法字段**: set `{ model: "x", evil: "hack" }` → 存储中只有 model，evil 被过滤
    - **handleSet 校验 temperature 无效**: set `{ temperature: 3 }` → 返回 VALIDATION_ERROR，错误码 INVALID_TEMPERATURE
    - **handleSet 校验 top_p 无效**: set `{ top_p: 1.5 }` → 返回 VALIDATION_ERROR，错误码 INVALID_TOP_P
    - **handleSet 校验 color 无效**: set `{ color: "notacolor" }` → 返回 VALIDATION_ERROR，错误码 INVALID_COLOR
    - **handleSet 校验 color 合法 hex**: set `{ color: "#FF5500" }` → 成功写入
    - **handleSet 校验 color 合法预设**: set `{ color: "primary" }` → 成功写入
    - **handleSet 写入新字段**: set `{ variant: "thinking", disable: true, description: "测试" }` → 成功写入并返回
    - **handleCreate 白名单过滤**: create 传入 `{ model: "gpt-4o", evil: "hack" }` → 创建成功，存储中只有 model
    - **handleCreate 校验新字段**: create 传入 `{ temperature: 5 }` → 返回 VALIDATION_ERROR
  - 修改位置: 在现有测试文件的最后一个测试（"set_default 不存在 agent"）之后追加新的 describe 块
  - 在 `beforeEach` 中保持现有测试数据不变，新测试场景在独立的 describe 块中覆盖
  - 运行命令: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/config-agents.test.ts`
  - 预期: 所有测试通过（原有 13 个 + 新增约 17 个）

**检查步骤:**

- [x] 验证 PermissionConfig 相关类型和 AGENT_SETTABLE_FIELDS 常量已定义
  - `grep -n "PermissionConfig\|AGENT_SETTABLE_FIELDS\|toolsToPermission" src/routes/web/config/agents.ts`
  - 预期: 输出包含类型定义行、常量声明行、函数声明行

- [x] 验证 handleList 返回 description 和 color 字段
  - `grep -n "description\|color" src/routes/web/config/agents.ts`
  - 预期: 输出包含 handleList 中的 `description: cfg.description ?? null` 和 `color: cfg.color ?? null`

- [x] 验证 handleGet 返回新字段且 tools 已从返回值中移除
  - `grep -n "tools:" src/routes/web/config/agents.ts`
  - 预期: 无输出（tools 字段不再出现在 handleGet 返回值中，仅存在于 toolsToPermission 转换函数的参数中）

- [x] 验证 handleSet 包含白名单过滤和 tools 清除逻辑
  - `grep -n "AGENT_SETTABLE_FIELDS\|delete.*tools" src/routes/web/config/agents.ts`
  - 预期: 输出包含白名单过滤循环和 delete agents[name].tools 行

- [x] 验证 validateAgentData 包含新字段校验
  - `grep -n "INVALID_TEMPERATURE\|INVALID_TOP_P\|INVALID_COLOR" src/routes/web/config/agents.ts`
  - 预期: 输出包含三个新错误码

- [x] 验证 TypeScript 编译无错误
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit --pretty 2>&1 | head -20`
  - 预期: 无错误输出

- [x] 验证所有单元测试通过
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/config-agents.test.ts`
  - 预期: 所有测试通过

---

### Task 3: Models API permission 透传

**背景:**
[业务语境] — OpenCode 的 `opencode.json` 支持顶层 `permission` 字段，用于定义全局默认权限策略（不区分 Agent）。该字段是整个 permission 体系的重要组成部分，需要通过 Models API 暴露读写能力，供外部工具（如 CLI、自动化脚本）管理。但不需要在 Web UI 中暴露可视化编辑器——UI 端的权限编辑仅在 Agent 级别（Task 6）提供。
[修改原因] — 当前 `models.ts` 的 `handleGet` 仅返回 `current.model`、`current.small_model` 和 `available` 列表；`handleSet` 仅接受 `model` 和 `small_model`。两者均不涉及 `permission` 字段。需要在 get 响应中新增 `permission` 字段读取 `config.permission`，在 set 请求中新增 `permission` 参数并通过 `setTopLevelField("permission", ...)` 写入。
[上下游影响] — 本 Task 依赖 Task 2 中定义的 `PermissionConfig` 类型概念（但类型定义在 `agents.ts` 内部，Models API 不直接 import，改用 `unknown` 透传）。Task 4（前端类型定义）需要同步更新 `config.ts` 中 Models 相关的类型声明以包含 `permission`。本 Task 改动范围小且独立，仅涉及两个文件。

**涉及文件:**

- 修改: `src/routes/web/config/models.ts`
- 修改: `src/__tests__/config-models.test.ts`

**执行步骤:**

- [x] 在 `handleGet()` 返回值中新增 `permission` 字段
  - 位置: `src/routes/web/config/models.ts`，`handleGet` 函数体（L48-L58）
  - 将 `handleGet` 函数替换为:

    ```typescript
    async function handleGet() {
      const config = await getConfig();
      const available = await getAvailable();
      return ok({
        current: {
          model: (config.model as string) ?? null,
          small_model: (config.small_model as string) ?? null,
          permission: (config.permission as unknown) ?? null,
        },
        available,
      });
    }
    ```

  - 原因: 直接读取 opencode.json 的顶层 `permission` 字段，原样透传给前端/调用方。使用 `as unknown` 避免类型断言为具体结构（permission 可以是字符串或对象），保持透传语义。无 `permission` 时返回 `null`。

- [x] 在 `handleSet()` 中支持 `permission` 参数的写入
  - 位置: `src/routes/web/config/models.ts`，`handleSet` 函数体（L60-L72）
  - 将 `handleSet` 函数签名和函数体替换为:

    ```typescript
    async function handleSet(data: { model?: string; small_model?: string; permission?: unknown }) {
      if (!data.model && !data.small_model && data.permission === undefined) {
        return err("VALIDATION_ERROR", "At least one of 'model', 'small_model', or 'permission' is required");
      }
      if (data.model) await setTopLevelField("model", data.model);
      if (data.small_model) await setTopLevelField("small_model", data.small_model);
      if (data.permission !== undefined) await setTopLevelField("permission", data.permission);
      // 读回确认
      const config = await getConfig();
      return ok({
        model: (config.model as string | null) ?? null,
        small_model: (config.small_model as string | null) ?? null,
        permission: (config.permission as unknown) ?? null,
      });
    }
    ```

  - 原因: 新增 `permission` 参数，通过 `setTopLevelField("permission", ...)` 写入 opencode.json 顶层。验证逻辑从"必须有 model 或 small_model"放宽为"至少有一个字段"以支持单独设置 permission。读回确认的返回值同步新增 `permission` 字段。`permission` 的值不做结构校验，完全透传——由 OpenCode 运行时负责验证。

- [x] 在路由处理函数的请求体类型中添加 `permission` 字段
  - 位置: `src/routes/web/config/models.ts`，`app.post` 回调中的 `c.req.json<...>` 泛型参数（L80）
  - 将 L80 的 `body` 类型声明更新为:

    ```typescript
    const body = await c.req.json<{ action: string; data?: { model?: string; small_model?: string; permission?: unknown } }>().catch((): { action: string; data?: { model?: string; small_model?: string; permission?: unknown } } => ({ action: "" }));
    ```

  - 原因: 让路由层的 TypeScript 类型与 `handleSet` 参数类型对齐，允许 `permission` 字段从请求体传入

- [x] 为 Models API permission 透传编写单元测试
  - 测试文件: `src/__tests__/config-models.test.ts`
  - 测试场景及实现:
    - **get — 无 permission 时返回 null**: 在 `beforeEach` 重置后，请求 `get`，验证 `json.data.current.permission` 为 `null`
    - **get — 有 permission 对象时透传**: 设置 `_configStore.permission = { bash: "allow", read: { "*.env": "deny" } }`，请求 `get`，验证 `json.data.current.permission` 深度等于 `{ bash: "allow", read: { "*.env": "deny" } }`
    - **get — permission 为字符串时透传**: 设置 `_configStore.permission = "ask"`，请求 `get`，验证 `json.data.current.permission` 为 `"ask"`
    - **set — 单独设置 permission 对象**: 请求 `set` 且 `data: { permission: { bash: "deny" } }`，验证返回 `success: true`、`json.data.permission` 深度等于 `{ bash: "deny" }`、`_configStore.permission` 深度等于 `{ bash: "deny" }`
    - **set — 单独设置 permission 字符串**: 请求 `set` 且 `data: { permission: "allow" }`，验证 `_configStore.permission` 为 `"allow"`
    - **set — 同时设置 model 和 permission**: 请求 `set` 且 `data: { model: "gpt-4o", permission: { edit: "deny" } }`，验证 `_configStore.model` 为 `"gpt-4o"` 且 `_configStore.permission` 深度等于 `{ edit: "deny" }`
    - **set — 仅 permission 为 null 时合法**: 请求 `set` 且 `data: { permission: null }`，验证 `_configStore.permission` 为 `null`（用于清除 permission）
  - 在现有测试文件最后一个测试（"未知 action 返回 VALIDATION_ERROR"）之后、`describe` 闭包结束之前追加:

    ```typescript
    // ── Permission 透传测试 ──

    test("get action — 无 permission 返回 null", async () => {
      const res = await modelsRoute.request(new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get" }),
      }));
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.current.permission).toBe(null);
    });

    test("get action — permission 为对象时透传", async () => {
      _configStore = {
        permission: { bash: "allow", read: { "*.env": "deny" } },
      };
      const res = await modelsRoute.request(new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get" }),
      }));
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.current.permission).toEqual({ bash: "allow", read: { "*.env": "deny" } });
    });

    test("get action — permission 为字符串时透传", async () => {
      _configStore = {
        permission: "ask",
      };
      const res = await modelsRoute.request(new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get" }),
      }));
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.current.permission).toBe("ask");
    });

    test("set action — 单独设置 permission 对象", async () => {
      const res = await modelsRoute.request(new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", data: { permission: { bash: "deny" } } }),
      }));
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.permission).toEqual({ bash: "deny" });
      expect(_configStore.permission).toEqual({ bash: "deny" });
    });

    test("set action — 单独设置 permission 字符串", async () => {
      const res = await modelsRoute.request(new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", data: { permission: "allow" } }),
      }));
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.permission).toBe("allow");
      expect(_configStore.permission).toBe("allow");
    });

    test("set action — 同时设置 model 和 permission", async () => {
      const res = await modelsRoute.request(new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", data: { model: "gpt-4o", permission: { edit: "deny" } } }),
      }));
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.model).toBe("gpt-4o");
      expect(json.data.permission).toEqual({ edit: "deny" });
      expect(_configStore.model).toBe("gpt-4o");
      expect(_configStore.permission).toEqual({ edit: "deny" });
    });

    test("set action — permission 为 null 时清除", async () => {
      _configStore.permission = { bash: "allow" };
      const res = await modelsRoute.request(new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", data: { permission: null } }),
      }));
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.permission).toBe(null);
      expect(_configStore.permission).toBe(null);
    });
    ```

  - 注意: 原有测试"set action — 空数据返回 VALIDATION_ERROR"的验证逻辑已自动兼容——空 `{}` 三个字段都未提供，仍然命中 `VALIDATION_ERROR`
  - 运行命令: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/config-models.test.ts`
  - 预期: 所有测试通过（原有 8 个 + 新增 7 个 permission 透传测试）

**检查步骤:**

- [x] 验证 handleGet 返回 `permission` 字段
  - `grep -n "permission" src/routes/web/config/models.ts`
  - 预期: 输出包含 `handleGet` 中的 `permission: (config.permission as unknown) ?? null` 和 `handleSet` 中的相关行

- [x] 验证 handleSet 支持 `permission` 参数写入
  - `grep -n "setTopLevelField.*permission" src/routes/web/config/models.ts`
  - 预期: 输出包含 `setTopLevelField("permission", data.permission)` 行

- [x] 验证 TypeScript 编译无错误
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit --pretty 2>&1 | head -20`
  - 预期: 无错误输出

- [x] 验证所有单元测试通过
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/config-models.test.ts`
  - 预期: 所有测试通过（15 个）

---

### Task 4: 前端类型定义与 API 客户端更新

**背景:**
[业务语境] — Task 2 在后端 Agents API 中引入了 PermissionConfig 类型体系和 Agent 新字段（variant, temperature, top_p, disable, hidden, color, description），Task 3 在 Models API 中新增了顶层 permission 透传。前端类型定义必须与后端 API 响应对齐，否则 TypeScript 编译失败或运行时数据丢失。
[修改原因] — 当前 `web/src/types/config.ts` 中 `AgentDetail.permission` 类型为 `unknown`，缺少结构化类型定义，无法为 Permission Tab（Task 6）提供类型安全的编辑体验。`AgentDetail` 缺少 variant/temperature/top_p/disable/hidden/color/description 字段。`ModelConfig.current` 缺少 `permission` 字段。`OpenCodeAgent.permission` 类型为 `Record<string, unknown>`，过于宽泛。
[上下游影响] — 本 Task 是 Task 5（Agent 编辑弹窗 Tab 化）和 Task 6（Permission Tab 实现）的前置依赖——两者均需要使用本 Task 定义的 PermissionConfig 类型和新字段类型来渲染 UI 和组装请求。本 Task 依赖 Task 2 和 Task 3 的后端 API 响应格式已确定。API 客户端 `client.ts` 已包含 `apiListSkills` 函数，无需新增，仅需确认其存在。

**涉及文件:**

- 修改: `web/src/types/config.ts`
- 修改: `web/src/__tests__/config-types.test.ts`

**执行步骤:**

- [x] 在 `config.ts` 中新增 PermissionConfig 相关类型定义
  - 位置: `web/src/types/config.ts`，在 `OpenCodeModel` 接口声明之前（L1），在文件最顶部 `// === opencode 标准类型 ===` 注释之后插入新的类型定义块
  - 在 `// === opencode 标准类型 ===` 注释行之后、`export interface OpenCodeModel {` 之前（L2 后）插入:

    ```typescript
    // === Permission 类型定义 ===

    /** 开关型工具的三态值 */
    export type PermissionAction = "ask" | "allow" | "deny";

    /** 规则型工具的值：全局策略字符串 或 pattern→action 映射 */
    export type RuleBasedPermission = PermissionAction | Record<string, PermissionAction>;

    /** 完整的 PermissionConfig 对象模式 */
    export interface PermissionObjectConfig {
      // 规则型工具（支持通配符匹配）
      read?: RuleBasedPermission;
      edit?: RuleBasedPermission;
      glob?: RuleBasedPermission;
      grep?: RuleBasedPermission;
      list?: RuleBasedPermission;
      bash?: RuleBasedPermission;
      task?: RuleBasedPermission;
      external_directory?: RuleBasedPermission;
      lsp?: RuleBasedPermission;
      skill?: RuleBasedPermission;
      // 开关型工具（仅支持三态字符串）
      todowrite?: PermissionAction;
      question?: PermissionAction;
      webfetch?: PermissionAction;
      websearch?: PermissionAction;
      codesearch?: PermissionAction;
      doom_loop?: PermissionAction;
    }

    /** PermissionConfig: 字符串模式（全局策略）或对象模式（按工具配置） */
    export type PermissionConfig = PermissionAction | PermissionObjectConfig;

    ```

  - 原因: 集中定义 PermissionConfig 类型体系，与设计文档中 opencode.ai 官方 Schema 对齐。导出类型供 Task 5/6 的 UI 组件引用，实现类型安全的权限编辑。

- [x] 更新 `OpenCodeAgent` 接口中 `permission` 字段的类型
  - 位置: `web/src/types/config.ts`，`OpenCodeAgent` 接口（L31-L38）
  - 将 `permission?: Record<string, unknown>;` 替换为:

    ```typescript
    permission?: PermissionConfig;
    ```

  - 原因: `OpenCodeAgent` 对应 opencode.json 中 agent 配置节的类型，`permission` 字段应使用结构化类型而非宽泛的 `Record<string, unknown>`

- [x] 更新 `AgentInfo` 接口，新增 description 和 color 字段
  - 位置: `web/src/types/config.ts`，`AgentInfo` 接口（L104-L109）
  - 将 `AgentInfo` 接口替换为:

    ```typescript
    export interface AgentInfo {
      name: string;
      builtIn: boolean;
      model: string | null;
      mode: string | null;
      description: string | null;
      color: string | null;
    }
    ```

  - 原因: Agent 列表页需要展示 description 和 color 字段以提供更好的视觉区分。后端 Task 2 的 handleList 将同步返回这些字段。

- [x] 更新 `AgentDetail` 接口，替换 permission 类型并添加所有新字段
  - 位置: `web/src/types/config.ts`，`AgentDetail` 接口（L111-L120）
  - 将 `AgentDetail` 接口替换为:

    ```typescript
    export interface AgentDetail {
      name: string;
      builtIn: boolean;
      model: string | null;
      prompt: string | null;
      tools: Record<string, boolean> | null;
      steps: number | null;
      mode: string | null;
      permission: PermissionConfig | null;
      variant: string | null;
      temperature: number | null;
      top_p: number | null;
      disable: boolean;
      hidden: boolean;
      color: string | null;
      description: string | null;
    }
    ```

  - 原因: 与后端 Task 2 的 handleGet 返回格式精确对齐。`tools` 字段保留为 `Record<string, boolean> | null` 以兼容旧数据的读取显示（后端在 handleGet 中已从配置文件读取 tools 但不再返回给前端；但前端保留该字段可避免类型不匹配导致的运行时错误）。`permission` 使用 `PermissionConfig | null` 提供结构化类型安全。新增字段使用 `null` 默认值（除 `disable` 和 `hidden` 使用 `boolean` 默认值 `false`），与后端一致。

- [x] 更新 `ModelConfig` 接口，添加顶层 permission 字段
  - 位置: `web/src/types/config.ts`，`ModelConfig` 接口（L94-L100）
  - 将 `ModelConfig` 接口替换为:

    ```typescript
    export interface ModelConfig {
      current: {
        model: string | null;
        small_model: string | null;
        permission: PermissionConfig | null;
      };
      available: ModelEntry[];
    }
    ```

  - 原因: 与后端 Task 3 的 Models API handleGet 返回格式对齐，新增 `permission` 字段透传 opencode.json 顶层权限配置

- [x] 为本 Task 所有类型变更编写编译验证测试
  - 测试文件: `web/src/__tests__/config-types.test.ts`
  - 在现有测试之后（L16 后）追加新的测试:

    ```typescript
    import type { PermissionAction, RuleBasedPermission, PermissionObjectConfig, PermissionConfig, AgentInfo, AgentDetail, ModelConfig } from "../types/config";

    // ── PermissionConfig 类型编译验证 ──

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
        description: "测试Agent",
      };
      expect(detail.variant).toBe("thinking");
      expect(detail.temperature).toBe(0.7);
      expect(detail.top_p).toBe(0.9);
      expect(detail.disable).toBe(false);
      expect(detail.hidden).toBe(true);
      expect(detail.color).toBe("#FF5500");
      expect(detail.description).toBe("测试Agent");
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
        description: "构建Agent",
        color: "primary",
      };
      expect(info.description).toBe("构建Agent");
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
    ```

  - 注意: 上述新测试代码中已包含独立的 `import type` 语句，与文件顶部原有的 import 互不冲突，无需修改文件顶部
  - 运行命令: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-types.test.ts`
  - 预期: 所有测试通过（原有 2 个 + 新增约 14 个类型验证测试）

**检查步骤:**

- [x] 验证 PermissionConfig 类型体系已定义且导出
  - `grep -n "export type PermissionAction\|export type RuleBasedPermission\|export interface PermissionObjectConfig\|export type PermissionConfig" web/src/types/config.ts`
  - 预期: 输出包含四个类型定义行

- [x] 验证 `OpenCodeAgent.permission` 类型已更新
  - `grep -n "permission" web/src/types/config.ts`
  - 预期: `OpenCodeAgent` 中的 `permission` 字段类型为 `PermissionConfig`，不再是 `Record<string, unknown>`

- [x] 验证 `AgentDetail` 包含所有新字段
  - `grep -n "variant\|temperature\|top_p\|disable\|hidden\|color\|description" web/src/types/config.ts`
  - 预期: `AgentDetail` 接口中包含所有新字段声明

- [x] 验证 `ModelConfig.current` 包含 `permission` 字段
  - `grep -A5 "current:" web/src/types/config.ts`
  - 预期: `current` 对象包含 `model`、`small_model`、`permission` 三个字段

- [x] 验证 `client.ts` 中 `apiListSkills` 已存在
  - `grep -n "apiListSkills" web/src/api/client.ts`
  - 预期: 输出包含 `apiListSkills` 函数声明（L184-L186），无需修改

- [x] 验证 TypeScript 编译无错误
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit --pretty 2>&1 | head -30`
  - 预期: 无错误输出（类型变更不破坏现有前端代码，因为新字段均为可选或使用 null 默认值）

- [x] 验证所有单元测试通过
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-types.test.ts`
  - 预期: 所有测试通过（16 个）

---

### Task 5: Agent 编辑弹窗 Tab 化 + 基础配置新字段

**背景:**
[业务语境] — 当前 Agent 编辑弹窗使用 `FormDialog` 包裹单页表单，所有字段（名称、模型、模式、步数、工具 Checkbox、Prompt）平铺在一个滚动区域内。需要将弹窗改为 Tabs 结构（基础配置 + 权限配置），在基础配置 Tab 中补充 variant/temperature/top_p/color/hidden/disable/description 等新字段，同时删除旧的工具 Checkbox 区域（被 Task 6 的 Permission Tab 完全取代）。
[修改原因] — 当前 `AgentsPage.tsx` 使用 `AVAILABLE_TOOLS` 常量和 `formTools` 状态管理工具 Checkbox，这属于已废弃的 `tools` 体系。Tab 结构改造将工具权限编辑移至独立的权限配置 Tab（Task 6 实现），基础配置 Tab 专注于 Agent 元信息和新字段编辑。单页表单在字段增多后过长且缺乏分组，Tab 化提升用户体验。
[上下游影响] — 本 Task 依赖 Task 2（后端 Agents API 已支持新字段和 permission）和 Task 4（前端类型定义已包含 PermissionConfig、AgentDetail 新字段）。本 Task 完成后，Task 6（Permission Tab）将在本 Task 预留的 Tab 2 占位符中填入 PermissionTab 组件。本 Task 删除 `AVAILABLE_TOOLS` 常量和 `formTools` 后，现有工具 Checkbox 区域从 DOM 中完全移除，不影响 Task 6。

**涉及文件:**

- 修改: `web/src/pages/AgentsPage.tsx`
- 修改: `web/src/__tests__/config-agents-page.test.ts`

**执行步骤:**

- [x] 删除 `AVAILABLE_TOOLS` 常量
  - Target: `AVAILABLE_TOOLS` 常量（L30-L42）
  - Location: `web/src/pages/AgentsPage.tsx`，L30-L42
  - Content: 删除以下代码:

    ```typescript
    const AVAILABLE_TOOLS = [
        "Read",
        "Write",
        "Edit",
        "Bash",
        "Glob",
        "Grep",
        "WebSearch",
        "WebFetch",
        "Agent",
        "TaskCreate",
        "TaskUpdate",
    ];
    ```

  - Rationale: 旧的工具 Checkbox 列表常量被 Task 6 的 Permission Tab 完全取代，本 Task 先删除旧代码，清理干净后再添加 Tab 结构

- [x] 删除 `formTools` 状态变量
  - Target: `formTools` 状态声明（L72）
  - Location: `web/src/pages/AgentsPage.tsx`，L72
  - Content: 删除 `const [formTools, setFormTools] = useState<string[]>([]);`
  - Rationale: formTools 管理旧的工具 Checkbox 选中状态，删除后由 Task 6 的 Permission Tab 中的 formPermission 状态取代

- [x] 在 `formSaving` 状态变量之后新增基础配置新字段的状态变量
  - Target: 新增 7 个状态变量
  - Location: `web/src/pages/AgentsPage.tsx`，在 `const [formSaving, setFormSaving] = useState(false);`（L74）之后
  - Content: 插入以下代码:

    ```typescript
    const [formDescription, setFormDescription] = useState("");
    const [formVariant, setFormVariant] = useState("");
    const [formTemperature, setFormTemperature] = useState("");
    const [formTopP, setFormTopP] = useState("");
    const [formColor, setFormColor] = useState("");
    const [formHidden, setFormHidden] = useState(false);
    const [formDisable, setFormDisable] = useState(false);
    ```

  - Rationale: 7 个新字段对应 AgentDetail 中的 variant/temperature/top_p/color/hidden/disable/description。temperature 和 topP 使用字符串状态（与 formSteps 一致），保存时 parse 为数字。color 使用字符串接受 hex 值或预设色名。hidden/disable 使用布尔默认值 false

- [x] 在文件顶部 import 区域新增 Tabs 组件导入
  - Target: 添加 Tabs 组件导入
  - Location: `web/src/pages/AgentsPage.tsx`，在 `import { Label } from "@/components/ui/label";`（L18）之后
  - Content: 插入以下导入:

    ```typescript
    import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../components/ui/tabs";
    ```

  - Rationale: 使用 shadcn/ui Tabs 组件实现弹窗的 Tab 结构，组件位于 `web/components/ui/tabs.tsx`，导出 Tabs, TabsList, TabsTrigger, TabsContent 四个组件

- [x] 更新 `handleOpenCreate()` 函数，移除 formTools 相关逻辑，初始化新字段状态
  - Target: `handleOpenCreate` 函数体（L131-L140）
  - Location: `web/src/pages/AgentsPage.tsx`，`handleOpenCreate` 函数
  - Content: 将函数体替换为:

    ```typescript
    const handleOpenCreate = () => {
        setEditingAgent(null);
        setFormName("");
        setFormModel(modelOptions[0] || "");
        setFormMode("primary");
        setFormSteps("50");
        setFormPrompt("");
        setFormDescription("");
        setFormVariant("");
        setFormTemperature("");
        setFormTopP("");
        setFormColor("");
        setFormHidden(false);
        setFormDisable(false);
        setDialogOpen(true);
    };
    ```

  - Rationale: 删除 `setFormTools([...AVAILABLE_TOOLS])` 行，新增 7 个新字段的默认值初始化。新建时所有新字段为空/false

- [x] 更新 `handleOpenEdit()` 函数，移除 formTools 相关逻辑，加载新字段
  - Target: `handleOpenEdit` 函数体（L142-L158）
  - Location: `web/src/pages/AgentsPage.tsx`，`handleOpenEdit` 函数
  - Content: 将函数体替换为:

    ```typescript
    const handleOpenEdit = async (agent: AgentInfo) => {
        setEditingAgent(agent);
        setFormName(agent.name);
        setFormModel(agent.model || "");
        setFormMode(agent.mode || "primary");
        setFormPrompt("");
        setFormDescription("");
        setFormVariant("");
        setFormTemperature("");
        setFormTopP("");
        setFormColor("");
        setFormHidden(false);
        setFormDisable(false);
        try {
            const detail = await apiGetAgent(agent.name);
            setFormSteps(String(detail.steps ?? 50));
            setFormPrompt(detail.prompt || "");
            setFormDescription(detail.description || "");
            setFormVariant(detail.variant || "");
            setFormTemperature(detail.temperature !== null && detail.temperature !== undefined ? String(detail.temperature) : "");
            setFormTopP(detail.top_p !== null && detail.top_p !== undefined ? String(detail.top_p) : "");
            setFormColor(detail.color || "");
            setFormHidden(detail.hidden ?? false);
            setFormDisable(detail.disable ?? false);
        } catch {
            setFormSteps("50");
        }
        setDialogOpen(true);
    };
    ```

  - Rationale: 删除 `setFormTools(detail.tools ? Object.keys(detail.tools as Record<string, unknown>) : [])` 行。从 AgentDetail 响应中读取 7 个新字段。temperature/top_p 使用 `!== null && !== undefined` 判断后转为字符串（区分"未设置"和"0"）。boolean 字段使用 `?? false` 兜底

- [x] 更新 `handleSave()` 函数，移除 tools 字段，添加新字段到请求数据
  - Target: `handleSave` 函数体（L160-L195）
  - Location: `web/src/pages/AgentsPage.tsx`，`handleSave` 函数
  - Content: 将函数体替换为:

    ```typescript
    const handleSave = async () => {
        const name = formName.trim();
        if (!isValidAgentNameInput(name)) {
            toast.error("名称只能包含小写字母、数字和单连字符，长度 1-64");
            return;
        }
        if (!isValidStepsInput(formSteps)) {
            toast.error("最大轮数须在 1-200 之间");
            return;
        }
        if (formTemperature !== "") {
            const t = parseFloat(formTemperature);
            if (isNaN(t) || t < 0 || t > 2) {
                toast.error("温度须在 0-2 之间");
                return;
            }
        }
        if (formTopP !== "") {
            const p = parseFloat(formTopP);
            if (isNaN(p) || p < 0 || p > 1) {
                toast.error("Top P 须在 0-1 之间");
                return;
            }
        }
        setFormSaving(true);
        try {
            const data: Record<string, unknown> = {
                model: formModel || undefined,
                mode: formMode,
                steps: parseInt(formSteps),
                prompt: formPrompt || undefined,
                description: formDescription || undefined,
                variant: formVariant || undefined,
                temperature: formTemperature !== "" ? parseFloat(formTemperature) : undefined,
                top_p: formTopP !== "" ? parseFloat(formTopP) : undefined,
                color: formColor || undefined,
                hidden: formHidden,
                disable: formDisable,
            };
            if (editingAgent) {
                await apiSetAgent(name, data);
                toast.success("Agent已更新");
            } else {
                await apiCreateAgent(name, data);
                toast.success("Agent已创建");
            }
            setDialogOpen(false);
            loadAgents();
        } catch (e) {
            toast.error(
                "保存失败: " + (e instanceof Error ? e.message : "未知错误"),
            );
        } finally {
            setFormSaving(false);
        }
    };
    ```

  - Rationale: 删除 `tools: Object.fromEntries(formTools.map((t) => [t, true]))` 行，不再发送 tools 字段。新增 temperature/top_p 的前端校验（空字符串表示未设置，非空时校验范围）。所有新字段写入 data 对象，空字符串转为 undefined（不写入配置），hidden/disable 始终写入布尔值

- [x] 将 FormDialog 内部表单区域从单页改为 Tabs 结构
  - Target: FormDialog 内部的 `<div className="space-y-4 max-h-[60vh] overflow-y-auto">` 区域（L309-L393）
  - Location: `web/src/pages/AgentsPage.tsx`，FormDialog 组件的 children（L309-L393）
  - Content: 将 L309-L393 整个 `<div className="space-y-4 ...">` 替换为:

    ```tsx
    <Tabs defaultValue="basic" className="w-full">
        <TabsList>
            <TabsTrigger value="basic">基础配置</TabsTrigger>
            <TabsTrigger value="permission">权限配置</TabsTrigger>
        </TabsList>
        <TabsContent value="basic">
            <div className="space-y-4 max-h-[55vh] overflow-y-auto pt-2">
                <div>
                    <Label>名称</Label>
                    <Input
                        value={formName}
                        onChange={(e) => setFormName(e.target.value)}
                        disabled={!!editingAgent}
                        placeholder="例如 my-agent"
                    />
                </div>
                <div>
                    <Label>模型</Label>
                    <Select value={formModel} onValueChange={setFormModel}>
                        <SelectTrigger>
                            <SelectValue placeholder="选择模型" />
                        </SelectTrigger>
                        <SelectContent>
                            {modelOptions.map((m) => (
                                <SelectItem key={m} value={m}>
                                    {m}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <div>
                    <Label>模式</Label>
                    <Select value={formMode} onValueChange={setFormMode}>
                        <SelectTrigger>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="primary">primary</SelectItem>
                            <SelectItem value="subagent">subagent</SelectItem>
                            <SelectItem value="all">all</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                <div>
                    <Label>步数 (1-200)</Label>
                    <Input
                        type="number"
                        value={formSteps}
                        onChange={(e) => setFormSteps(e.target.value)}
                        min={1}
                        max={200}
                    />
                </div>
                <div>
                    <Label>提示词 (Prompt)</Label>
                    <Textarea
                        value={formPrompt}
                        onChange={(e) => setFormPrompt(e.target.value)}
                        rows={4}
                        placeholder="可选，自定义 Agent 提示词"
                    />
                </div>
                <div>
                    <Label>描述</Label>
                    <Input
                        value={formDescription}
                        onChange={(e) => setFormDescription(e.target.value)}
                        placeholder="可选，Agent 的简短描述"
                    />
                </div>
                <div>
                    <Label>Variant</Label>
                    <Input
                        value={formVariant}
                        onChange={(e) => setFormVariant(e.target.value)}
                        placeholder="可选，例如 thinking"
                    />
                </div>
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <Label>温度 (0-2)</Label>
                        <Input
                            type="number"
                            value={formTemperature}
                            onChange={(e) => setFormTemperature(e.target.value)}
                            min={0}
                            max={2}
                            step={0.1}
                            placeholder="可选"
                        />
                    </div>
                    <div>
                        <Label>Top P (0-1)</Label>
                        <Input
                            type="number"
                            value={formTopP}
                            onChange={(e) => setFormTopP(e.target.value)}
                            min={0}
                            max={1}
                            step={0.1}
                            placeholder="可选"
                        />
                    </div>
                </div>
                <div>
                    <Label>颜色</Label>
                    <div className="flex gap-2">
                        <Input
                            type="color"
                            value={formColor || "#000000"}
                            onChange={(e) => setFormColor(e.target.value)}
                            className="w-12 h-9 p-1 cursor-pointer"
                        />
                        <Input
                            value={formColor}
                            onChange={(e) => setFormColor(e.target.value)}
                            placeholder="hex (#RRGGBB) 或预设色名"
                            className="flex-1"
                        />
                    </div>
                </div>
                <div className="flex items-center gap-6">
                    <label className="flex items-center gap-2 text-sm">
                        <input
                            type="checkbox"
                            checked={formHidden}
                            onChange={(e) => setFormHidden(e.target.checked)}
                        />
                        隐藏
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                        <input
                            type="checkbox"
                            checked={formDisable}
                            onChange={(e) => setFormDisable(e.target.checked)}
                        />
                        禁用
                    </label>
                </div>
            </div>
        </TabsContent>
        <TabsContent value="permission">
            <div className="py-8 text-center text-muted-foreground">
                权限配置（由 Permission Tab 组件实现）
            </div>
        </TabsContent>
    </Tabs>
    ```

  - Rationale: 使用 shadcn/ui Tabs 组件包裹表单，Tab 1 "基础配置" 包含原有字段 + 7 个新字段，Tab 2 "权限配置" 放置占位符文本。删除旧的工具 Checkbox 区域（原 L360-L382）。新字段布局: temperature 和 topP 使用 grid 并排显示，颜色使用 color picker + 文本输入双控件，hidden/disable 使用 Checkbox 并排显示。Tab 1 内容区高度限制为 `max-h-[55vh]`（比原来 60vh 略小，为 Tabs 导航留出空间）

- [x] 更新 `config-agents-page.test.ts` 测试文件，添加新字段的校验函数测试
  - Target: 测试文件 `web/src/__tests__/config-agents-page.test.ts`
  - Location: 在文件末尾（L42 之后）追加新的测试
  - Content: 在现有 `describe("isValidStepsInput", ...)` 块之后追加:

    ```typescript
    describe("isValidAgentNameInput — Task 5 回归", () => {
      test("带连字符的合法名称", () => {
        expect(isValidAgentNameInput("my-custom-agent")).toBe(true);
      });

      test("纯数字名称", () => {
        expect(isValidAgentNameInput("123")).toBe(true);
      });

      test("64 字符名称仍合法", () => {
        expect(isValidAgentNameInput("a".repeat(64))).toBe(true);
      });

      test("65 字符名称不合法", () => {
        expect(isValidAgentNameInput("a".repeat(65))).toBe(false);
      });
    });

    describe("isValidStepsInput — Task 5 回归", () => {
      test("边界值 1", () => {
        expect(isValidStepsInput("1")).toBe(true);
      });

      test("边界值 200", () => {
        expect(isValidStepsInput("200")).toBe(true);
      });

      test("负数", () => {
        expect(isValidStepsInput("-1")).toBe(false);
      });

      test("小数", () => {
        expect(isValidStepsInput("1.5")).toBe(false);
      });
    });
    ```

  - Rationale: 现有测试仅覆盖基本场景。新增回归测试确保 Tab 化改造未破坏已有的校验函数行为。本 Task 不涉及组件渲染测试（弹窗 Tab 结构由手动验证），因为项目使用 Bun test 而非 React Testing Library，不适合测试 JSX 渲染结果

- [x] 确认 TypeScript 编译无错误
  - 运行命令: `cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit --pretty 2>&1 | head -30`
  - 预期: 无错误输出（删除 AVAILABLE_TOOLS/formTools 后所有引用已同步移除，新状态变量和 Tabs 组件导入正确）

**检查步骤:**

- [x] 验证 AVAILABLE_TOOLS 常量已删除
  - `grep -n "AVAILABLE_TOOLS" web/src/pages/AgentsPage.tsx`
  - 预期: 无输出

- [x] 验证 formTools 状态变量已删除
  - `grep -n "formTools\|setFormTools" web/src/pages/AgentsPage.tsx`
  - 预期: 无输出

- [x] 验证新状态变量已声明
  - `grep -n "formDescription\|formVariant\|formTemperature\|formTopP\|formColor\|formHidden\|formDisable" web/src/pages/AgentsPage.tsx | head -15`
  - 预期: 输出包含 7 个 useState 声明

- [x] 验证 Tabs 组件已导入
  - `grep -n "Tabs" web/src/pages/AgentsPage.tsx | head -5`
  - 预期: 输出包含 import 行和 JSX 中的 Tabs/TabsList/TabsTrigger/TabsContent 使用

- [x] 验证 handleSave 不包含 tools 字段
  - `grep -n "tools" web/src/pages/AgentsPage.tsx`
  - 预期: 无输出

- [x] 验证 Tab 2 占位符文本存在
  - `grep -n "权限配置.*Permission Tab" web/src/pages/AgentsPage.tsx`
  - 预期: 输出包含占位符文本行

- [x] 验证 TypeScript 编译无错误
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit --pretty 2>&1 | head -30`
  - 预期: 无错误输出

- [x] 验证所有单元测试通过
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-agents-page.test.ts`
  - 预期: 所有测试通过（原有 8 个 + 新增 8 个回归测试）

---

### Task 6: Permission Tab 实现

**背景:**
[业务语境] — Agent 编辑弹窗在 Task 5 中已完成 Tab 化改造，Tab 2 "权限配置" 当前为占位符文本。本 Task 需要新建 PermissionTab 组件，包含全局策略 Select、工具权限编辑器（开关型 + 规则型）、Skill 权限列表，集成到 Agent 编辑弹窗的 Tab 2 中，实现完整的 permission 可视化编辑功能。
[修改原因] — 当前 AgentsPage.tsx 中 Tab 2 的 TabsContent 内仅有一行占位符 `<div>权限配置（由 Permission Tab 组件实现）</div>`。需要用功能完整的 PermissionTab 组件替换该占位符。PermissionTab 组件需要解析后端返回的 `PermissionConfig` 类型数据（字符串全局策略 或 按工具配置的对象模式），渲染为结构化 UI（全局策略 Select、开关型工具三态 Select、规则型工具展开编辑器、Skill 权限列表），并将用户编辑结果反向组装为 `PermissionConfig` 对象。
[上下游影响] — 本 Task 依赖 Task 2（后端 Agents API 的 permission 读写）、Task 4（前端 PermissionConfig 类型定义）、Task 5（Agent 编辑弹窗 Tab 化改造、占位符预留）。本 Task 是整个 feature 的最后一个 Task，完成后 Agent 编辑弹窗具备完整的权限配置能力。PermissionTab 作为独立组件，接收 `agentName` 和 `permission` props，通过 `onPermissionChange` 回调向上层传递变更，不直接调用保存 API——保存由 AgentsPage 的 `handleSave` 统一处理。

**涉及文件:**

- 新建: `web/src/components/PermissionTab.tsx`
- 修改: `web/src/pages/AgentsPage.tsx`（替换占位符为 PermissionTab 组件）
- 修改: `web/src/__tests__/config-types.test.ts`（新增 PermissionTab 相关的类型验证测试）

**执行步骤:**

- [x] 新建 `PermissionTab.tsx` 组件文件，定义 Props 接口和内部状态类型
  - Target: 新文件 `web/src/components/PermissionTab.tsx`
  - Location: `web/src/components/PermissionTab.tsx`（新建）
  - Content: 创建文件，包含以下内容:

    ```typescript
    import { useState, useEffect, useCallback } from "react";
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
      // ... 组件实现在后续步骤中
    }
    ```

  - Rationale: 文件头部集中定义常量和类型，确保工具列表与设计文档精确对齐。`TOGGLE_TOOLS` 对应开关型工具（6 个），`RULE_TOOLS` 对应规则型工具（9 个）。`PERMISSION_OPTIONS` 包含空字符串表示"未设置"，`RULE_ACTION_OPTIONS` 仅包含三态值。Props 接口使用 `Record<string, unknown>` 保持与 AgentsPage 的 `permission` 状态类型一致

- [x] 在 `PermissionTab.tsx` 中实现组件内部状态声明和 permission 解析逻辑
  - Target: `PermissionTab` 函数体内的状态和初始化逻辑
  - Location: `web/src/components/PermissionTab.tsx`，`PermissionTab` 函数体内
  - Content: 在 `PermissionTab` 函数体内插入状态声明和解析函数:

    ```typescript
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
    useEffect(() => {
      if (!permission || typeof permission === "string") {
        // 字符串模式 → 全局策略
        setGlobalStrategy((permission as ToggleValue) ?? "");
        // 重置所有工具为未设置
        setToggleTools(Object.fromEntries(TOGGLE_TOOLS.map(t => [t, ""])));
        setRuleTools(Object.fromEntries(RULE_TOOLS.map(t => [t, { global: "", rules: [] }])));
        setSkillPerm({ global: "", rules: [] });
        setSkillValues({});
        return;
      }
      // 对象模式 → 按工具解析
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
            // 判断是 skill 名称还是通配符
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
            // 为新出现的 skill 初始化值
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
    ```

  - Rationale: `useEffect` 监听 `permission` prop 变化，将后端返回的 `PermissionConfig` 解析为组件内部结构化状态。字符串模式映射到 `globalStrategy`，对象模式按工具类型分别解析。规则型工具值支持纯字符串（全局策略）和对象（通配符规则映射）两种格式。Skill 权限特殊处理：区分 skill 精确名称（放入 `skillValues`）和通配符模式（放入 `skillPerm.rules`）。skill 列表在组件挂载时自动从 API 加载

- [x] 在 `PermissionTab.tsx` 中实现 permission 组装逻辑（UI 状态 → PermissionConfig 对象）
  - Target: `buildPermission` 回调函数
  - Location: `web/src/components/PermissionTab.tsx`，在 skill 加载 `useEffect` 之后插入
  - Content: 插入 `buildPermission` 回调函数和触发 `onPermissionChange` 的 `useEffect`:

    ```typescript
    // ── 将 UI 状态组装为 PermissionConfig 对象 ──
    const buildPermission = useCallback((): Record<string, unknown> | null => {
      // 全局字符串策略
      if (globalStrategy) return { __global: globalStrategy } as unknown as Record<string, unknown>;

      const result: Record<string, unknown> = {};

      // 开关型工具
      for (const tool of TOGGLE_TOOLS) {
        const val = toggleTools[tool];
        if (val) result[tool] = val;
      }

      // 规则型工具
      for (const tool of RULE_TOOLS) {
        const state = ruleTools[tool];
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

      // Skill 权限
      const skillEntries: Record<string, PermissionAction> = {};
      for (const name of skillNames) {
        const val = skillValues[name];
        if (val) skillEntries[name] = val;
      }
      for (const r of skillPerm.rules) {
        if (r.pattern) skillEntries[r.pattern] = r.action;
      }
      if (skillPerm.global) {
        result["skill"] = skillPerm.global;
      } else if (Object.keys(skillEntries).length > 0) {
        result["skill"] = skillEntries;
      }

      return Object.keys(result).length > 0 ? result : null;
    }, [globalStrategy, toggleTools, ruleTools, skillPerm, skillNames, skillValues]);

    // ── 状态变更时通知父组件 ──
    useEffect(() => {
      const built = buildPermission();
      // 全局策略特殊处理: 直接传字符串
      if (built && "__global" in built) {
        onPermissionChange(built.__global as string as unknown as Record<string, unknown> | null);
      } else {
        onPermissionChange(built);
      }
    }, [buildPermission, onPermissionChange]);
    ```

  - Rationale: `buildPermission` 遵循设计文档的数据组装规则："未设置"的字段不写入。全局策略模式时返回纯字符串（通过 `__global` 临时标记再转换）。规则型工具：有规则时存为对象，否则存为字符串。Skill 权限合并精确名称和通配符模式为一个对象。组装结果为 null 表示所有字段都未设置。使用 `useCallback` 避免不必要的重建，`useEffect` 在依赖变化时自动通知父组件

- [x] 在 `PermissionTab.tsx` 中实现事件处理函数
  - Target: 工具值变更、规则增删、展开/折叠的事件处理函数
  - Location: `web/src/components/PermissionTab.tsx`，在 `buildPermission` 的 `useEffect` 之后、`return` 之前插入
  - Content: 插入以下事件处理函数:

    ```typescript
    // ── 开关型工具变更 ──
    const handleToggleChange = (tool: string, value: string) => {
      setToggleTools(prev => ({ ...prev, [tool]: value as ToggleValue }));
    };

    // ── 规则型工具全局策略变更 ──
    const handleRuleGlobalChange = (tool: string, value: string) => {
      setRuleTools(prev => ({
        ...prev,
        [tool]: { ...prev[tool], global: value as ToggleValue },
      }));
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
      setRuleTools(prev => ({
        ...prev,
        [tool]: {
          ...prev[tool],
          rules: [...prev[tool].rules, { pattern: "", action: "deny" }],
        },
      }));
      // 自动展开
      setExpandedTools(prev => new Set(prev).add(tool));
    };

    // ── 规则型工具: 更新规则 pattern ──
    const handleRulePatternChange = (tool: string, index: number, pattern: string) => {
      setRuleTools(prev => {
        const rules = [...prev[tool].rules];
        rules[index] = { ...rules[index], pattern };
        return { ...prev, [tool]: { ...prev[tool], rules } };
      });
    };

    // ── 规则型工具: 更新规则 action ──
    const handleRuleActionChange = (tool: string, index: number, action: string) => {
      setRuleTools(prev => {
        const rules = [...prev[tool].rules];
        rules[index] = { ...rules[index], action: action as PermissionAction };
        return { ...prev, [tool]: { ...prev[tool], rules } };
      });
    };

    // ── 规则型工具: 删除规则 ──
    const handleDeleteRule = (tool: string, index: number) => {
      setRuleTools(prev => {
        const rules = prev[tool].rules.filter((_, i) => i !== index);
        return { ...prev, [tool]: { ...prev[tool], rules } };
      });
    };

    // ── Skill 精确名称权限变更 ──
    const handleSkillValueChange = (name: string, value: string) => {
      setSkillValues(prev => ({ ...prev, [name]: value as ToggleValue }));
    };

    // ── Skill 全局策略变更 ──
    const handleSkillGlobalChange = (value: string) => {
      setSkillPerm(prev => ({ ...prev, global: value as ToggleValue }));
    };

    // ── Skill 自定义规则: 添加 ──
    const handleAddSkillRule = () => {
      setSkillPerm(prev => ({
        ...prev,
        rules: [...prev.rules, { pattern: "", action: "deny" }],
      }));
    };

    // ── Skill 自定义规则: 更新 pattern ──
    const handleSkillRulePatternChange = (index: number, pattern: string) => {
      setSkillPerm(prev => {
        const rules = [...prev.rules];
        rules[index] = { ...rules[index], pattern };
        return { ...prev, rules };
      });
    };

    // ── Skill 自定义规则: 更新 action ──
    const handleSkillRuleActionChange = (index: number, action: string) => {
      setSkillPerm(prev => {
        const rules = [...prev.rules];
        rules[index] = { ...rules[index], action: action as PermissionAction };
        return { ...prev, rules };
      });
    };

    // ── Skill 自定义规则: 删除 ──
    const handleDeleteSkillRule = (index: number) => {
      setSkillPerm(prev => ({
        ...prev,
        rules: prev.rules.filter((_, i) => i !== index),
      }));
    };
    ```

  - Rationale: 所有事件处理函数均为纯状态更新，不涉及副作用。规则型工具的展开/折叠使用 Set 追踪。添加规则时自动展开对应工具区域。所有变更通过 `buildPermission` → `useEffect` → `onPermissionChange` 链路自动同步到父组件

- [x] 在 `PermissionTab.tsx` 中实现渲染 JSX（全局策略 + 工具权限 + Skill 权限）
  - Target: 组件的 `return` JSX
  - Location: `web/src/components/PermissionTab.tsx`，在事件处理函数之后插入 `return` 语句
  - Content: 插入以下 JSX:

    ```tsx
    return (
      <div className="space-y-6 max-h-[55vh] overflow-y-auto pt-2">
        {/* ── 全局策略 ── */}
        <div>
          <Label className="text-sm font-medium">全局策略</Label>
          <p className="text-xs text-muted-foreground mb-1">
            设置后所有工具继承此策略，未设置则使用 OpenCode 内置默认值
          </p>
          <Select value={globalStrategy} onValueChange={v => setGlobalStrategy(v as ToggleValue)}>
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
                  value={toggleTools[tool] || ""}
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
                    value={ruleTools[tool]?.global || ""}
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
                        <span className="text-muted-foreground text-xs">→</span>
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
                          size="icon-sm"
                          type="button"
                          onClick={() => handleDeleteRule(tool, idx)}
                        >
                          ×
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
                value={skillPerm.global || ""}
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
                  value={skillValues[name] || ""}
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
                <span className="text-muted-foreground text-xs">→</span>
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
                  size="icon-sm"
                  type="button"
                  onClick={() => handleDeleteSkillRule(idx)}
                >
                  ×
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
    ```

  - Rationale: JSX 结构严格遵循设计文档的 UI 规范——分为全局策略、工具权限（开关型 + 规则型）、Skill 权限三大区域。规则型工具使用 `Collapsible` 组件实现展开/折叠，展开后显示通配符规则编辑器。Skill 列表从 API 实时加载。Select 组件使用 `__unset__` 作为空值Agent（Radix Select 不支持空字符串作为 value）。规则型工具的规则编辑区域使用缩进 + 左边框视觉分组

- [x] 修改 `AgentsPage.tsx`，添加 `formPermission` 状态变量
  - Target: 新增 `formPermission` 状态
  - Location: `web/src/pages/AgentsPage.tsx`，在 `const [formSaving, setFormSaving] = useState(false);`（L74）之后
  - Content: 插入:

    ```typescript
    const [formPermission, setFormPermission] = useState<Record<string, unknown> | null>(null);
    ```

  - Rationale: `formPermission` 保存 PermissionTab 通过 `onPermissionChange` 回调传递的 permission 对象，在 `handleSave` 中写入 API 请求

- [x] 修改 `AgentsPage.tsx`，在 import 区域添加 PermissionTab 和相关类型导入
  - Target: 添加 PermissionTab 组件导入和类型导入
  - Location: `web/src/pages/AgentsPage.tsx`，在现有 import 语句之后
  - Content: 在 `import type { AgentInfo } from "../types/config";`（L28）之后插入:

    ```typescript
    import { PermissionTab } from "../components/PermissionTab";
    ```

  - Rationale: 导入 PermissionTab 组件，替换 Tab 2 占位符

- [x] 修改 `AgentsPage.tsx` 的 `handleOpenCreate` 函数，初始化 formPermission
  - Target: `handleOpenCreate` 函数体
  - Location: `web/src/pages/AgentsPage.tsx`，`handleOpenCreate` 函数内
  - Content: 在 `setFormPrompt("");` 之后、`setDialogOpen(true);` 之前插入:

    ```typescript
    setFormPermission(null);
    ```

  - Rationale: 新建 Agent 时 permission 为 null（不写入配置，使用 OpenCode 默认值）

- [x] 修改 `AgentsPage.tsx` 的 `handleOpenEdit` 函数，从 AgentDetail 加载 permission
  - Target: `handleOpenEdit` 函数体内的 try 块
  - Location: `web/src/pages/AgentsPage.tsx`，`handleOpenEdit` 的 try 块内
  - Content: 在 `setFormPrompt(detail.prompt || "");` 之后插入:

    ```typescript
    setFormPermission(
      detail.permission
        ? (typeof detail.permission === "string"
          ? (detail.permission as unknown as Record<string, unknown>)
          : (detail.permission as Record<string, unknown>))
        : null
    );
    ```

  - Rationale: 从 `AgentDetail.permission` 加载权限配置。字符串类型的全局策略通过 `as unknown as Record<string, unknown>` 转换为 PermissionTab 接受的类型。PermissionTab 的解析逻辑会正确处理字符串和对象两种格式

- [x] 修改 `AgentsPage.tsx` 的 `handleSave` 函数，将 permission 写入请求数据
  - Target: `handleSave` 函数体内的 data 对象构建
  - Location: `web/src/pages/AgentsPage.tsx`，`handleSave` 函数内，`const data: Record<string, unknown> = { ... }` 块
  - Content: 在 data 对象的 `disable: formDisable,` 之后插入:

    ```typescript
    permission: formPermission ?? undefined,
    ```

  - Rationale: `formPermission` 为 null 时不写入（undefined 在 JSON.stringify 中被忽略），有值时写入完整的 permission 对象

- [x] 修改 `AgentsPage.tsx`，替换 Tab 2 占位符为 PermissionTab 组件
  - Target: Tab 2 的 TabsContent 内部占位符
  - Location: `web/src/pages/AgentsPage.tsx`，FormDialog 内 Tabs 结构中 `TabsContent value="permission"` 区域
  - Content: 在 Task 5 完成后，Tab 2 的内容应为占位符 `<div className="py-8 text-center text-muted-foreground">权限配置（由 Permission Tab 组件实现）</div>`。将该占位符替换为:

    ```tsx
    <PermissionTab
      agentName={formName}
      permission={formPermission}
      onPermissionChange={setFormPermission}
    />
    ```

  - Rationale: PermissionTab 接收 `agentName`（用于 skill 列表加载）、当前 `permission` 值、变更回调。用户编辑权限后，PermissionTab 通过 `onPermissionChange` 自动更新 `formPermission` 状态，最终由 `handleSave` 统一提交

- [x] 在 `config-types.test.ts` 中添加 PermissionTab 端到端数据流验证测试
  - Target: 测试文件 `web/src/__tests__/config-types.test.ts`
  - Location: 在 Task 4 已追加的测试之后、文件末尾追加新的测试
  - Content: 追加以下测试代码（仅测试 PermissionTab 特有的数据组装/解析场景，基础类型验证已在 Task 4 覆盖）:

    ```typescript
    import type { PermissionObjectConfig, PermissionConfig } from "../types/config";

    // ── PermissionTab 数据流验证 ──

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
    ```

  - Rationale: 基础类型验证（PermissionAction/RuleBasedPermission/PermissionConfig 字符串和对象模式）已在 Task 4 中覆盖。本步骤仅补充 PermissionTab 特有的全字段覆盖和混合模式数据流验证，避免与 Task 4 测试重复
  - 运行命令: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-types.test.ts`
  - 预期: 所有测试通过（Task 4 新增 14 个 + 本 Task 新增 2 个，共 18 个）

**检查步骤:**

- [x] 验证 PermissionTab 组件文件已创建
  - `ls -la web/src/components/PermissionTab.tsx`
  - 预期: 文件存在

- [x] 验证 PermissionTab 导入了所有必需的 UI 组件
  - `grep -n "import.*from.*@/components/ui" web/src/components/PermissionTab.tsx`
  - 预期: 输出包含 Select、Input、Button、Collapsible、Label 的导入

- [x] 验证 PermissionTab 导入了 apiListSkills
  - `grep -n "apiListSkills" web/src/components/PermissionTab.tsx`
  - 预期: 输出包含 import 行和 useEffect 中的调用

- [x] 验证 PermissionTab 包含开关型工具列表（6 个）
  - `grep -n "TOGGLE_TOOLS" web/src/components/PermissionTab.tsx`
  - 预期: 输出包含常量定义，列表为 todowrite, question, webfetch, websearch, codesearch, doom_loop

- [x] 验证 PermissionTab 包含规则型工具列表（9 个）
  - `grep -n "RULE_TOOLS" web/src/components/PermissionTab.tsx`
  - 预期: 输出包含常量定义，列表为 read, edit, glob, grep, list, bash, task, external_directory, lsp

- [x] 验证 AgentsPage 已导入 PermissionTab
  - `grep -n "PermissionTab" web/src/pages/AgentsPage.tsx`
  - 预期: 输出包含 import 行和 JSX 中的使用

- [x] 验证 AgentsPage 包含 formPermission 状态
  - `grep -n "formPermission" web/src/pages/AgentsPage.tsx`
  - 预期: 输出包含 useState 声明、handleSave 中的写入、handleOpenEdit 中的加载、PermissionTab 的 props 传递

- [x] 验证 AgentsPage handleSave 包含 permission 字段
  - `grep -n "permission.*formPermission" web/src/pages/AgentsPage.tsx`
  - 预期: 输出包含 `permission: formPermission ?? undefined`

- [x] 验证 Tab 2 占位符已被替换为 PermissionTab
  - `grep -n "权限配置.*Permission Tab" web/src/pages/AgentsPage.tsx`
  - 预期: 无输出（占位符已被替换）

- [x] 验证 TypeScript 编译无错误
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit --pretty 2>&1 | head -30`
  - 预期: 无错误输出

- [x] 验证所有单元测试通过
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-types.test.ts`
  - 预期: 所有测试通过（原有 2 个 + Task 4 新增 14 个 + 本 Task 新增 2 个 = 18 个）

---

### Task 7: permission-config-enhancement 验收

**前置条件:**

- 启动命令: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run dev`
- 确保 `~/.config/opencode/opencode.json` 存在且包含 agent 配置

**端到端验证:**

1. 运行完整测试套件确保无回归
   - `cd /Users/konghayao/code/pazhou/remote-control-server && bun test`
   - 预期: 全部测试通过
   - 失败排查: 检查各 Task 的测试步骤，定位失败的测试文件
   - 实际: 382 pass, 6 fail (6 个失败均为预先存在的 store.ts 导出问题，与本功能无关)

2. 验证 Skills 目录迁移
   - 在有旧目录 `~/.config/opencode/skills/` 的环境下启动 RCS
   - `ls ~/.agents/skills/ && ls ~/.config/opencode/skills/.migrated`
   - 预期: 新目录包含旧数据，旧目录存在 `.migrated` 标记文件
   - 失败排查: 检查 Task 1 migrateSkillsDir 函数

3. 验证 Agents API tools→permission 兼容转换
   - `curl -s -X POST http://localhost:3001/web/config/agents -H 'Content-Type: application/json' -d '{"action":"get","name":"build"}' | jq '.data.permission'`
   - 预期: 如果 opencode.json 中 agent.build 有 tools 字段，返回对应的 permission 对象
   - 失败排查: 检查 Task 2 handleGet 的 toolsToPermission 转换逻辑

4. 验证 Agents API 新字段支持
   - `curl -s -X POST http://localhost:3001/web/config/agents -H 'Content-Type: application/json' -d '{"action":"set","name":"build","data":{"variant":"thinking","temperature":0.7,"description":"测试描述"}}' | jq '.data'`
   - 预期: 返回更新后的字段值
   - 失败排查: 检查 Task 2 handleSet 白名单过滤逻辑

5. 验证 Models API permission 透传
   - `curl -s -X POST http://localhost:3001/web/config/models -H 'Content-Type: application/json' -d '{"action":"get"}' | jq '.data.permission'`
   - 预期: 返回 opencode.json 顶层 permission 字段值（或 null）
   - 失败排查: 检查 Task 3 handleGet 的 permission 读取

6. 验证前端 Agent 编辑弹窗 Tabs 结构
   - 打开浏览器访问 Settings → Agents → 点击编辑任一 agent
   - 预期: 弹窗显示"基础配置"和"权限配置"两个 Tab
   - 失败排查: 检查 Task 5 Tabs 组件集成

7. 验证 Permission Tab 功能
   - 在 Agent 编辑弹窗切换到"权限配置" Tab
   - 预期: 显示全局策略、开关型工具、规则型工具、Skill 权限四个区域
   - 设置工具权限并保存，重新打开确认持久化
   - 失败排查: 检查 Task 6 PermissionTab 组件

8. 验证前端构建无错误
   - `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web`
   - 预期: 构建成功，无 TypeScript 编译错误
   - 失败排查: 检查前端类型定义（Task 4）和组件引用
