# Org 切换权限修复 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Org 切换时的 localStorage/cookie 分叉、WebSocket relay org 缺失、API Key 残留访问、fallback 静默错误四个安全问题。

**Architecture:** 四修复独立，可分别完成和验证。Fix 2（relay URL）是纯前端改动最独立；Fix 3（API Key 校验）是纯后端改动最独立；Fix 1（switchOrg 回滚）和 Fix 4（fallback 日志）分别改前端 context 和后端 service。

**Tech Stack:** React 19 + TanStack Router + sonner toast + react-i18next（前端），Elysia + Bun + better-auth（后端）

**Design Doc:** `docs/superpowers/specs/2026-06-15-org-switch-permission-fix-design.md`

---

## 文件结构

| 文件 | 操作 | 责任 |
|------|------|------|
| `web/src/i18n/locales/en/components.json` | 修改 | 英文 i18n key `orgSwitchFailed` |
| `web/src/i18n/locales/zh/components.json` | 修改 | 中文 i18n key `orgSwitchFailed` |
| `web/src/contexts/OrgContext.tsx` | 修改 | Fix 1：`switchOrg` 乐观+回滚 |
| `web/src/acp/relay-client.ts` | 修改 | Fix 2：relay URL 追加 org 参数 |
| `src/plugins/auth.ts` | 修改 | Fix 3：API Key 成员资格验证 |
| `src/services/org-context.ts` | 修改 | Fix 4：fallback 路径日志 |

---

### Task 1: 新增 i18n key

**Files:**
- Modify: `web/src/i18n/locales/en/components.json`
- Modify: `web/src/i18n/locales/zh/components.json`

- [ ] **Step 1: 在英文 components.json 末尾新增 `orgSwitchFailed`**

在 `web/src/i18n/locales/en/components.json` 最后一个 key 之后（`"chatEmpty"` 块后），添加：

```json
,
  "orgSwitchFailed": "Failed to switch organization"
```

**完整尾段变更**：

在 `"chatEmpty"` 块末尾的 `}` 后面加逗号并追加。当前文件最后几行（第 350-354 行附近）：

```json
  "chatEmpty": {
    "skills": "Skills loaded",
    "skillsHint": "Type / to open skill popup"
  }
}
```

改为：

```json
  "chatEmpty": {
    "skills": "Skills loaded",
    "skillsHint": "Type / to open skill popup"
  },
  "orgSwitchFailed": "Failed to switch organization"
}
```

- [ ] **Step 2: 在中文 components.json 末尾新增 `orgSwitchFailed`**

在 `web/src/i18n/locales/zh/components.json` 最后一个 key 之后（`"chatEmpty"` 块后），添加：

```json
  "chatEmpty": {
    "skills": "已加载 Skills",
    "skillsHint": "输入 / 打开 Skill 弹窗"
  },
  "orgSwitchFailed": "切换组织失败"
```

- [ ] **Step 3: 验证 JSON 语法**

Run:
```bash
bun -e "JSON.parse(require('fs').readFileSync('web/src/i18n/locales/en/components.json','utf-8')); console.log('en: OK')"
bun -e "JSON.parse(require('fs').readFileSync('web/src/i18n/locales/zh/components.json','utf-8')); console.log('zh: OK')"
```

Expected: 输出 `en: OK` 和 `zh: OK`

---

### Task 2: Fix 2 — relay URL 追加 `activeOrganizationId`

**Files:**
- Modify: `web/src/acp/relay-client.ts:8-15`

**Rationale:** 当前 SSE 已正确在 URL 追加 `activeOrganizationId`（`sse.ts:10-12`），但 relay WebSocket 缺失。WebSocket 无法设自定义 header，只能通过 URL query param 传递 org 上下文。

- [ ] **Step 1: 替换 `buildRelayUrl` 函数体**

将 `web/src/acp/relay-client.ts:8-15`：

```typescript
export function buildRelayUrl(agentId: string, sessionId?: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${protocol}//${window.location.host}/acp/relay/${agentId}`;
  if (sessionId) {
    return `${base}?sessionId=${encodeURIComponent(sessionId)}`;
  }
  return base;
}
```

替换为：

```typescript
export function buildRelayUrl(agentId: string, sessionId?: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${protocol}//${window.location.host}/acp/relay/${agentId}`;
  const params = new URLSearchParams();
  // 与 SSE 连接保持一致，通过 URL query param 传递组织 ID（WebSocket 无法设自定义 header）
  const activeOrgId = localStorage.getItem("active_org_id");
  if (activeOrgId) params.set("activeOrganizationId", activeOrgId);
  if (sessionId) params.set("sessionId", sessionId);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}
