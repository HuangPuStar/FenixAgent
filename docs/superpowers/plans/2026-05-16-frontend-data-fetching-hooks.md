# 前端数据获取模式统一 — 提取 useConfigModule Hook

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-step. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提取通用的 `useConfigModule<T>` hook 封装 Eden Treaty CRUD + loading/error 状态管理，消除各配置页面重复的 CRUD 模式代码。

**Architecture:** 创建 `web/src/hooks/useConfigModule.ts` 泛型 hook，封装 list/get/create/update/delete 五种操作的 loading 状态、错误处理（toast）和自动刷新。配置页面（ModelsPage、AgentsPage、SkillsPage、McpPage）使用此 hook 替代各自的 `useState` + `useCallback` CRUD 实现。

**Tech Stack:** React hooks、Eden Treaty、Sonner toast

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `web/src/hooks/useConfigModule.ts` | 通用配置 CRUD hook |
| Create | `web/src/__tests__/useConfigModule.test.ts` | Hook 测试 |
| Modify | `web/src/pages/ModelsPage.tsx` | 使用 hook 替代内联 CRUD |
| Modify | `web/src/pages/AgentsPage.tsx` | 使用 hook 替代内联 CRUD |
| Modify | `web/src/pages/SkillsPage.tsx` | 使用 hook 替代内联 CRUD |
| Modify | `web/src/pages/McpPage.tsx` | 使用 hook 替代内联 CRUD |

---

### Task 1: 创建 useConfigModule Hook

**Files:**
- Create: `web/src/hooks/useConfigModule.ts`

- [ ] **Step 1: 实现 hook**

```typescript
// web/src/hooks/useConfigModule.ts
import { useState, useCallback } from "react";
import { toast } from "sonner";
import { client } from "../api/client";
import { unwrapConfigData } from "../api/config-response";

interface ConfigModuleOptions<T> {
  /** 配置模块路径，如 "models"、"agents" */
  module: string;
  /** 从 API 响应中提取列表数据 */
  getList?: (raw: unknown) => T[];
  /** 从 API 响应中提取单项数据 */
  getItem?: (raw: unknown) => T;
}

export function useConfigModule<T extends { id?: string; name?: string }>(
  options: ConfigModuleOptions<T>,
) {
  const { module } = options;
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await (client.web.config as any)[module].post({
        action: "list",
      });
      if (error) {
        toast.error(`加载${module}失败: ${error.value ?? error}`);
        return;
      }
      const list = options.getList
        ? options.getList(data)
        : unwrapConfigData<T[]>(data as any);
      setItems(Array.isArray(list) ? list : []);
    } catch (err) {
      console.error(err);
      toast.error(`加载${module}失败`);
    } finally {
      setLoading(false);
    }
  }, [module]);

  const getItem = useCallback(async (name: string): Promise<T | null> => {
    try {
      const { data, error } = await (client.web.config as any)[module].post({
        action: "get",
        name,
      });
      if (error) {
        toast.error(`获取${module}失败`);
        return null;
      }
      return options.getItem
        ? options.getItem(data)
        : unwrapConfigData<T>(data as any);
    } catch (err) {
      console.error(err);
      toast.error(`获取${module}失败`);
      return null;
    }
  }, [module]);

  const createItem = useCallback(async (payload: Record<string, unknown>): Promise<T | null> => {
    setSaving(true);
    try {
      const { data, error } = await (client.web.config as any)[module].post({
        action: "create",
        ...payload,
      });
      if (error) {
        toast.error(`创建${module}失败: ${error.value ?? error}`);
        return null;
      }
      const item = options.getItem
        ? options.getItem(data)
        : unwrapConfigData<T>(data as any);
      toast.success(`创建成功`);
      await fetchList();
      return item;
    } catch (err) {
      console.error(err);
      toast.error(`创建${module}失败`);
      return null;
    } finally {
      setSaving(false);
    }
  }, [module, fetchList]);

  const updateItem = useCallback(async (name: string, payload: Record<string, unknown>): Promise<T | null> => {
    setSaving(true);
    try {
      const { data, error } = await (client.web.config as any)[module].post({
        action: "set",
        name,
        ...payload,
      });
      if (error) {
        toast.error(`更新${module}失败: ${error.value ?? error}`);
        return null;
      }
      const item = options.getItem
        ? options.getItem(data)
        : unwrapConfigData<T>(data as any);
      toast.success(`更新成功`);
      await fetchList();
      return item;
    } catch (err) {
      console.error(err);
      toast.error(`更新${module}失败`);
      return null;
    } finally {
      setSaving(false);
    }
  }, [module, fetchList]);

  const deleteItem = useCallback(async (name: string): Promise<boolean> => {
    setSaving(true);
    try {
      const { error } = await (client.web.config as any)[module].post({
        action: "delete",
        name,
      });
      if (error) {
        toast.error(`删除${module}失败: ${error.value ?? error}`);
        return false;
      }
      toast.success(`删除成功`);
      await fetchList();
      return true;
    } catch (err) {
      console.error(err);
      toast.error(`删除${module}失败`);
      return false;
    } finally {
      setSaving(false);
    }
  }, [module, fetchList]);

  const enableItem = useCallback(async (name: string, enabled: boolean): Promise<boolean> => {
    setSaving(true);
    try {
      const { error } = await (client.web.config as any)[module].post({
        action: enabled ? "enable" : "disable",
        name,
      });
      if (error) {
        toast.error(`${enabled ? "启用" : "禁用"}失败`);
        return false;
      }
      toast.success(enabled ? "已启用" : "已禁用");
      await fetchList();
      return true;
    } catch (err) {
      console.error(err);
      toast.error(`操作失败`);
      return false;
    } finally {
      setSaving(false);
    }
  }, [module, fetchList]);

  return {
    items,
    loading,
    saving,
    fetchList,
    getItem,
    createItem,
    updateItem,
    deleteItem,
    enableItem,
  };
}
```

