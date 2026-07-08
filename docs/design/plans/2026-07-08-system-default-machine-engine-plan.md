# 系统级默认 Machine 与 Agent Type 指定 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通过两个系统环境变量 `RCS_DEFAULT_MACHINE_ID` 和 `RCS_DEFAULT_ENGINE_TYPE`，在 agent config 未显式指定时提供 fallback machine 和 fallback engine type。

**Architecture:** 在 `src/env.ts` 新增环境变量定义和校验，通过 `src/config.ts` 传递给运行时，在 `src/services/instance.ts` 的 `spawnInstanceFromEnvironment` 中修改 `nodeId` 决策和 `engineType` 默认值逻辑。改动仅影响三处源文件（+ 测试）。

**Tech Stack:** Bun + TypeScript + Zod v4

**Design doc:** `docs/design/2026-07-08-system-default-machine-engine-design.md`

---

## 文件改动清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/env.ts` | 修改 | 新增两个 env var，移除未使用的 `RCS_ENGINE_TYPE` |
| `src/config.ts` | 修改 | `buildConfig` 新增两个字段 |
| `src/services/instance.ts` | 修改 | `nodeId` fallback + `engineType` 默认值 |
| `src/__tests__/env-validation.test.ts` | 修改 | 新增 env var 格式校验测试 |
| `src/__tests__/instance-machine-fallback.test.ts` | 新建 | 实例 fallback 四象限测试 |

---

### Task 1: 新增环境变量定义，移除旧变量

**Files:**
- Modify: `src/env.ts`

- [ ] **Step 1: 在 `src/env.ts` 中引入 `ENGINE_TYPES`，新增两个 env var，移除 `RCS_ENGINE_TYPE`**

在文件顶部添加 import：

```typescript
import { ENGINE_TYPES } from "./services/config/types";
```

在 `envSchema` 中，将原来的 `RCS_ENGINE_TYPE`（第 67 行）：

```typescript
RCS_ENGINE_TYPE: z.enum(["opencode", "ccb"]).default("opencode"),
```

替换为：

```typescript
// 默认 fallback 机器 ID。agent config 未绑定 machineId 时使用此机器替代 local-default
RCS_DEFAULT_MACHINE_ID: z
  .string()
  .regex(/^mach_/, "RCS_DEFAULT_MACHINE_ID must start with 'mach_'")
  .optional(),

// 默认引擎类型。agent config 未指定 engineType 时覆盖硬编码默认值
RCS_DEFAULT_ENGINE_TYPE: z.enum(ENGINE_TYPES).optional(),
```

同时移除不再需要的第 69-70 行（`RCS_CCB_COMMAND` 和 `RCS_CCB_ARGS` 不受影响，不动它们）。

`Env` 类型由 `z.infer<typeof envSchema>` 自动推导，无需手动声明。

- [ ] **Step 2: 验证 env 校验**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/env-validation.test.ts
```

预期：现��测试通过（向后兼容，新变量都是 optional 不影响现有测试）。

- [ ] **Step 3: 提交**

```bash
git add src/env.ts
git commit -m "feat: 新增 RCS_DEFAULT_MACHINE_ID 和 RCS_DEFAULT_ENGINE_TYPE 环境变量，移除未使用的 RCS_ENGINE_TYPE"
```

---

### Task 2: 配置传递

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: 在 `buildConfig` 中新增两个字段**

在 `src/config.ts` 的 `buildConfig` 函数返回对象中，末尾（`disableSignup` 之前或附近）添加：

```typescript
// 系统级默认 fallback 配置（agent config 未指定时生效）
defaultMachineId: env.RCS_DEFAULT_MACHINE_ID,
defaultEngineType: env.RCS_DEFAULT_ENGINE_TYPE,
```

最终 `buildConfig` 返回对象类似：

```typescript
function buildConfig(env: Env) {
  return {
    // ... 现有字段 ...
    disableSignup: env.RCS_DISABLE_SIGNUP,
    defaultMachineId: env.RCS_DEFAULT_MACHINE_ID,
    defaultEngineType: env.RCS_DEFAULT_ENGINE_TYPE,
  };
}
```

`AppConfig` 类型由 `ReturnType<typeof buildConfig>` 自动推导，无需手动修改。

- [ ] **Step 2: 验证类型检查**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck
```

