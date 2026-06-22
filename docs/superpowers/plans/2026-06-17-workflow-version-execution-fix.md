# Workflow 版本执行与 Schema 一致性修复

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `resolveYaml()` 始终读草稿（version=0）的设计缺陷，同步 Schema 误导性描述。删去原计划中过度设计的 SDK 扩展部分。

**Architecture:** 将 `resolveYaml` 提取为独立服务模块（依赖注入，可 L2 测试），核心逻辑复用 `getParamDefs` 已有的 `latestVersion ?? 0` 回退。Schema 仅修正描述不新增字段。Union schema 加注释防回归。

**Tech Stack:** TypeScript, Zod v4, Elysia, Drizzle ORM, Bun test

**审查结论（ultra-batch）**：
- 问题 1（resolveYaml）→ **保留**，防御性价值，消除代码库内部不一致
- 问题 2（dryRun schema）→ **简化**，仅修正描述，不扩展 SDK（无消费者，YAGNI）
- 问题 3（union 脆弱性）→ **保留**，加一行注释

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/services/workflow/resolve-yaml.ts` | **新建** | 纯函数：从 payload 解析 YAML，支持 latestVersion 回退 + 显式 version |
| `src/routes/web/workflow-engine.ts` | 修改 | 删除内联 `resolveYaml`，改为 import service |
| `src/schemas/workflow.schema.ts` | 修改 | 修正 `run`/`dryRun` 的 `workflowId` 描述；union 加注释 |
| `src/__tests__/workflow-resolve-yaml.test.ts` | **新建** | L2 测试，依赖注入 mock |

---

### Task 1: 提取 `resolveYaml` 为独立服务模块

**Files:**
- Create: `src/services/workflow/resolve-yaml.ts`

- [ ] **Step 1: 创建 resolve-yaml 服务模块**

```typescript
/**
 * Workflow YAML 解析服务。
 *
 * 从请求 payload 中解析要执行/校验的 YAML 内容。
 * 优先级：直接传入的 yaml > 通过 workflowId + version 从存储读取。
 * 未指定 version 时默认使用最新发布版本（latestVersion ?? 0）。
 */
import { createLogger } from "@fenix/logger";
import type { getWorkflowDef as GetWorkflowDef, getVersionYaml as GetVersionYaml } from "../../repositories/workflow-def";

const logger = createLogger("wf-resolve-yaml");

/** resolveYaml 依赖的外部函数（依赖注入，便于测试） */
export interface ResolveYamlDeps {
  getWorkflowDef: typeof GetWorkflowDef;
  getVersionYaml: typeof GetVersionYaml;
}

/**
 * 从 payload 解析 YAML。
 * @returns 解析出的 YAML 字符串，或 null（无 yaml 且无 workflowId / workflow 不存在 / 版本 YAML 缺失）
 */
export async function resolveYaml(
  payload: Record<string, unknown>,
  organizationId: string,
  deps: ResolveYamlDeps,
): Promise<string | null> {
  // 优先使用直接传入的 yaml
  const yaml = payload.yaml as string | undefined;
  if (yaml) return yaml;

  const workflowId = payload.workflowId as string | undefined;
  if (!workflowId) return null;

  // 确定目标版本：显式指定 > latestVersion 回退 > 0（草稿）
  let targetVersion: number;
  if (payload.version !== undefined) {
    targetVersion = payload.version as number;
  } else {
    const wf = await deps.getWorkflowDef(workflowId, organizationId);
    if (!wf) {
      logger.warn(`resolveYaml: workflow not found for workflowId=${workflowId}`);
      return null;
    }
    targetVersion = wf.latestVersion ?? 0;
  }

  const resolved = await deps.getVersionYaml(workflowId, targetVersion, undefined);
  if (!resolved) {
    logger.warn(`resolveYaml: no yaml found for workflowId=${workflowId} version=${targetVersion}`);
  }
  return resolved;
}
```

- [ ] **Step 2: 运行 tsc 确认类型正确**

```bash
bun run tsc --noEmit
```

- [ ] **Step 3: 提交**

```bash
git add src/services/workflow/resolve-yaml.ts
git commit -m "refactor(workflow): extract resolveYaml to service module

Moves yaml resolution logic out of route handler into a testable
service module. Uses dependency injection for mockable testing.
Supports latestVersion ?? 0 fallback and explicit version override.

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

### Task 2: 更新 route 使用新服务模块 + 修复版本回退

**Files:**
- Modify: `src/routes/web/workflow-engine.ts`

- [ ] **Step 1: 更新 import**

第 1-17 行区域，将：

```typescript
import { getVersionYaml } from "../../repositories/workflow-def";
```

替换为：

```typescript
import { getVersionYaml, getWorkflowDef } from "../../repositories/workflow-def";
```

