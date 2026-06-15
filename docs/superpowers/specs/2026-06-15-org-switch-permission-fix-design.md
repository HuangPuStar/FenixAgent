# Org 切换 Agent 面板与权限修复 — 设计文档

> 状态：**已确认** | 日期：2026-06-15 | 作者：Claude Code + deepseek-v4-pro

## 1. 背景

通过系统化调试 + 三方多角度并行审查，识别出 Org（组织）切换时存在 10 个问题，按风险等级分为三级。

**核心问题域**：`switchOrg()` 乐观更新时序 → localStorage 与 cookie 可能分叉 → REST API（header）与 WebSocket relay（cookie）从不同源读取 org → 三方状态分裂（前端 UI、REST、WebSocket 各用不同 org）。

本次修复范围：**P0 + P1（4 个修复）**，覆盖所有 HIGH 及以上风险。

## 2. 范围

### 2.1 包含

| # | 修复 | 文件 | 风险 | 改动量 |
|---|------|------|------|--------|
| 1 | `switchOrg` 乐观+回滚 | `web/src/contexts/OrgContext.tsx` | CRITICAL | ~15 行 |
| 2 | relay URL 追加 `activeOrganizationId` | `web/src/acp/relay-client.ts` | HIGH | ~8 行 |
| 3 | API Key 成员资格验证 | `src/plugins/auth.ts` | HIGH | ~10 行 |
| 4 | fallback 路径增加日志 | `src/services/org-context.ts` | MEDIUM | ~3 行 |

### 2.2 不包含

- P2 缓存 `!activeOrgId` 兜底移除（依赖问题 3/4 生效后再评估）
- P2 `store.authContext!` null-safe 加固（涉及 70+ 处调用点，单独 PR）
- 后端 org 缓存 key 改造（`user.id` → `user.id:orgId`，需评估 Redis key 迁移）

## 3. 设计

### 3.1 Fix 1：`switchOrg` 乐观+回滚

**当前代码**（`web/src/contexts/OrgContext.tsx:82-96`）：

```typescript
const switchOrg = useCallback(async (orgId: string) => {
  const target = orgs.find((o) => o.id === orgId);
  if (target) { setOrg(target); setRole(target.role ?? ""); }
  localStorage.setItem(STORAGE_KEY, orgId);
  await orgApi.setActive(orgId);           // 返回值未检查
  void navigate({ to: "/agent/home", replace: true });
}, [navigate, orgs]);
```

**问题**：`orgApi.setActive()` 失败时，localStorage 已更新但 cookie 未更新，后续 WebSocket relay 连接走旧 org。

**改造**：保持乐观更新（即时反馈），但在失败时回滚所有副作用。

**变更**：

```typescript
const switchOrg = useCallback(async (orgId: string) => {
  const oldOrgId = org?.id;
  const oldRole = role;
  const storedOrgId = localStorage.getItem(STORAGE_KEY);

  // 乐观更新 UI 和 localStorage
  const target = orgs.find((o) => o.id === orgId);
  if (target) { setOrg(target); setRole(target.role ?? ""); }
  localStorage.setItem(STORAGE_KEY, orgId);

  try {
    const { error } = await orgApi.setActive(orgId);
    if (error) throw new Error(error.message);
    // 成功 → 导航到首页，触发组件重建和数据重载
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
    const oldTarget = orgs.find((o) => o.id === oldOrgId);
    if (oldTarget) {
      setOrg(oldTarget);
      setRole(oldTarget.role ?? "");
    }
    // 用户提示
    toast.error(t("orgSwitchFailed", { message: (err as Error).message }));
  }
}, [navigate, orgs, org, role, t]);
```

**新增依赖**：`org`、`role` 加入 `useCallback` 依赖数组；`t` 来自 `useTranslation()`。

**需要新增 i18n key**：
- 命名空间：`NS.COMPONENTS`（`web/src/i18n/locales/{en,zh}/components.json`）
- Key：`orgSwitchFailed`
- en：`"Failed to switch organization: {{message}}"`
- zh：`"切换组织失败：{{message}}"`
- 需要在 `switchOrg` 中通过 `useTranslation(NS.COMPONENTS)` 获取 `t` 函数
- **验证项**：OrgProvider 是否在 I18nextProvider 子树内（通过 `__root.tsx` 的组件树确认）