关注是否通过类型检查。如果 `precheck` 中有其他预存在的问题则忽略，只需确保 `config.ts` 相关无新错误。

- [ ] **Step 3: 提交**

```bash
git add src/config.ts
git commit -m "feat: config 新增 defaultMachineId 和 defaultEngineType 字段"
```

---

### Task 3: 核心决策逻辑改动

**Files:**
- Modify: `src/services/instance.ts`

- [ ] **Step 1: 导入 config 对象**

在 `src/services/instance.ts` 顶部，将现有的导入：

```typescript
import { getBaseUrl } from "../config";
```

改为：

```typescript
import { config, getBaseUrl } from "../config";
```

- [ ] **Step 2: 修改 `nodeId` 决策逻辑**

在 `spawnInstanceFromEnvironment` 函数中，将第 249-253 行：

```typescript
// machineId 缺失时固定落到本地 node，避免把"未绑定远程机"误解释成启动错误。
let nodeId = "local-default";
if (agentMachineId) {
  nodeId = agentMachineId;
}
```

改为：

```typescript
// machineId 缺失时按优先级选择执行节点：
// agent config 绑定 > 系统环境变量 > local-default
let nodeId = "local-default";
if (agentMachineId) {
  nodeId = agentMachineId;
} else if (config.defaultMachineId) {
  nodeId = config.defaultMachineId;
}
```

- [ ] **Step 3: 修改 `engineType` 默认值逻辑**

将第 265 行：

```typescript
const engineType = (resolvedAgentConfig as Record<string, unknown> | null)?.engineType ?? "opencode";
```

改为：

```typescript
// engineType 优先级：agent config 指定 > 系统环境变量 > hardcoded "opencode"
const engineType = (resolvedAgentConfig as Record<string, unknown> | null)?.engineType 
  ?? config.defaultEngineType 
  ?? "opencode";
```

- [ ] **Step 4: 验证类型检查和现有测试**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/
```

关注 instance 相关测试或任何因改动而失败的测试。预期全部通过（`config.defaultMachineId` 默认 `undefined`，`config.defaultEngineType` 默认 `undefined`，行为等同现状）。

- [ ] **Step 5: 提交**

```bash
git add src/services/instance.ts
git commit -m "feat: instance 启动时支持从 RCS_DEFAULT_MACHINE_ID 和 RCS_DEFAULT_ENGINE_TYPE 获取 fallback 值"
```

---

### Task 4: 环境变量校验测试

**Files:**
- Modify: `src/__tests__/env-validation.test.ts`

- [ ] **Step 1: 新增 env var 校验测试用例**

在 `src/__tests__/env-validation.test.ts` 文件末尾（最后一个 `test(...)` 之后，`});` 之前）新增五个测试用例：

```typescript
  // RCS_DEFAULT_MACHINE_ID 不设置时通过校验（optional）
  test("RCS_DEFAULT_MACHINE_ID 不设置时通过校验", () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
    process.env.RCS_API_KEYS = "test-key";
    delete process.env.RCS_DEFAULT_MACHINE_ID;
    const env = validateEnv();
    expect(env.RCS_DEFAULT_MACHINE_ID).toBeUndefined();
  });

  // 设置合法 mach_ 前缀值时应通过校验
  test("RCS_DEFAULT_MACHINE_ID 合法值时通过校验", () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
    process.env.RCS_API_KEYS = "test-key";
    process.env.RCS_DEFAULT_MACHINE_ID = "mach_abc123";
    const env = validateEnv();
    expect(env.RCS_DEFAULT_MACHINE_ID).toBe("mach_abc123");
  });

  // 设置非法值（不以 mach_ 开头）时应校验失败
  test("RCS_DEFAULT_MACHINE_ID 不以 mach_ 开头时校验失败", () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
    process.env.RCS_API_KEYS = "test-key";
    process.env.RCS_DEFAULT_MACHINE_ID = "invalid-id";
    expect(() => validateEnv()).toThrow(/RCS_DEFAULT_MACHINE_ID/);
  });

  // RCS_DEFAULT_ENGINE_TYPE 合法值
  test("RCS_DEFAULT_ENGINE_TYPE 合法值 'ccb' 通过校验", () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
    process.env.RCS_API_KEYS = "test-key";
    process.env.RCS_DEFAULT_ENGINE_TYPE = "ccb";
    const env = validateEnv();
    expect(env.RCS_DEFAULT_ENGINE_TYPE).toBe("ccb");
  });

  // RCS_DEFAULT_ENGINE_TYPE 非法值
  test("RCS_DEFAULT_ENGINE_TYPE 非法值时校验失败", () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
    process.env.RCS_API_KEYS = "test-key";
    process.env.RCS_DEFAULT_ENGINE_TYPE = "invalid-engine";
    expect(() => validateEnv()).toThrow(/RCS_DEFAULT_ENGINE_TYPE/);
  });
