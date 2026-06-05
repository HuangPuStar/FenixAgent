# 远程节点标注与启动前连接检查 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 AgentSidebarTree 中为绑定远程节点的 agent 显示「远程」徽章，并在实例启动前检查远程节点 ACP WS 连接状态，不通则拒绝启动。

**Architecture:** 后端在 `spawnInstanceFromEnvironment` 的 nodeId 确定后、`launchInstance` 前插入连接守卫，调用已有的 `findMachineConnectionById` 检查 WS 状态。前端在 `AgentConfigItem` 中新增 `machineId` 字段，agent 卡片渲染时根据该字段显示「远程」标签。无 schema 变更，无新 API。

**Tech Stack:** Elysia（后端）、React 19 + lucide-react（前端）、i18next（国际化）

---

### Task 1: 后端 — 实例启动前远程节点连接检查

**Files:**
- Modify: `src/services/instance.ts:133-175`
- Test: `src/__tests__/instance-remote-guard.test.ts`

- [ ] **Step 1: 在 `instance.ts` 添加 import**

在文件顶部的 import 区域（line 12 之后）添加：

```typescript
import { findMachineConnectionById } from "../transport/acp-ws-handler";
```

注意：`instance.ts` 已有 `import { AppError, NotFoundError } from "../errors";`（line 6）。`AppError` 构造签名为 `new AppError(message, statusCode, type)`（来自 `src/errors/index.ts`）。

- [ ] **Step 2: 在 nodeId 确定后插入连接守卫**

在 `src/services/instance.ts` 的 line 165（`if (agentMachineId) { nodeId = agentMachineId; }` 之后），line 167（`// 委托 core 执行 launch`）之前，插入：

```typescript
  // 远程节点启动前连接检查
  if (nodeId !== "local-default") {
    const machineConn = findMachineConnectionById(nodeId);
    if (!machineConn) {
      throw new AppError(
        `远程节点 '${nodeId}' 未连接，无法启动实例`,
        503,
        "MACHINE_OFFLINE",
      );
    }
  }
```

- [ ] **Step 3: 编写测试**

创建 `src/__tests__/instance-remote-guard.test.ts`：

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { resetAllStubs, stubDb, stubConfigPg, stubEnv } from "../test-utils/setup-mocks";

// 重置所有 stub
beforeEach(() => {
  resetAllStubs();
  stubEnv();
});

describe("spawnInstanceFromEnvironment 远程节点守卫", () => {
  // 远程节点在线时正常启动（此测试验证守卫不误拦本地节点）
  test("本地节点不检查连接，跳过守卫逻辑", async () => {
    // agentConfig 无 machineId → nodeId = "local-default"
    // 守卫应跳过，错误由后续 launchInstance 产生（因无 mock runtime）
    const { spawnInstanceFromEnvironment } = await import("../services/instance");
    const result = spawnInstanceFromEnvironment("user-1", "env-nonexistent");
    // 本地节点不触发 MACHINE_OFFLINE，而是其他错误
    await expect(result).rejects.toThrow();
    await expect(result).rejects.not.toThrow(/未连接/);
  });

  // 远程节点离线时抛出 503
  test("远程节点离线时抛出 MACHINE_OFFLINE (503)", async () => {
    const { spawnInstanceFromEnvironment } = await import("../services/instance");
    const { AppError } = await import("../errors/index");

    // 设置 environment 有 agentConfig 且 agentConfig 有 machineId
    stubDb({
      environment: [
        {
          id: "env-remote",
          organizationId: "org-1",
          userId: "user-1",
          agentConfigId: "agc-remote",
          secret: "secret-123",
          autoStart: false,
          workspacePath: "",
        },
      ],
    });

    stubConfigPg({
      getReadableAgentConfigById: async () => ({
        id: "agc-remote",
        organizationId: "org-1",
        name: "remote-agent",
        model: "test-model",
        prompt: "test",
        mode: "code",
        permission: {},
        knowledge: {},
        machineId: "mach_offline_001", // 绑定远程节点
        resourceAccess: { ownership: "internal" },
      }),
    });

    // findMachineConnectionById 返回 null（离线）
    // 由于 findMachineConnectionById 是实时内存查询，stub 模式下 connections 为空，自然返回 null

    try {
      await spawnInstanceFromEnvironment("user-1", "env-remote");
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as InstanceType<typeof AppError>;
      expect(appErr.statusCode).toBe(503);
      expect(appErr.type).toBe("MACHINE_OFFLINE");
      expect(appErr.message).toContain("未连接");
    }
  });
});
```

- [ ] **Step 4: 运行测试验证**

Run: `bun test src/__tests__/instance-remote-guard.test.ts`
Expected: 2 tests PASS

- [ ] **Step 5: 提交**

```bash
git add src/services/instance.ts src/__tests__/instance-remote-guard.test.ts
git commit -m "feat(instance): 远程节点启动前连接检查，离线拒绝启动 (503 MACHINE_OFFLINE)

