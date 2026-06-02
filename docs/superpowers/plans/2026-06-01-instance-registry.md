# Instance Supplements 统一注册表 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 instance.ts 中的 supplements Map 和 envInstanceCounters Map 统一到 `InstanceRegistry`，作为实例业务元数据的唯一查询入口，消除双源状态不同步风险。

**Architecture:** 创建 `InstanceRegistry` 类，维护 instanceId → 业务元数据的映射。CoreRuntimeFacade 管理运行时生命周期（spawn/stop/list），Registry 管理业务属性（userId/environmentId/organizationId/instanceNumber）。两者通过 spawn 回调和 stop 清理保持同步。`envInstanceCounters` 改为从现有实例推导（取最大 instanceNumber + 1），消除重启后丢失的问题。

**Tech Stack:** TypeScript, Bun test

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/services/instance-registry.ts` | 实例业务元数据注册表 |
| Create | `src/__tests__/instance-registry.test.ts` | 注册表单元测试 |
| Modify | `src/services/instance.ts` | 委托到 InstanceRegistry |
| Modify | `src/services/environment-web.ts` | 使用注册表查询 |
| Modify | `src/services/workflow/index.ts` | 使用注册表查询 |

---

### Task 1: 实现 InstanceRegistry 核心

**Files:**
- Create: `src/services/instance-registry.ts`
- Test: `src/__tests__/instance-registry.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// src/__tests__/instance-registry.test.ts
import { describe, expect, test } from "bun:test";
import { InstanceRegistry } from "../services/instance-registry";

