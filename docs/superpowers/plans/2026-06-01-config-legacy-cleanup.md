# Config 模块遗留清理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除 `config-pg.ts` barrel re-export 和 `config.ts` 空 stub，将所有 import 直接指向 `config/` 子模块。

**Architecture:** 机械性迁移——将 9 处 `config-pg` import 改为 `config/index`（或直接指向具体子模块），然后删除两个遗留文件。

**Tech Stack:** TypeScript

---

## File Structure

| Action | File | Change |
|--------|------|--------|
| Modify | `src/services/skill.ts` | import 路径 |
| Modify | `src/services/instance.ts` | import 路径 |
| Modify | `src/services/agent-task-runner.ts` | import 路径 |
| Modify | `src/services/environment-web.ts` | import 路径 |
| Modify | `src/services/launch-spec-builder.ts` | import 路径 |
| Modify | `src/routes/web/config/models.ts` | import 路径 |
| Modify | `src/routes/web/config/agents.ts` | import 路径 |
| Modify | `src/routes/web/config/providers.ts` | import 路径 |
| Modify | `src/routes/web/config/mcp.ts` | import 路径 |
| Delete | `src/services/config-pg.ts` | 删除 |
| Delete | `src/services/config.ts` | 删除 |

---

### Task 1: 迁移所有 config-pg import

**Files:**
- 9 files listed above

- [ ] **Step 1: 批量替换 import 路径**

```bash
# Services (相对路径 ./config-pg → ./config/index)
sed -i '' 's|from "./config-pg"|from "./config/index"|g' src/services/skill.ts
sed -i '' 's|from "./config-pg"|from "./config/index"|g' src/services/instance.ts
sed -i '' 's|from "./config-pg"|from "./config/index"|g' src/services/agent-task-runner.ts
sed -i '' 's|from "./config-pg"|from "./config/index"|g' src/services/environment-web.ts
sed -i '' 's|from "./config-pg"|from "./config/index"|g' src/services/launch-spec-builder.ts

# Routes (相对路径 ../../../services/config-pg → ../../../services/config/index)
sed -i '' 's|from "../../../services/config-pg"|from "../../../services/config/index"|g' src/routes/web/config/models.ts
sed -i '' 's|from "../../../services/config-pg"|from "../../../services/config/index"|g' src/routes/web/config/agents.ts
sed -i '' 's|from "../../../services/config-pg"|from "../../../services/config/index"|g' src/routes/web/config/providers.ts
sed -i '' 's|from "../../../services/config-pg"|from "../../../services/config/index"|g' src/routes/web/config/mcp.ts
```

- [ ] **Step 2: 更新 setup-mocks.ts 中的 mock.module 路径**

在 `src/test-utils/setup-mocks.ts` 中，将 `mock.module("../services/config-pg", ...)` 改为 `mock.module("../services/config/index", ...)`。

- [ ] **Step 3: 运行 tsc 验证无类型错误**

Run: `bunx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/services/skill.ts src/services/instance.ts src/services/agent-task-runner.ts src/services/environment-web.ts src/services/launch-spec-builder.ts src/routes/web/config/models.ts src/routes/web/config/agents.ts src/routes/web/config/providers.ts src/routes/web/config/mcp.ts src/test-utils/setup-mocks.ts
git commit -m "refactor(config): 所有 import 从 config-pg 迁移到 config/index"
```

---

### Task 2: 删除遗留文件

**Files:**
- Delete: `src/services/config-pg.ts`
- Delete: `src/services/config.ts`

- [ ] **Step 1: 确认无残留 import**

Run: `grep -r "config-pg" src/ --include="*.ts" -l`
Expected: 无结果（只有已删除的 config-pg.ts 本身可能出现在 git history 中）

Run: `grep -r 'from.*services/config"' src/ --include="*.ts" -l`
Expected: 无结果（config.ts 是空 stub，无人引用）

- [ ] **Step 2: 删除文件**

```bash
rm src/services/config-pg.ts
rm src/services/config.ts
```

- [ ] **Step 3: 运行全部测试**

Run: `bun test src/__tests__/`
Expected: ALL PASS

- [ ] **Step 4: 运行 precheck**

Run: `bun run precheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "chore(config): 删除遗留 config-pg.ts barrel 和 config.ts 空 stub"
```