**设计决策**：
- 选乐观+回滚（B 方案）而非悲观（A 方案），因为保持切换即时感对 UX 重要，且 Fix 2 从根本上消除 cookie 分叉影响面
- 回滚时用 `localStorage.removeItem` 处理 `storedOrgId` 为 null 的边界（首次使用时无存储值）

### 3.2 Fix 2：Relay URL 追加 `activeOrganizationId`

**当前代码**（`web/src/acp/relay-client.ts:8-15`）：

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

**问题**：WebSocket 原生 API 无法设自定义 header，fetch 拦截器的 `X-Active-Org-Id` 对 WS 不生效。后端 `extractActiveOrgId` 按 header > query > cookie 优先级读取，当前 WS 升级请求只能走 cookie 回退。

**改造**：在 URL query 参数中追加 `activeOrganizationId`，与 SSE 实现一致（`web/src/api/sse.ts:10-12`）。

**变更**：

```typescript
export function buildRelayUrl(agentId: string, sessionId?: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${protocol}//${window.location.host}/acp/relay/${agentId}`;
  const params = new URLSearchParams();
  const activeOrgId = localStorage.getItem("active_org_id");
  if (activeOrgId) params.set("activeOrganizationId", activeOrgId);
  if (sessionId) params.set("sessionId", sessionId);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}
