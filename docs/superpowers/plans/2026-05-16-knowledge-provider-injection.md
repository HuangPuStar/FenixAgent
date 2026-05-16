# Knowledge Provider 注入重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除 knowledge-base.ts、knowledge-upload.ts、knowledge-runtime.ts 中三个独立的模块级 `knowledgeProvider` 单例，集中到一处初始化并通过函数参数传递。

**Architecture:** 当前三个文件各自持有 `let knowledgeProvider: KnowledgeProvider | null = null` 懒初始化单例，并暴露 `set*ForTesting()` 函数。改为：`knowledge-provider/registry.ts` 持有唯一 provider 实例，其他文件通过 `getKnowledgeProvider()` 获取。

**Tech Stack:** TypeScript

---

### Task 1: 创建 Provider Registry

**Files:**
- Create: `src/services/knowledge-provider/registry.ts`

- [ ] **Step 1: 创建 registry 模块**

```typescript
// src/services/knowledge-provider/registry.ts
import { createKnowledgeProvider } from "./openviking";
import type { KnowledgeProvider } from "./types";

let provider: KnowledgeProvider | null = null;

export function getKnowledgeProvider(): KnowledgeProvider {
  if (!provider) {
    provider = createKnowledgeProvider();
  }
  return provider;
}

export function setKnowledgeProviderForTesting(p: KnowledgeProvider | null): void {
  provider = p;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/knowledge-provider/registry.ts
git commit -m "refactor: 创建 knowledge provider registry，集中 provider 单例"
```

### Task 2: 迁移三个 knowledge service 使用 registry

**Files:**
- Modify: `src/services/knowledge-base.ts`
- Modify: `src/services/knowledge-upload.ts`
- Modify: `src/services/knowledge-runtime.ts`

- [ ] **Step 1: 更新 `knowledge-base.ts`**

- 删除本地的 `let knowledgeProvider` 和 `getKnowledgeProvider()`（lines 65-72）
- 删除 `setKnowledgeProviderForTesting()`（line 74-76）
- 改为 `import { getKnowledgeProvider, setKnowledgeProviderForTesting } from "./knowledge-provider/registry"`
- 所有内部调用 `getKnowledgeProvider()` 不变，只是来源变了

- [ ] **Step 2: 更新 `knowledge-upload.ts`**

- 删除本地的 `let knowledgeProvider` 和 `getKnowledgeProvider()`（lines 25-32）
- 删除 `setKnowledgeUploadProviderForTesting()`（lines 34-36）
- 改为 `import { getKnowledgeProvider, setKnowledgeProviderForTesting as setKnowledgeUploadProviderForTesting } from "./knowledge-provider/registry"`

注意：`setKnowledgeUploadProviderForTesting` 保持导出名不变，避免测试文件修改。

- [ ] **Step 3: 更新 `knowledge-runtime.ts`**

- 删除本地的 `let knowledgeRuntimeProvider` 和 `getKnowledgeRuntimeProvider()`（lines 20-27）
- 删除 `setKnowledgeRuntimeProviderForTesting()`（lines 29-31）
- 改为 `import { getKnowledgeProvider as getKnowledgeRuntimeProvider, setKnowledgeProviderForTesting as setKnowledgeRuntimeProviderForTesting } from "./knowledge-provider/registry"`

- [ ] **Step 4: 运行 typecheck + 测试**

Run: `bunx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/services/knowledge-base.ts src/services/knowledge-upload.ts src/services/knowledge-runtime.ts
git commit -m "refactor: 统一 knowledge provider 单例到 registry，消除三处独立初始化"
```
