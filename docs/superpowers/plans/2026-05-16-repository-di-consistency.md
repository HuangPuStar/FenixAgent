# Repository DI 一致性：消除声明与实际使用的不一致

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统一 Repository 的获取方式。当前 `src/plugins/repositories.ts` 通过 `.decorate()` 注入了 repo 单例，但实际代码全部通过 `import` 直接引用。本计划选择**路径 B**——承认直接 import 模式已足够好，删除 `repositories.ts` 插件的虚假 DI 声明，让代码表里如一。

**Architecture:** 删除 `src/plugins/repositories.ts` 和 `src/index.ts` 中的 `.use(repoPlugin)` 引用。保留 `src/repositories/` 目录和直接 import 模式不变。这是一个"减法"重构——移除不生效的抽象层。

**Tech Stack:** TypeScript, Elysia, Bun test

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/plugins/repositories.ts` | Delete | 移除虚假 DI 声明 |
| `src/index.ts` | Modify | 移除 `.use(repoPlugin)` 引用 |
| `src/repositories/index.ts` | Modify | 确认 resetAllRepos 导出不变 |

---

### Task 1: 确认所有 repo 消费者的导入方式

**Files:**
- None (verification only)

- [ ] **Step 1: 搜索所有直接 import repo 的文件**

Run:
```bash
grep -rn "from.*repositories" src/ --include="*.ts" | grep -v "__tests__" | grep -v "node_modules"
```

Expected: 所有 service 和 route 文件都通过 `import { environmentRepo } from "../repositories"` 直接导入，没有任何文件从 Elysia context 的 `store.environmentRepo` 获取。

- [ ] **Step 2: 搜索所有通过 store 访问 repo 的文件**

Run:
```bash
grep -rn "store\.environmentRepo\|store\.sessionRepo\|store\.sessionWorkerRepo\|store\.shareLinkRepo\|store\.tokenRepo\|store\.workItemRepo" src/ --include="*.ts"
```

Expected: 0 匹配。确认没有代码使用 DI 注入的 repo。

---

### Task 2: 删除 repoPlugin 声明和引用

**Files:**
- Modify: `src/index.ts`
- Delete: `src/plugins/repositories.ts`

- [ ] **Step 1: 从 index.ts 移除 repoPlugin 引用**

读取 `src/index.ts`，找到 `repoPlugin` 的 import 和 `.use(repoPlugin)` 调用并删除。

具体操作：
1. 删除 import 行：`import { repoPlugin } from "./plugins/repositories";`
2. 删除 `.use(repoPlugin)` 调用

- [ ] **Step 2: 删除 repositories.ts 插件文件**

Run:
```bash
rm src/plugins/repositories.ts
```

- [ ] **Step 3: 更新 ADR-0001 状态**

在 `docs/adr/0001-repository-pattern-with-elysia-di.md` 末尾追加：

```markdown

## Amendment (2026-05-16)

DI 注入路径未采用。Repository 通过直接 import 使用（`import { environmentRepo } from "../repositories"`），测试通过 `mock.module()` 替换。`.decorate()` 声明已移除。直接 import 模式在当前项目规模下足够简单，避免了 Elysia DI 的额外复杂度。

Status: amended
```

- [ ] **Step 4: 运行类型检查确认无错误**

Run: `bun run typecheck`
Expected: PASS — 无类型错误

- [ ] **Step 5: 运行全量后端测试确认无回归**

Run: `bun test src/__tests__/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/plugins/repositories.ts docs/adr/0001-repository-pattern-with-elysia-di.md
git commit -m "refactor: 移除未使用的 repoPlugin DI 声明

- 删除 src/plugins/repositories.ts（decorate 声明未实际使用）
- 从 index.ts 移除 .use(repoPlugin) 引用
- 所有 repo 通过直接 import 使用，更新 ADR-0001 记录此决策

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: 验证 repositories/index.ts 导出完整性

**Files:**
- Verify: `src/repositories/index.ts`

- [ ] **Step 1: 确认 index.ts 导出所有 repo 和 resetAllRepos**

读取 `src/repositories/index.ts`，确认它导出了：
- `environmentRepo`
- `sessionRepo`
- `sessionWorkerRepo`
- `shareLinkRepo`
- `tokenRepo`
- `workItemRepo`
- `resetAllRepos`

这些应与删除的 `plugins/repositories.ts` 中 `.decorate()` 列出的 repo 一致。

- [ ] **Step 2: grep 确认无残留引用**

Run:
```bash
grep -rn "repoPlugin\|plugins/repositories" src/ --include="*.ts"
```

Expected: 0 匹配