Co-Authored-By: glm-5.1 <zai-org@claude-code-best.win>"
```

---

### Task 2: 前端 — AgentSidebarTree 远程节点徽章

**Files:**
- Modify: `web/src/pages/agent-panel/AgentSidebarTree.tsx:43-52,496-516`
- Modify: `web/src/i18n/locales/en/agentPanel.json`
- Modify: `web/src/i18n/locales/zh/agentPanel.json`

- [ ] **Step 1: 在 `AgentConfigItem` 接口添加 `machineId` 字段**

在 `web/src/pages/agent-panel/AgentSidebarTree.tsx` 的 `AgentConfigItem` 接口（line 43-52）中添加 `machineId`：

```typescript
interface AgentConfigItem {
  id: string;
  name: string;
  builtIn: boolean;
  model: string | null;
  modelLabel?: string | null;
  description: string | null;
  color: string | null;
  resourceAccess?: ResourceAccess;
  machineId?: string | null;
}
```

- [ ] **Step 2: 添加 i18n 翻译键**

在 `web/src/i18n/locales/en/agentPanel.json` 末尾（`"cancel"` 之前）添加：

```json
"remoteNode": "Remote",
```

在 `web/src/i18n/locales/zh/agentPanel.json` 末尾（`"cancel"` 之前）添加：

```json
"remoteNode": "远程",
```

- [ ] **Step 3: 在 agent 卡片中渲染远程徽章**

在 `web/src/pages/agent-panel/AgentSidebarTree.tsx` 的 agent 卡片渲染区域，在 `sharedFrom` 条件渲染（约 line 509-515）之后、`</div>` 关闭（line 516）之前，添加远程徽章：

```tsx
{agent.machineId && (
  <div className="flex items-center gap-1 mt-0.5">
    <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
    <span className="text-[10px] text-text-muted">{t("remoteNode")}</span>
  </div>
)}
```

这段代码放在 `{agent.resourceAccess?.ownership === "external" && (...)}` 条件块之后，与其同级。

- [ ] **Step 4: 构建前端验证**

Run: `bun run build:web`
Expected: 构建成功，无 TS 错误

- [ ] **Step 5: 提交**

```bash
git add web/src/pages/agent-panel/AgentSidebarTree.tsx web/src/i18n/locales/en/agentPanel.json web/src/i18n/locales/zh/agentPanel.json
git commit -m "feat(agent-panel): 远程节点 agent 卡片显示「远程」徽章

Co-Authored-By: glm-5.1 <zai-org@claude-code-best.win>"
```

---

### Task 3: 验收 — precheck 通过

**Files:** 无新增/修改

- [ ] **Step 1: 运行 precheck**

Run: `bun run precheck`
Expected: 全部通过（format + import sort + tsc + biome check）

- [ ] **Step 2: 运行后端测试**

Run: `bun test src/__tests__/instance-remote-guard.test.ts`
Expected: 2 tests PASS

- [ ] **Step 3: 运行前端构建**

Run: `bun run build:web`
Expected: 构建成功