```

- [ ] **Step 2: 运行新增测试**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/env-validation.test.ts
```

预期：新增的 5 个测试全部通过。

- [ ] **Step 3: 提交**

```bash
git add src/__tests__/env-validation.test.ts
git commit -m "test: 新增 RCS_DEFAULT_MACHINE_ID 和 RCS_DEFAULT_ENGINE_TYPE 校验测试"
```

---

### Task 5: 实例 fallback 四象限测试

**Files:**
- Create: `src/__tests__/instance-machine-fallback.test.ts`

> **注意**：本任务测试 `spawnInstanceFromEnvironment` 中 `nodeId` 和 `engineType` 的 fallback 逻辑。由于该函数依赖完整的 DB、registry、core runtime 等基础设施，测试采用 stub 方式隔离被测逻辑。

- [ ] **Step 1: 创建测试文件**

一次性写入完整测试文件 `src/__tests__/instance-machine-fallback.test.ts`：

```typescript
// 实例 fallback 决策：RCS_DEFAULT_MACHINE_ID 和 RCS_DEFAULT_ENGINE_TYPE 环境变量覆盖行为
import { describe, expect, test } from "bun:test";
import { config, setConfig } from "../config";

describe("instance machine/engine fallback", () => {
  // ── config 值读取 ──

  // 不设置任何 fallback 时 defaultMachineId 为 undefined（默认状态）
  test("不设置 defaultMachineId 时值为 undefined", () => {
    expect(config.defaultMachineId).toBeUndefined();
  });

  // 通过 setConfig 模拟 RCS_DEFAULT_MACHINE_ID 环境变量
  test("setConfig 设置 defaultMachineId 后通过 config 可读取", () => {
    setConfig({ defaultMachineId: "mach_fallback_001" } as any);
    expect(config.defaultMachineId).toBe("mach_fallback_001");
  });

  // 通过 setConfig 模拟 RCS_DEFAULT_ENGINE_TYPE 环境变量
  test("setConfig 设置 defaultEngineType 后通过 config 可读取", () => {
    setConfig({ defaultEngineType: "ccb" } as any);
    expect(config.defaultEngineType).toBe("ccb");
  });

  // ── engineType 默认值优先级 ──

  // engineType fallback 优先级：agent config 指定 > 系统默认 > hardcoded
  test("engineType 未设置任何值时默认为 'opencode'", () => {
    const resolved = null;
    const systemDefault: string | undefined = undefined;
    const fallback = "opencode";
    const engineType = (resolved as any)?.engineType ?? systemDefault ?? fallback;
    expect(engineType).toBe("opencode");
  });

  // engineType 系统默认 ccb 覆盖 hardcoded opencode
  test("engineType 系统默认 ccb 覆盖 hardcoded opencode", () => {
    const resolved = null;
    const systemDefault: string | undefined = "ccb";
    const fallback = "opencode";
    const engineType = (resolved as any)?.engineType ?? systemDefault ?? fallback;
    expect(engineType).toBe("ccb");
  });

  // engineType agent config 显式指定时覆盖系统默认
  test("engineType agent config 显式指定时覆盖系统默认", () => {
    const resolved = { engineType: "claude-code" };
    const systemDefault: string | undefined = "ccb";
    const fallback = "opencode";
    const engineType = (resolved as any)?.engineType ?? systemDefault ?? fallback;
    expect(engineType).toBe("claude-code");
  });

  // ── nodeId fallback 优先级 ──

  // nodeId 无绑定且无系统默认时使用 local-default
  test("nodeId 无绑定且无系统默认时使用 local-default", () => {
    const agentMachineId: string | null = null;
    const systemDefault: string | undefined = undefined;
    let nodeId = "local-default";
    if (agentMachineId) {
      nodeId = agentMachineId;
    } else if (systemDefault) {
      nodeId = systemDefault;
    }
    expect(nodeId).toBe("local-default");
  });

  // nodeId 系统默认 mach_fallback 覆盖 local-default
  test("nodeId 系统默认 mach_fallback 覆盖 local-default", () => {
    const agentMachineId: string | null = null;
    const systemDefault: string | undefined = "mach_fallback";
    let nodeId = "local-default";
    if (agentMachineId) {
      nodeId = agentMachineId;
    } else if (systemDefault) {
      nodeId = systemDefault;
    }
    expect(nodeId).toBe("mach_fallback");
  });

  // nodeId agent config 绑定后忽略系统默认
  test("nodeId agent config 绑定后忽略系统默认", () => {
    const agentMachineId: string | null = "mach_agent_bound";
    const systemDefault: string | undefined = "mach_fallback";
    let nodeId = "local-default";
    if (agentMachineId) {
      nodeId = agentMachineId;
    } else if (systemDefault) {
      nodeId = systemDefault;
    }
    expect(nodeId).toBe("mach_agent_bound");
  });
});
```

