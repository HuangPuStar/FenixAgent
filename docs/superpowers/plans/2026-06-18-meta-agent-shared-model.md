# Meta Agent 共享 Model 支持 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `ensureMetaConfig` 使其通过 `modelId`（UUID FK）而非废弃的 `model`（varchar）写入模型引用，让新组织无自身 model 时能静默使用公开共享的 model。

**Architecture:** 仅修改 `src/services/meta-agent.ts` 中两个函数：`resolveDefaultMetaModelRef` 改返回 model UUID，`ensureMetaConfig` 中两处调用改用 `modelId` 传参。`AGENT_SETTABLE_FIELDS` 白名单和 `buildSetFromData` 已原生支持 `modelId`，无需额外适配。

**Tech Stack:** Bun + Elysia + Drizzle ORM

---

### Task 1: 修改 `resolveDefaultMetaModelRef` 返回 model UUID

**Files:**
- Modify: `src/services/meta-agent.ts:82-94`

- [ ] **Step 1: 修改返回值**

将 `resolveDefaultMetaModelRef` 函数体中 `return` 语句从返回字符串 ref 改为返回 `firstModel.id`：

```typescript
/** 确保环境中存在 meta agent 所需的 AgentConfig 和 Skill */
async function resolveDefaultMetaModelRef(ctx: AuthContext): Promise<string | null> {
  const providers = await listProviders(ctx);
  for (const provider of providers) {
    const providerKey = provider.resourceAccess?.resourceKey ?? provider.name;
    const detail = await getProvider(ctx, providerKey);
    const firstModel = detail?.models?.[0];
    if (!firstModel) continue;
    // 返回 model UUID 主键，运行时通过 modelId FK 直接定位
    // listProviders 已合并内部 + 外部共享 provider，getProvider 对两者均可正确返回 models
    return firstModel.id;
  }
  return null;
}
```

- [ ] **Step 2: 验证函数签名未变**

函数仍返回 `Promise<string | null>`，所有调用方不受签名影响。

- [ ] **Step 3: Commit**

```bash
git add src/services/meta-agent.ts
git commit -m "fix(meta-agent): resolveDefaultMetaModelRef returns model UUID instead of string ref"
```

---

### Task 2: 修改 `ensureMetaConfig` 传 `modelId` 替代 `model`

**Files:**
- Modify: `src/services/meta-agent.ts:273-299`

- [ ] **Step 1: 修改创建分支**

将 `createAgentConfig` 调用中的 `model` 改为 `modelId`：

```typescript
// 创建时（第 277 行附近）
if (!agentConfig) {
  const defaultModelRef = await resolveDefaultMetaModelRef(ctx);
  await createAgentConfig(ctx, META_AGENT_CONFIG_NAME, {
    description: "Meta Agent — 工作流编排助手",
    modelId: defaultModelRef,  // 传 model UUID，走 AGENT_SETTABLE_FIELDS 白名单中的 modelId 字段
    prompt: null,
  });
  agentConfig = await getAgentConfig(ctx, META_AGENT_CONFIG_NAME);
  if (!agentConfig) {
    throw new Error("Failed to create meta agent config");
  }
}
```

- [ ] **Step 2: 修改回填分支**

将 `updateAgentConfig` 调用中的 `model` 改为 `modelId`：

```typescript
// 已有配置但 model 为空时的自动回填（第 289 行附近）
if (!agentConfig.model?.trim()) {
  const defaultModelRef = await resolveDefaultMetaModelRef(ctx);
  if (defaultModelRef) {
    log(`[meta-agent] Auto-filling empty model for meta AgentConfig: ${defaultModelRef}`);
    await updateAgentConfig(ctx, META_AGENT_CONFIG_NAME, {
      modelId: defaultModelRef,  // 传 model UUID
    });
  } else {
    log(`[meta-agent] No provider/model available to auto-fill meta AgentConfig model`);
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/services/meta-agent.ts
git commit -m "fix(meta-agent): ensureMetaConfig passes modelId instead of deprecated model field"
```

---

### Task 3: 验证

- [ ] **Step 1: 运行 precheck**

```bash
bun run precheck
```
Expected: PASS (format, import-sort, tsc, lint, test 全部通过)

- [ ] **Step 2: 运行 meta-agent 测试**

```bash
bun test src/__tests__/meta-agent.test.ts
```
Expected: PASS（现有 3 个测试不受影响，均为 syncBuiltin 相关）

- [ ] **Step 3: 手动验证（可选）**

1. 创建一个新组织（无任何 provider/model）
2. 在 admin 组织创建一个 provider + model 并设为公开
3. 在新组织触发 Meta Agent ensure → 确认实例能成功 spawn（通过 `agentConfig.modelId` 引用了共享 model）
4. 检查 `agent_config` 表中 meta 行的 `model_id` 列有值、`model` 列为 null
