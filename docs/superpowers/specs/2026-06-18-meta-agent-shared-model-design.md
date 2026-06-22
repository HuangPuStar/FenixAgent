# Meta Agent 共享 Model 支持

**日期**: 2026-06-18  
**状态**: accepted

## 问题

新组织没有任何 provider/model 时，启动 Meta Agent 无法使用系统管理员公开共享的 provider/model。根本原因是 `ensureMetaConfig` 向 agent_config 表写入的是废弃的 `model` varchar 字段（字符串 ref），而运行时 `launch-spec-builder.ts` 读取的是 `modelId` uuid 字段。`model` 不在 `AGENT_SETTABLE_FIELDS` 白名单中，写入被静默忽略，导致 `modelId` 始终为 null。

## 设计

### 改动范围

仅修改 `src/services/meta-agent.ts`，后端一处文件。

### 变更 1：`resolveDefaultMetaModelRef` 返回 model UUID

将返回值从字符串 ref（如 `"openai/gpt-4o"`）改为 model 行的 UUID 主键。

```typescript
async function resolveDefaultMetaModelRef(ctx: AuthContext): Promise<string | null> {
  const providers = await listProviders(ctx);
  for (const provider of providers) {
    const providerKey = provider.resourceAccess?.resourceKey ?? provider.name;
    const detail = await getProvider(ctx, providerKey);
    const firstModel = detail?.models?.[0];
    if (!firstModel) continue;
    return firstModel.id; // model UUID，runtime 通过 modelId FK 直接定位
  }
  return null;
}
```

`listProviders` 已合并内部 + 共享 provider，外部 provider 的 model 也会被遍历到。`getProvider` 对内部/外部 provider 均可正确返回 model 列表，每个 model 带 `id`（UUID 主键）。

### 变更 2：`ensureMetaConfig` 传 `modelId` 替代 `model`

创建时：

```typescript
await createAgentConfig(ctx, META_AGENT_CONFIG_NAME, {
  description: "Meta Agent — 工作流编排助手",
  modelId: defaultModelRef,  // UUID，替代废弃的 model 字符串
  prompt: null,
});
```

已有配置但 model 为空时的回填：

```typescript
await updateAgentConfig(ctx, META_AGENT_CONFIG_NAME, {
  modelId: defaultModelRef,
});
```

### 为什么这样就够了

- `AGENT_SETTABLE_FIELDS` 包含 `modelId`，`buildSetFromData` 会正确写入 UUID 并清空废弃的 `model` 列
- `listProviders` 已合并内部 + 共享 provider，新组织无自身 provider 也能遍历到公开共享的
- `model_id` 是 FK 到 `model` 表，无 org 限制，外部 org 的 model UUID 也能写入
- `resolveModelConfig` 运行时通过 UUID 定位 model → provider → 完整链路可走通

### 不修的部分

- `launch-spec-builder.ts` 的 `resolveFirstReadableModelConfig` 兜底逻辑保持不动，Meta Agent 路径修复后不会再走到这个 fallback
- 不做任何前端变更
- 不做 UI 提示/确认

## 测试要点

- Meta Agent 在新组织（无自身 provider/model）能成功启动并使用公开共享的 model
- 已有 model 的 org 不受影响，Meta Agent 仍优先使用自身 model
- `modelId` 写入后 `model` 列被清空，不会双写漂移