新增：

```typescript
import { resolveYaml } from "../../services/workflow/resolve-yaml";
```

- [ ] **Step 2: 删除内联 `resolveYaml` 函数（第 21–35 行）**

删除整个函数定义及其上方 JSDoc 注释。

- [ ] **Step 3: 在 switch 前构造 deps，更新 run/dryRun 调用**

在第 49 行 `const action = ...` 之后插入 deps：

```typescript
const deps = { getWorkflowDef, getVersionYaml };
```

第 56 行 `run` case：

```typescript
// 旧：
const yaml = await resolveYaml(payload);
// 新：
const yaml = await resolveYaml(payload, authCtx.organizationId, deps);
```

第 108 行 `dryRun` case：

```typescript
// 旧：
const yaml = await resolveYaml(payload);
// 新：
const yaml = await resolveYaml(payload, authCtx.organizationId, deps);
```

- [ ] **Step 4: 提交**

```bash
git add src/routes/web/workflow-engine.ts
git commit -m "fix(workflow): resolveYaml reads latestVersion instead of hardcoding draft

Previously resolveYaml always read version=0 (draft). Now follows the
getParamDefs pattern: latestVersion ?? 0 as default, with optional
explicit version override via payload.version.

Also extracts resolveYaml to a dedicated service module for testability.

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

### Task 3: 修正 Schema 描述 + union 注释

**Files:**
- Modify: `src/schemas/workflow.schema.ts:322-332`（run + dryRun action schema）
- Modify: `src/schemas/workflow.schema.ts:183-184`（union 注释）

- [ ] **Step 1: 修正 `run` action 描述**

第 322–327 行，将 `workflowId` 字段的 describe 从：

```
"可选工作流 ID；传入后从草稿读取 YAML，用于事件归档。"
```

改为：

```
"可选工作流 ID；传入后从最新发布版本（latestVersion ?? 0）读取 YAML，用于事件归档。"
```

- [ ] **Step 2: 修正 `dryRun` action 描述**

第 328–332 行，将 `workflowId` 字段的 describe 从：

```
"可选工作流 ID；传入后从草稿读取 YAML，用于发布干运行事件。"
```

改为：

```
"可选工作流 ID；传入后从最新发布版本（latestVersion ?? 0）读取 YAML，用于发布干运行事件。"
```

> **注意**：`yaml` 保持 `.optional()`（前端始终传 yaml，但后端 fallback 路径在 resolveYaml 修复后已正确工作）。不新增 `version` 字段（当前无调用方通过 API 传 version，YAGNI）。

- [ ] **Step 3: 为 union schema 加脆弱性注释**

在第 184 行 `export const WorkflowDefsActionResponseSchema` 前插入：

```typescript
// ⚠️ 变体顺序敏感：WorkflowDefDetailSchema（含 draftYaml）必须排在 WorkflowDefSchema 前，
// 否则 get action 返回的 { ...wf, draftYaml } 会被 Zod strip 模式默认剥离未知键。
```

- [ ] **Step 4: 提交**

```bash
git add src/schemas/workflow.schema.ts
git commit -m "docs(workflow): fix misleading workflowId descriptions, add union fragility comment

- run/dryRun: workflowId now describes latestVersion fallback instead of '草稿'
- Add union ordering warning for WorkflowDefsActionResponseSchema

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

### Task 4: 编写后端测试

**Files:**
- Create: `src/__tests__/workflow-resolve-yaml.test.ts`

- [ ] **Step 1: 编写完整测试（L2，依赖注入 mock）**