- [ ] **Step 2: 运行前端类型检查**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck`
Expected: 无新增错误（hook 文件不引用未导出类型）

- [ ] **Step 3: Commit**

```bash
git add web/src/hooks/useConfigModule.ts
git commit -m "feat: 创建 useConfigModule 泛型 hook — 统一配置 CRUD 模式"
```

---

### Task 2: 重构 ModelsPage 使用 useConfigModule

**Files:**
- Modify: `web/src/pages/ModelsPage.tsx`

- [ ] **Step 1: 识别 ModelsPage 中的 CRUD 模式代码**

在 `ModelsPage.tsx` 中找到以下模式并标记为重构目标：
- `fetchProviders()` 函数 — 加载 provider 列表
- `handleSaveProvider()` / `handleDeleteProvider()` — Provider CRUD
- `handleSaveModel()` / `handleDeleteModel()` — Model CRUD
- `loading` / `saving` / `providerSaving` / `modelSaving` 状态变量

- [ ] **Step 2: 引入 hook 替代 Provider CRUD**

在组件顶部添加：

```typescript
import { useConfigModule } from "../hooks/useConfigModule";

// 在 ModelsPage 组件内部:
const providers = useConfigModule<ProviderInfo>({
  module: "providers",
  getList: (raw) => unwrapConfigData<ProviderInfo[]>(raw as any),
});
```

将 `fetchProviders()` → `providers.fetchList()`
将 `handleSaveProvider()` → `providers.createItem()` / `providers.updateItem()`
将 `handleDeleteProvider()` → `providers.deleteItem()`

> **注意：** ModelsPage 的 Provider + Model 双层结构意味着需要两个 hook 实例。Model 是 Provider 的子资源，不能直接用 `useConfigModule` 的标准 action。Model 的 CRUD 保留在页面组件中，但可以从 Provider CRUD 开始逐步替换。

- [ ] **Step 3: 运行前端构建验证**

Run: `bun run build:web`
Expected: 构建成功

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/ModelsPage.tsx
git commit -m "refactor: ModelsPage Provider CRUD 改用 useConfigModule hook"
```

---

### Task 3: 重构 AgentsPage 使用 useConfigModule

**Files:**
- Modify: `web/src/pages/AgentsPage.tsx`

- [ ] **Step 1: 识别 AgentsPage 中的 CRUD 模式**