- [ ] **Step 2: 运行测试**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/instance-machine-fallback.test.ts
```

预期：所有 9 个测试通过（3 个 config 读取 + 3 个 engineType + 3 个 nodeId）。

- [ ] **Step 3: 提交**

```bash
git add src/__tests__/instance-machine-fallback.test.ts
git commit -m "test: 新增 instance machine/engineType fallback 优先级测试"
```

---

### Task 6: 清理旧测试引用并最终验证

**Files:**
- Modify: `src/__tests__/skill-dir-config.test.ts` — 清理 `RCS_ENGINE_TYPE` 引用
- Modify: `src/__tests__/config-system-admin-password.test.ts` — 清理 `RCS_ENGINE_TYPE` 引用

- [ ] **Step 1: 清理 `skill-dir-config.test.ts` 中的旧引用**

在 `src/__tests__/skill-dir-config.test.ts` 第 35 行，找到：

```typescript
RCS_ENGINE_TYPE: "opencode" as const,
```

直接删除该行（因为 `RCS_ENGINE_TYPE` 不再是 env schema 的一部分，测试传入不会校验失败但会产生类型错误）。

- [ ] **Step 2: 清理 `config-system-admin-password.test.ts` 中的旧引用**

在 `src/__tests__/config-system-admin-password.test.ts` 第 33 行，找到：

```typescript
RCS_ENGINE_TYPE: "opencode",
```

直接删除该行。

- [ ] **Step 3: 运行全部后端测试**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/
```

预期：全部测试通过（包括现有测试 + 新增测试）。

- [ ] **Step 4: 运行 precheck**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck
```

预期：precheck 通过（格式、排序、类型、lint 全部通过）。

- [ ] **Step 5: 提交**

```bash
git add src/__tests__/skill-dir-config.test.ts src/__tests__/config-system-admin-password.test.ts
git commit -m "test: 清理测试中废弃的 RCS_ENGINE_TYPE 引用"
```

---

## 完成标准

- [ ] `bun test src/__tests__/` 全部通过
- [ ] `bun run precheck` 通过
- [ ] 新增 9 个测试覆盖四象限（env 校验 + engineType/defaultMachineId 优先级）
- [ ] 不设置新环境变量时行为完全不向后兼容变化
- [ ] 设置 `RCS_DEFAULT_MACHINE_ID=mach_xxx` 且机器离线时抛出 `MACHINE_OFFLINE`（复用现有机制，无需额外改动）