```typescript
/**
 * resolveYaml 版本回退逻辑测试。
 *
 * resolveYaml 通过依赖注入接受 getWorkflowDef / getVersionYaml，测试时传入 mock 即可。
 */
import { describe, test, expect, mock } from "bun:test";
import { resolveYaml } from "../services/workflow/resolve-yaml";

function makeDeps(opts: {
  workflow?: { latestVersion: number | null; storagePath: string | null } | null;
  yamlByVersion?: Record<number, string | null>;
}) {
  const getWorkflowDef = mock(async (_id: string, _orgId: string) => opts.workflow ?? null);
  const getVersionYaml = mock(
    async (_id: string, version: number, _storagePath?: string | null) =>
      opts.yamlByVersion?.[version] ?? null,
  );
  return { getWorkflowDef, getVersionYaml };
}

describe("resolveYaml", () => {
  // 直接传入 yaml 时无视 workflowId 和 version
  test("payload 包含 yaml 时直接返回 yaml，忽略 workflowId", async () => {
    const deps = makeDeps({});
    const result = await resolveYaml(
      { yaml: "name: test", workflowId: "wf1", version: 5 },
      "org1",
      deps,
    );
    expect(result).toBe("name: test");
    expect(deps.getWorkflowDef).toHaveBeenCalledTimes(0);
    expect(deps.getVersionYaml).toHaveBeenCalledTimes(0);
  });

  // 无 yaml 且无 workflowId → null
  test("无 yaml 且无 workflowId 时返回 null", async () => {
    const deps = makeDeps({});
    const result = await resolveYaml({ params: {} }, "org1", deps);
    expect(result).toBeNull();
  });

  // 仅 workflowId → 查 DB 获取 latestVersion ?? 0
  test("仅 workflowId 时以 latestVersion 作为目标版本", async () => {
    const deps = makeDeps({
      workflow: { latestVersion: 3, storagePath: "/wf" },
      yamlByVersion: { 3: "name: v3" },
    });
    const result = await resolveYaml({ workflowId: "wf1" }, "org1", deps);
    expect(result).toBe("name: v3");
    expect(deps.getWorkflowDef).toHaveBeenCalledTimes(1);
    expect(deps.getVersionYaml).toHaveBeenCalledWith("wf1", 3, undefined);
  });

  // latestVersion 为 null → 退回 version=0（草稿）
  test("latestVersion 为 null 时退回到 version=0", async () => {
    const deps = makeDeps({
      workflow: { latestVersion: null, storagePath: "/wf" },
      yamlByVersion: { 0: "name: draft" },
    });
    const result = await resolveYaml({ workflowId: "wf1" }, "org1", deps);
    expect(result).toBe("name: draft");
    expect(deps.getVersionYaml).toHaveBeenCalledWith("wf1", 0, undefined);
  });

  // 显式指定 version → 使用指定版本，不查 DB
  test("显式指定 version 时直接使用，跳过 latestVersion 查询", async () => {
    const deps = makeDeps({
      workflow: { latestVersion: 3, storagePath: "/wf" },
      yamlByVersion: { 1: "name: v1" },
    });
    const result = await resolveYaml({ workflowId: "wf1", version: 1 }, "org1", deps);
    expect(result).toBe("name: v1");
    expect(deps.getWorkflowDef).toHaveBeenCalledTimes(0);
    expect(deps.getVersionYaml).toHaveBeenCalledWith("wf1", 1, undefined);
  });

  // workflow 不存在 → null
  test("workflow 不存在时返回 null", async () => {
    const deps = makeDeps({ workflow: null });
    const result = await resolveYaml({ workflowId: "nope" }, "org1", deps);
    expect(result).toBeNull();
  });

  // 指定 version 存在但对应 YAML 缺失 → null
  test("指定版本存在但 YAML 文件缺失时返回 null", async () => {
    const deps = makeDeps({
      workflow: { latestVersion: 1, storagePath: "/wf" },
      yamlByVersion: {},
    });
    const result = await resolveYaml({ workflowId: "wf1", version: 1 }, "org1", deps);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: 运行新测试确保通过**

```bash
bun test src/__tests__/workflow-resolve-yaml.test.ts
```

期望：7 个测试全部 PASS。

- [ ] **Step 3: 提交**

```bash
git add src/__tests__/workflow-resolve-yaml.test.ts
git commit -m "test(workflow): add resolveYaml version resolution tests

Covers: yaml-priority, latestVersion fallback, null→draft fallback,
explicit version skip-DB, workflow-not-found, version-yaml-missing.

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

### Task 5: 最终验证

- [ ] **Step 1: 运行全部后端测试**

```bash
bun test src/__tests__/
```

- [ ] **Step 2: 运行 precheck**

```bash
bun run precheck
```

期望：precheck 通过（format + import-sort + tsc + biome check 均无报错）。

- [ ] **Step 3: 构建前端确认无破坏**

```bash
bun run build:web
```

---

## 原计划删减说明

| 删减项 | 原因 |
|--------|------|
| Schema 新增 `version` 字段 | 无 API 调用方传 version（前端永远传 yaml），YAGNI。`payload.version` 仍可被代码路径使用，但不在 Schema 声明 |
| SDK `run()` 新增 `version` opts | 无消费者 |
| SDK `dryRun()` 扩展 `yamlOrOpts` 重载 | 无消费者，且 `typeof` 区分增加维护负担 |

## 变更影响总结

| 改动 | 兼容性 | 说明 |
|------|--------|------|
| `resolveYaml()` 使用 `latestVersion ?? 0` | **行为变更** | 之前始终读草稿，现在默认读最新发布版本；前端始终传 `yaml`，不受影响 |
| 新增 `src/services/workflow/resolve-yaml.ts` | 无破坏 | 从 route 内联函数提取 |
| Schema 描述修正 | 无破坏 | 纯文档 |
| Union schema 注释 | 无破坏 | 纯文档 |