AgentsPage 的 CRUD 模式比 ModelsPage 简单（单层 Agent 配置），更适合直接替换。

- [ ] **Step 2: 引入 hook 替代 Agent CRUD**

```typescript
import { useConfigModule } from "../hooks/useConfigModule";

// 组件内:
const agents = useConfigModule<AgentConfig>({
  module: "agents",
  getList: (raw) => unwrapConfigData<AgentConfig[]>(raw as any),
});
```

替换：
- `fetchAgents()` → `agents.fetchList()`
- 创建 Agent → `agents.createItem(payload)`
- 更新 Agent → `agents.updateItem(name, payload)`
- 删除 Agent → `agents.deleteItem(name)`

- [ ] **Step 3: 运行构建验证**

Run: `bun run build:web`
Expected: 构建成功

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/AgentsPage.tsx
git commit -m "refactor: AgentsPage CRUD 改用 useConfigModule hook"
```

---

### Task 4: 重构 SkillsPage 和 McpPage

**Files:**
- Modify: `web/src/pages/SkillsPage.tsx`
- Modify: `web/src/pages/McpPage.tsx`

- [ ] **Step 1: SkillsPage 引入 hook**

```typescript
const skills = useConfigModule<SkillInfo>({
  module: "skills",
});
```

替换 SkillsPage 中的 `fetchSkills()`、`handleSave()`、`handleDelete()` 等。

- [ ] **Step 2: McpPage 引入 hook**

```typescript
const mcpServers = useConfigModule<McpServerConfig>({
  module: "mcp",
});
```

替换 McpPage 中的 `fetchMcpServers()`、`handleSave()`、`handleDelete()` 等。

- [ ] **Step 3: 运行构建验证**

Run: `bun run build:web`
Expected: 构建成功

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/SkillsPage.tsx web/src/pages/McpPage.tsx
git commit -m "refactor: SkillsPage + McpPage CRUD 改用 useConfigModule hook"
```

---

### Task 5: 添加 Hook 单元测试

**Files:**
- Create: `web/src/__tests__/useConfigModule.test.ts`

- [ ] **Step 1: 写 hook 基本行为测试**

```typescript
import { describe, test, expect, mock } from "bun:test";
import { unwrapConfigData } from "../api/config-response";
import { isUserPath, normalizeUserRoutePath } from "../hooks/useConfigModule";

describe("useConfigModule 辅助验证", () => {
  // 直接测试 hook 依赖的纯函数逻辑不现实（hook 需要 React 渲染环境），
  // 但可以验证 unwrapConfigData 和配置模块的交互契约。

  test("unwrapConfigData 正确解包嵌套 data", () => {
    const input = { success: true, data: [{ id: "1", name: "test" }] };
    const result = unwrapConfigData(input as any);
    expect(Array.isArray(result)).toBe(true);
  });

  test("unwrapConfigData 直接返回非嵌套数据", () => {
    const input = [{ id: "1", name: "test" }];
    const result = unwrapConfigData(input as any);
    expect(result).toEqual(input);
  });
});
```

> **注意：** React hook 测试需要 `@testing-library/react-hooks` 或类似环境。当前项目使用 Bun test，不包含 React 渲染环境。此测试验证 hook 依赖的纯函数行为，完整 hook 测试留给后续 React Testing Library 集成。

- [ ] **Step 2: 运行测试**

Run: `bun test web/src/__tests__/useConfigModule.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/src/__tests__/useConfigModule.test.ts
git commit -m "test: 添加 useConfigModule 辅助函数测试"
```

---

## Self-Review

**Spec coverage:** 4 个配置页面（Models、Agents、Skills、MCP）的 CRUD 模式统一。Provider 的双层结构（Provider → Model）部分覆盖。

**Placeholder scan:** 无 TBD/TODO。Hook 实现完整，包含所有 7 种操作（list/get/create/update/delete/enable/disable）。

**Type consistency:** `useConfigModule<T>` 泛型参数在各页面中一致使用对应的类型（`ProviderInfo`、`AgentConfig`、`SkillInfo`、`McpServerConfig`）。Eden Treaty 的 `(client.web.config as any)[module]` 动态访问方式与 ADR-0003 兼容。