describe("InstanceRegistry", () => {
  // 注册和查询
  test("register + getByInstanceId 返回已注册的实例", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-1", {
      userId: "user-1",
      environmentId: "env-1",
      organizationId: "org-1",
      instanceNumber: 1,
    });

    const meta = registry.getByInstanceId("inst-1");
    expect(meta).toBeDefined();
    expect(meta!.userId).toBe("user-1");
    expect(meta!.instanceNumber).toBe(1);
  });

  // 按环境查询
  test("getByEnvironment 返回同环境的所有实例", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-1", { userId: "u1", environmentId: "env-1", organizationId: "org-1", instanceNumber: 1 });
    registry.register("inst-2", { userId: "u2", environmentId: "env-1", organizationId: "org-1", instanceNumber: 2 });
    registry.register("inst-3", { userId: "u3", environmentId: "env-2", organizationId: "org-1", instanceNumber: 1 });

    const env1 = registry.getByEnvironment("env-1");
    expect(env1).toHaveLength(2);
  });

  // 按组织查询
  test("getByOrganization 返回同组织的所有实例", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-1", { userId: "u1", environmentId: "env-1", organizationId: "org-1", instanceNumber: 1 });
    registry.register("inst-2", { userId: "u2", environmentId: "env-2", organizationId: "org-1", instanceNumber: 1 });
    registry.register("inst-3", { userId: "u3", environmentId: "env-3", organizationId: "org-2", instanceNumber: 1 });

    const org1 = registry.getByOrganization("org-1");
    expect(org1).toHaveLength(2);
  });

  // 注销
  test("unregister 移除实例和索引", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-1", { userId: "u1", environmentId: "env-1", organizationId: "org-1", instanceNumber: 1 });
    registry.unregister("inst-1");

    expect(registry.getByInstanceId("inst-1")).toBeUndefined();
    expect(registry.getByEnvironment("env-1")).toHaveLength(0);
  });

  // instanceNumber 从现有实例推导
  test("nextInstanceNumber 从现有实例推导，不依赖独立计数器", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-1", { userId: "u1", environmentId: "env-1", organizationId: "org-1", instanceNumber: 1 });
    registry.register("inst-2", { userId: "u2", environmentId: "env-1", organizationId: "org-1", instanceNumber: 3 });

    expect(registry.nextInstanceNumber("env-1")).toBe(4);
  });

  // 无实例时 nextInstanceNumber 返回 1
  test("nextInstanceNumber 环境无实例时返回 1", () => {
    const registry = new InstanceRegistry();
    expect(registry.nextInstanceNumber("env-1")).toBe(1);
  });

  // clear 清空所有
  test("clear 清空所有注册数据", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-1", { userId: "u1", environmentId: "env-1", organizationId: "org-1", instanceNumber: 1 });
    registry.clear();

    expect(registry.size).toBe(0);
    expect(registry.getByEnvironment("env-1")).toHaveLength(0);
  });

  // has 检查存在性
  test("has 检查实例是否存在", () => {
    const registry = new InstanceRegistry();
    expect(registry.has("inst-1")).toBe(false);
    registry.register("inst-1", { userId: "u1", environmentId: "env-1", organizationId: "org-1", instanceNumber: 1 });
    expect(registry.has("inst-1")).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test src/__tests__/instance-registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```typescript
// src/services/instance-registry.ts
export interface InstanceMeta {
  userId: string;
  environmentId: string;
  organizationId: string;
  instanceNumber: number;
}

export class InstanceRegistry {
  private entries = new Map<string, InstanceMeta>();
  private byEnvironment = new Map<string, Set<string>>();
  private byOrganization = new Map<string, Set<string>>();

  register(instanceId: string, meta: InstanceMeta): void {
    this.entries.set(instanceId, meta);
    let envSet = this.byEnvironment.get(meta.environmentId);
    if (!envSet) { envSet = new Set(); this.byEnvironment.set(meta.environmentId, envSet); }
    envSet.add(instanceId);
    let orgSet = this.byOrganization.get(meta.organizationId);
    if (!orgSet) { orgSet = new Set(); this.byOrganization.set(meta.organizationId, orgSet); }
    orgSet.add(instanceId);
  }

  unregister(instanceId: string): void {
    const meta = this.entries.get(instanceId);
    if (!meta) return;
    this.entries.delete(instanceId);
    const envSet = this.byEnvironment.get(meta.environmentId);
    if (envSet) { envSet.delete(instanceId); if (envSet.size === 0) this.byEnvironment.delete(meta.environmentId); }
    const orgSet = this.byOrganization.get(meta.organizationId);
    if (orgSet) { orgSet.delete(instanceId); if (orgSet.size === 0) this.byOrganization.delete(meta.organizationId); }
  }

  getByInstanceId(instanceId: string): InstanceMeta | undefined {
    return this.entries.get(instanceId);
  }

  getByEnvironment(environmentId: string): Array<{ instanceId: string } & InstanceMeta> {
    const ids = this.byEnvironment.get(environmentId);
    if (!ids) return [];
    return [...ids].map((id) => ({ instanceId: id, ...this.entries.get(id)! })).filter((e) => e.userId);
  }

  getByOrganization(organizationId: string): Array<{ instanceId: string } & InstanceMeta> {
    const ids = this.byOrganization.get(organizationId);
    if (!ids) return [];
    return [...ids].map((id) => ({ instanceId: id, ...this.entries.get(id)! })).filter((e) => e.userId);
  }

  has(instanceId: string): boolean {
    return this.entries.has(instanceId);
  }

  nextInstanceNumber(environmentId: string): number {
    const instances = this.getByEnvironment(environmentId);
    if (instances.length === 0) return 1;
    return Math.max(...instances.map((i) => i.instanceNumber)) + 1;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.byEnvironment.clear();
    this.byOrganization.clear();
  }
}

export const globalInstanceRegistry = new InstanceRegistry();
```

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test src/__tests__/instance-registry.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services/instance-registry.ts src/__tests__/instance-registry.test.ts
git commit -m "feat(instance): 实现 InstanceRegistry 业务元数据注册表"
```

---

### Task 2: instance.ts 接入 InstanceRegistry

**Files:**
- Modify: `src/services/instance.ts`

- [ ] **Step 1: 替换 supplements Map 为 InstanceRegistry**

将 `const supplements = new Map<string, InstanceSupplement>()` 和 `const envInstanceCounters = new Map<string, number>()` 替换为 `globalInstanceRegistry`。所有 `supplements.get()` → `globalInstanceRegistry.getByInstanceId()`。所有 `supplements.set()` → `globalInstanceRegistry.register()`。所有 `supplements.delete()` → `globalInstanceRegistry.unregister()`。`getNextInstanceNumber()` → `globalInstanceRegistry.nextInstanceNumber()`。

- [ ] **Step 2: 更新 stopAllInstances**

将 `supplements.clear()` + `envInstanceCounters.clear()` 替换为 `globalInstanceRegistry.clear()`。

- [ ] **Step 3: 运行全部测试**

Run: `bun test src/__tests__/`
Expected: ALL PASS

- [ ] **Step 4: 提交**

```bash
git add src/services/instance.ts
git commit -m "refactor(instance): 用 InstanceRegistry 替代 supplements Map"
```

---

### Task 3: 更新外部调用者使用注册表

**Files:**
- Modify: `src/services/environment-web.ts`
- Modify: `src/services/workflow/index.ts`

- [ ] **Step 1: 更新 environment-web.ts**

`groupActiveInstancesByEnvironment()` 改为从 `globalInstanceRegistry` 获取实例的业务属性，不再依赖 instance.ts 的内部 supplements 导出。

- [ ] **Step 2: 更新 workflow/index.ts**

`ensureRunning` 和 `getRunningInstancesByEnvironment` 的返回值中，业务属性直接从注册表获取。

- [ ] **Step 3: 运行全部测试**

Run: `bun test src/__tests__/`
Expected: ALL PASS

- [ ] **Step 4: 运行 precheck**

Run: `bun run precheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services/environment-web.ts src/services/workflow/index.ts
git commit -m "refactor(instance): 外部调用者迁移到 InstanceRegistry 查询"
```