```

**设计决策**：
- 在 `buildRelayUrl` 内部直接读 `localStorage`（A 方案），不改调用方签名。SSE 已有此先例
- 使用 `URLSearchParams` 确保正确编码，避免手动拼接

**后端兼容性**：`src/schemas/acp.schema.ts` 的 `AcpRelayQuerySchema` 已定义 `sessionId`，需新增 `activeOrganizationId` 作为可选字段。但 `extractActiveOrgId` 已支持从 `url.searchParams.get("activeOrganizationId")` 读取，后端无需额外改动（`src/services/org-context.ts:29-30`）。

### 3.3 Fix 3：API Key 成员资格验证

**当前代码**（`src/plugins/auth.ts:104-130`）：

```typescript
const result: any = await auth.api.verifyApiKey({ body: { key: token } });
// ...
if (result.valid && result.key) {
  const apiKeyMeta = result.key as any;
  const userId = apiKeyMeta.referenceId;
  const user = await lookupUserById(userId);
  if (user) {
    store.user = user;
    const orgId = apiKeyMeta.organizationId || apiKeyMeta.metadata?.organizationId;
    if (orgId) {
      store.authContext = { organizationId: orgId, userId: user.id, role: ... };
      return true;
    }
  }
}
```

**问题**：`tryApiKeyAuth` 只验证 API Key 有效性，不验证用户**仍属于** `metadata.organizationId` 指定的组织。用户被移出组织后，API Key 仍可访问该组织资源。对比 session cookie 路径的 `loadOrgContext` 每次都调 `listMembers` 验证成员关系。

**改造**：在构建 `authContext` 前，通过 better-auth `listMembers` 验证用户仍属于 `orgId`。

**变更**（在 `auth.ts:120` 的 `if (orgId)` 块内插入）：

```typescript
if (orgId) {
  // 验证 API Key 持有者仍属于该组织（与 session cookie 路径一致）
  try {
    const memberRes: any = await auth.api.listMembers({
      query: { organizationId: orgId },
    });
    const memberList: any[] = Array.isArray(memberRes)
      ? memberRes
      : (memberRes?.members ?? []);
    const isMember = memberList.some((m: any) => m.userId === user.id);
    if (!isMember) {
      // 用户已不在该组织中，拒绝 API Key
      return false;
    }
  } catch {
    // listMembers 调用失败（网络/DB 异常）→ 保守拒绝
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

**设计决策**：
- `listMembers` 调用失败时**保守拒绝**（return false），避免 DB 故障时绕过成员校验
- `apiKeyMeta.metadata?.role` 缺失时兜底为 `"member"`（最低权限），而非 `"owner"`
- 不修改 `loadOrgContext` 的 session 路径（该路径已有成员校验）

**性能影响**：每次 API Key 请求增加一次 `listMembers` 查询。可接受——API Key 请求频率远低于 session 请求，且 `listMembers` 是 better-auth 内置索引查询。

### 3.4 Fix 4：Fallback 路径日志

**当前代码**（`src/services/org-context.ts:90-113`）：

```typescript
// fallback: 列出用户的组织，取第一个
const orgs = await api.listOrganizations({ headers: request.headers });
if (orgList.length > 0) {
  const org = orgList[0];
  // ... 构建 AuthContext，无日志
}
```

**问题**：当用户请求的 `activeOrgId` 不是其成员时，静默 fallback 到第一个 org。调用方无法区分"请求的 org"和"回退的 org"，可能导致无感知地操作错误 org 的数据。

**改造**：在 fallback 路径入口增加 `log.warn`，记录请求 org 与实际回退 org 的差异。

**变更**：

```typescript
// 在 org-context.ts:88（me 找不到后的位置）插入：
if (activeOrgId && !me) {
  log.warn("active org not found in members, falling back to first org", {
    requestedOrgId: activeOrgId,
    userId: user.id,
  });
}

// fallback: 列出用户的组织，取第一个
const orgs = await api.listOrganizations({ headers: request.headers });
if (orgList.length > 0) {
  const org = orgList[0];
  log.warn("org context fallback to first org", {
    fallbackOrgId: org.id,
    fallbackOrgName: org.name,
    userId: user.id,
  });
  // ... 构建 AuthContext ...
}
```

**设计决策**：
- 使用 `log.warn` 而非 `log.error`——这不一定是异常，可能是合法场景（新用户首次访问时无 history）
- 记录 `requestedOrgId` 和 `fallbackOrgId` 的差异，便于排查
- 不改变 fallback 行为本身——只在日志层增加可观测性

### 3.5 不修复但已识别的风险（记录备忘）

| 问题 | 文件 | 风险 | 后续计划 |
|------|------|------|---------|
| `loadOrgContext` 缓存 `!activeOrgId` 兜底 | `org-context.ts:47` | MEDIUM | Fix 3/4 生效后重新评估必要性 |
| `store.authContext!` 70+ 处 null-safe 加固 | 多个路由文件 | MEDIUM | 单独 PR，需逐路由审查 |
| 缓存 key 不含 org 维度 | `org-context.ts:46` | LOW | 需评估 Redis key 迁移影响 |
| `getOwnedEnvironment` 返回 404 而非 403 | `environment-core.ts:72` | LOW | 设计决策，暂不改 |

## 4. 组件/模块影响

| 文件 | 变更类型 | 影响 |
|------|---------|------|
| `web/src/contexts/OrgContext.tsx` | 修改 `switchOrg` | 增加 try-catch + 回滚逻辑；新增 `org`/`role`/`t` 依赖 |
| `web/src/acp/relay-client.ts` | 修改 `buildRelayUrl` | 追加 `activeOrganizationId` query param |
| `src/plugins/auth.ts` | 修改 `tryApiKeyAuth` | API Key 认证路径增加 `listMembers` 成员校验 |
| `src/services/org-context.ts` | 修改 `loadOrgContext` | fallback 路径增加 `log.warn` |
| `web/src/i18n/locales/zh/agentPanel.json` | 新增 key | `orgSwitchFailed` |
| `web/src/i18n/locales/en/agentPanel.json` | 新增 key | `orgSwitchFailed` |

## 5. 数据流验证

修复后的完整 Org 切换数据流：

```
switchOrg(orgId)
  ├─ ① 快照 oldOrgId / storedOrgId ← 用于回滚
  ├─ ② setOrg(target) → React state 乐观更新
  ├─ ③ localStorage.setItem → fetch 拦截器用新 org
  ├─ ④ orgApi.setActive(orgId) → POST /web/organizations
  │    ├─ 成功 → navigate(/) → 组件重建 ✅
  │    └─ 失败 → 回滚 localStorage + React state + toast ⚠️ ← Fix 1
  │
  └─ 后续请求
      ├─ REST API: fetch 拦截器 → X-Active-Org-Id header ✅
      ├─ SSE: query param activeOrganizationId ✅（已有）
      └─ WS relay: query param activeOrganizationId ✅ ← Fix 2
           ├─ extractActiveOrgId: query → header → cookie
           └─ cookie 不再是唯一来源
```

## 6. 测试策略

### 6.1 手动验证场景

| # | 场景 | 预期 |
|---|------|------|
| 1 | 正常切换 org | agent 列表刷新，WS relay 用新 org |
| 2 | switch 时断网 | toast 提示，"回滚"到旧 org，localStorage 恢复 |
| 3 | switch 时后端 500 | 同上 |
| 4 | API Key 用户被移出 org | API Key 请求返回 401 |
| 5 | API Key 正常使用 | 行为不变，仅增加 `listMembers` 调用 |
| 6 | 浏览器 devtools → WS 帧检查 | relay URL 包含 `activeOrganizationId` |

### 6.2 自动化测试

| 测试文件 | 测试内容 |
|----------|---------|
| `web/src/__tests__/org-switch.test.ts`（新增） | `switchOrg` 成功/失败回滚流程 |
| `src/__tests__/auth-api-key.test.ts`（已有） | 增加 API Key 成员校验测试用例 |
| `src/__tests__/org-context.test.ts`（已有） | 增加 fallback 日志验证 |

## 7. 自审清单

- [x] 无 TBD / TODO 占位
- [x] 四个修复内部一致，无冲突
- [x] 范围聚焦：仅 P0+P1，P2 留待后续
- [x] 无歧义：每个修复有明确的代码位置、变更方式、设计决策
- [x] 性能影响评估：Fix 3 增加单次 `listMembers` 调用，可接受
- [x] 向后兼容：无 API 签名变更，无破坏性改动
- [x] i18n 覆盖：`orgSwitchFailed` 新增中英文翻译（`NS.COMPONENTS` 命名空间）

## 8. 实现前验证清单

以下是代码审查中发现的实现细节，需在编码前确认：

### 8.1 Fix 1 实现细节

- [ ] OrgContext 需新增 `import { toast } from "sonner"` 和 `import { useTranslation } from "react-i18next"`
- [ ] 确认 `OrgProvider` 在 `I18nextProvider` 子树内（检查 `__root.tsx` 组件树）
- [ ] `switchOrg` 的 `useCallback` 依赖数组需加 `org`、`role`、`t`
- [ ] `oldOrgId` / `storedOrgId` 快照必须在 `localStorage.setItem()` **之前**获取
- [ ] i18n key `orgSwitchFailed` 命名风格需与 `components.json` 现有 key 一致

### 8.2 Fix 2 实现细节

- [ ] `buildRelayUrl` 读 `localStorage` 破坏纯函数语义，但与 `sse.ts` 已有模式一致
- [ ] `URLSearchParams` 自动编码，无需手动 `encodeURIComponent`

### 8.3 Fix 3 实现细节

- [ ] better-auth `listMembers` 返回 `{ members, total }` 结构（CLAUDE.md 确认）
- [ ] `auth.api.listMembers` 对于 API Key 路径是否需要 `headers` 参数
- [ ] `listMembers` 失败时保守拒绝（`return false`），防止 DB 故障绕过校验

### 8.4 Fix 4 实现细节

- [ ] `org-context.ts` 当前是否已导入 logger（查找文件中 `import { log }` 或 `import.*logger`）
- [ ] 双日志不冗余：fallback 入口（为何回退）+ 回退结果（回退到哪）

### 8.5 全局验证

- [ ] `bun run precheck` 修复格式/import 排序后通过
- [ ] 前端 `bun run build:web` 无 TS 编译错误
- [ ] `bun test src/__tests__/` 后端全部测试通过