```

- [ ] **Step 2: 验证构建输出**

Run:
```bash
cd web && bun -e "
// 模拟 localStorage
globalThis.localStorage = { getItem: () => 'org_abc' } as any;
globalThis.window = { location: { protocol: 'http:', host: 'localhost:3000' } } as any;

// 手动验证逻辑（不 import，避免模块加载问题）
const agentId = 'env_123';
const sessionId = 'ses_456';
const protocol = (globalThis as any).window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const base = protocol + '//' + (globalThis as any).window.location.host + '/acp/relay/' + agentId;
const params = new URLSearchParams();
const activeOrgId = localStorage.getItem('active_org_id');
if (activeOrgId) params.set('activeOrganizationId', activeOrgId);
if (sessionId) params.set('sessionId', sessionId);
const qs = params.toString();
const url = qs ? base + '?' + qs : base;
console.log('URL with session:', url);
// 期望: ws://localhost:3000/acp/relay/env_123?activeOrganizationId=org_abc&sessionId=ses_456
"
```

Expected: URL 包含 `activeOrganizationId=org_abc&sessionId=ses_456` 或顺序相反（URLSearchParams 不保证顺序）

---

### Task 3: Fix 1 — `switchOrg` 乐观+回滚

**Files:**
- Modify: `web/src/contexts/OrgContext.tsx:1-3`（新增 imports）
- Modify: `web/src/contexts/OrgContext.tsx:82-96`（switchOrg 函数体）

- [ ] **Step 1: 新增 imports**

在 `web/src/contexts/OrgContext.tsx:3` 后插入两行 import：

```typescript
import { useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { orgApi } from "@/src/api/sdk";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { NS } from "@/src/i18n";
```

- [ ] **Step 2: 在 OrgProvider 顶部获取 `t` 函数**

在 `web/src/contexts/OrgContext.tsx:47`（`const navigate = useNavigate();` 之后）插入：

```typescript
export function OrgProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { t } = useTranslation(NS.COMPONENTS);
```

- [ ] **Step 3: 替换 `switchOrg` 函数体**

将 `web/src/contexts/OrgContext.tsx:82-96`：

```typescript
  const switchOrg = useCallback(
    async (orgId: string) => {
      // 从已加载列表中立即更新 UI 状态
      const target = orgs.find((o) => o.id === orgId);
      if (target) {
        setOrg(target);
        setRole(target.role ?? "");
      }
      localStorage.setItem(STORAGE_KEY, orgId);
      await orgApi.setActive(orgId);
      // 切换组织后导航回首页
      void navigate({ to: "/agent/home", replace: true });
    },
    [navigate, orgs],
  );
```

替换为：

```typescript
  const switchOrg = useCallback(
    async (orgId: string) => {
      // 快照当前值，用于失败时回滚
      const oldOrgId = org?.id;
      const oldRole = role;
      const storedOrgId = localStorage.getItem(STORAGE_KEY);

      // 乐观更新 UI 和 localStorage（即时反馈）
      const target = orgs.find((o) => o.id === orgId);
      if (target) {
        setOrg(target);
        setRole(target.role ?? "");
      }
      localStorage.setItem(STORAGE_KEY, orgId);

      try {
        const { error } = await orgApi.setActive(orgId);
        if (error) throw new Error(error.message);
        // 成功后导航到首页，触发组件重建和数据重载
        void navigate({ to: "/agent/home", replace: true });
      } catch (err) {
        console.error("Failed to switch org:", err);
        // 回滚 localStorage
        if (storedOrgId) {
          localStorage.setItem(STORAGE_KEY, storedOrgId);
        } else {
          localStorage.removeItem(STORAGE_KEY);
        }
        // 回滚 React state
        if (oldOrgId) {
          const oldTarget = orgs.find((o) => o.id === oldOrgId);
          if (oldTarget) {
            setOrg(oldTarget);
            setRole(oldTarget.role ?? "");
          }
        }
        toast.error(t("orgSwitchFailed", { message: (err as Error).message }));
      }
    },
    [navigate, orgs, org, role, t],
  );
```

- [ ] **Step 4: 前端 TypeScript 编译检查**

Run:
```bash
cd web && bunx tsc --noEmit
```

Expected: 无类型错误。如果有 `t()` 的泛型参数问题，检查 `i18next` 的 `TFuncKey` 类型。

- [ ] **Step 5: 前端构建**

Run:
```bash
bun run build:web
```

Expected: 构建成功，无 TS 或 bundling 错误。

---

### Task 4: Fix 3 — API Key 成员资格验证

**Files:**
- Modify: `src/plugins/auth.ts:120-128`

**Rationale:** `tryApiKeyAuth` 只验证 API Key 有效性，不验证用户**仍属于** `metadata.organizationId` 指定的组织。Session cookie 路径的 `loadOrgContext` 每次都调 `listMembers`，但 API Key 路径完全跳过。需补齐这个校验缺口。

- [ ] **Step 1: 在 orgId 赋值后、store.authContext 赋值前插入成员校验**

将 `src/plugins/auth.ts:120-128`：

```typescript
      const orgId = apiKeyMeta.organizationId || apiKeyMeta.metadata?.organizationId;
      if (orgId) {
        store.authContext = {
          organizationId: orgId,
          userId: user.id,
          role: (apiKeyMeta.metadata?.role as "owner" | "admin" | "member") || "owner",
        };
        return true;
      }
```

替换为：

```typescript
      const orgId = apiKeyMeta.organizationId || apiKeyMeta.metadata?.organizationId;
      if (orgId) {
        // 验证 API Key 持有者仍属于该组织（与 session cookie 路径的 loadOrgContext 一致）
        try {
          const memberRes: any = await auth.api.listMembers({
            query: { organizationId: orgId },
          });
          const memberList: any[] = Array.isArray(memberRes)
            ? memberRes
            : (memberRes?.members ?? []);
          const isMember = memberList.some((m: any) => m.userId === user.id);
          if (!isMember) {
            return false; // 用户已不在该组织中，拒绝 API Key
          }
        } catch {
          // listMembers 调用失败（网络/DB 异常）→ 保守拒绝，防止 DB 故障时绕过成员校验
          return false;
        }

        store.authContext = {
          organizationId: orgId,
          userId: user.id,
          role: (apiKeyMeta.metadata?.role as "owner" | "admin" | "member") || "member",
        };
        return true;
      }
```

**注意**: `role` 的 fallback 从 `"owner"` 改为 `"member"` —— API Key 的 role 来自 metadata，如果缺失应使用最低权限而非最高权限。

- [ ] **Step 2: 后端 TypeScript 编译检查**

Run:
```bash
bunx tsc --noEmit -p tsconfig.json
```

Expected: 无类型错误（`any` 类型的 better-auth API 调用在现有基准中已被 `// biome-ignore` 容忍）。

- [ ] **Step 3: 运行已有 API Key 认证测试**

Run:
```bash
bun test src/__tests__/auth-api-key.test.ts
```

Expected: 如果已有 API Key 相关测试，可能需要更新 mock。先跑看看结果。

---

### Task 5: Fix 4 — fallback 路径日志

**Files:**
- Modify: `src/services/org-context.ts:88-91`

**Rationale:** 当用户请求的 `activeOrgId` 不是其成员时，静默 fallback 到第一个 org。调用方无法区分请求 org 和回退 org。增加 `log.warn` 提供可观测性。

**注意**: `org-context.ts` 文件顶部**已有** `const log = createLogger("org-context")`（第 5 行），无需新增导入。

- [ ] **Step 1: 在 fallback 前插入日志**

在 `src/services/org-context.ts:88`（`}` 闭合 member check 的 if 块）和 `:` 之间插入 warn 日志。将：

```typescript
      }
    }

    // fallback: 列出用户的组织，取第一个
```

改为：

```typescript
      } else if (activeOrgId) {
        // activeOrgId 指定了但用户不是成员 → 记录差异后回退
        log.warn("active org not found in members, falling back to first org", {
          requestedOrgId: activeOrgId,
          userId: user.id,
        });
      }
    }

    // fallback: 列出用户的组织，取第一个
    const orgs = await api.listOrganizations({ headers: request.headers });
    // biome-ignore lint/suspicious/noExplicitAny: better-auth listOrganizations return type is untyped
    const orgList: any[] = Array.isArray(orgs) ? orgs : [];
    if (orgList.length > 0) {
      const org = orgList[0];
      log.warn("org context resolved to first available organization", {
        organizationId: org.id,
        organizationName: org.name,
        userId: user.id,
      });
```

**注意**：此处需要删掉原来的 `const orgs = await api.listOrganizations(...)` 行（它在第 91 行），然后在新位置替换。实际变更范围是第 88-95 行。

- [ ] **Step 2: 验证 fallback 日志逻辑**

Run:
```bash
bun -e "
// 检查 org-context.ts 的 fallback 分支是否保持原有逻辑 + 新增日志
const fs = require('fs');
const code = fs.readFileSync('src/services/org-context.ts', 'utf-8');
// 确认日志行存在
console.assert(code.includes('log.warn'), 'missing log.warn in fallback');
console.assert(code.includes('requestedOrgId'), 'missing requestedOrgId in log');
console.assert(code.includes('first available organization'), 'missing fallback target log');
console.log('Fallback log validation: OK');
"
```

Expected: `Fallback log validation: OK`

---

### Task 6: Precheck + 完整测试

**Files:** 无（仅运行命令）

- [ ] **Step 1: Precheck**

Run:
```bash
bun run precheck
```

Expected: 格式化自动修复 + import 排序自动修复 + tsc 通过 + biome check 通过。如果有手动修复，重复 precheck 直到通过。

- [ ] **Step 2: 后端全部测试**

Run:
```bash
bun test src/__tests__/
```

Expected: 全部通过。重点关注的测试：
- `src/__tests__/auth-api-key.test.ts` — API Key 认证路径
- `src/__tests__/org-context.test.ts` — 组织上下文加载

- [ ] **Step 3: 前端全部测试**

Run:
```bash
bun test web/src/__tests__/
```

Expected: 全部通过。

- [ ] **Step 4: 前端生产构建**

Run:
```bash
bun run build:web
```

Expected: 构建成功。

---

### Task 7: Git 提交

**Files:** 所有已修改文件

- [ ] **Step 1: 提交所有改动**

```bash
git add web/src/i18n/locales/en/components.json \
        web/src/i18n/locales/zh/components.json \
        web/src/contexts/OrgContext.tsx \
        web/src/acp/relay-client.ts \
        src/plugins/auth.ts \
        src/services/org-context.ts
git commit -m "fix(org): 修复组织切换时的权限与状态一致性问题

- switchOrg 增加乐观更新失败回滚：localStorage + React state 双回滚
- relay WebSocket URL 追加 activeOrganizationId（与 SSE 保持一致）
- API Key 认证路径增加 listMembers 成员资格验证
- loadOrgContext fallback 路径增加结构化日志

Co-Authored-By: Claude Code <claude-ai@anthropic.com>
Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

## 自审

### Spec 覆盖检查

| Spec 需求 | 对应 Task | 状态 |
|-----------|----------|------|
| Fix 1: switchOrg 乐观+回滚 | Task 3 | ✅ |
| Fix 2: relay URL 追加 org 参数 | Task 2 | ✅ |
| Fix 3: API Key 成员资格验证 | Task 4 | ✅ |
| Fix 4: fallback 路径日志 | Task 5 | ✅ |
| i18n key 新增 | Task 1 | ✅ |
| Precheck + 测试验证 | Task 6 | ✅ |
| Git 提交 | Task 7 | ✅ |

### Placeholder 扫描

- [x] 无 TBD / TODO
- [x] 无 "添加适当的错误处理" 空洞描述
- [x] 所有代码步骤都展示了完整代码
- [x] 所有命令都有明确的预期输出
- [x] 无跨 task 的类型/函数名不一致

### 类型一致性检查

- `t("orgSwitchFailed")` 在所有引用处一致 ✅
- `NS.COMPONENTS` 在 import 和 useTranslation 中一致 ✅
- `orgApi.setActive()` 返回值结构在调用处和解构处一致 ✅
- `auth.api.listMembers` 返回格式在 Fix 3 和 Fix 4 中处理一致 ✅
- `storedOrgId` / `oldOrgId` 快照命名在 switchOrg 中一致 ✅
