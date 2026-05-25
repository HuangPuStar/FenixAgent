# V2 Agent 面板组织页面完善 — 成员管理 + orgAction helper

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完善 V2 Agent 面板的组织页面，抽取 `orgAction()` helper 消除重复代码，添加"最后一个组织禁止删除"保护，修复组织列表 role 缺失导致 owner 看不到管理按钮的 bug。

**Architecture:** V2 的 `AgentOrganizationsPage.tsx` 已有完整的组织 CRUD + 成员增删改代码，使用 Eden Treaty 直调。本次重构将 API 调用收敛到 `orgAction()` helper，修复后端 `list` action 的 role 缺失问题，并补充删除保护逻辑。

**Tech Stack:** React, TypeScript, Eden Treaty, react-i18next, shadcn/ui, Drizzle ORM

**Execution Status:** ✅ All tasks completed. Commits: `1c2e587` (Task 1-5) + `d14fba6` (Task 0)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/routes/web/organizations.ts` | Modify | 修复 `list` action 补充 member.role |
| `web/src/api/client.ts` | Modify | 添加 `orgAction()` helper |
| `web/src/pages/agent-panel/pages/AgentOrganizationsPage.tsx` | Modify | 用 `orgAction()` 重构所有 API 调用 + 添加删除保护 |
| `web/src/pages/OrgsPage.tsx` | Modify | 同步使用 `orgAction()` 重构（保持两页一致） |
| `web/src/i18n/locales/en/orgs.json` | Modify | 添加删除保护相关 i18n key |
| `web/src/i18n/locales/zh/orgs.json` | Modify | 同步添加中文翻译 |

---

### Task 0: 修复组织列表 role 缺失 bug [CRITICAL]

> **发现过程：** 实现完成后用户测试发现 owner 角色看不到管理按钮。排查发现 better-auth 的 `listOrganizations` 内部查了 `member` 表（有 `role` 字段），但返回时 `result.map((member) => member.organization)` 只保留了 organization 对象，把 member 上的 `role` 丢弃了。前端 `canManage`/`isOwner` 永远为 `false`。

**Files:**
- Modify: `src/routes/web/organizations.ts` (import 区 + `list` case)

- [x] **Step 1: 添加 Drizzle ORM import**

在 `src/routes/web/organizations.ts` 顶部添加：

```typescript
import { eq } from "drizzle-orm";
import Elysia from "elysia";
import { auth } from "../../auth/better-auth";
import { db } from "../../db";
import { member } from "../../db/schema";
import { authGuardPlugin } from "../../plugins/auth";
```

- [x] **Step 2: 重写 `list` action，从 member 表补充 role**

将原来的 `list` case：

```typescript
case "list": {
  const orgs = await api.listOrganizations({ headers: request.headers });
  return { success: true, data: Array.isArray(orgs) ? orgs : [] };
}
```

改为：

```typescript
case "list": {
  const orgs = await api.listOrganizations({ headers: request.headers });
  if (!Array.isArray(orgs) || orgs.length === 0) {
    return { success: true, data: [] };
  }
  // better-auth listOrganizations 丢弃了 member.role，需要从 member 表补回
  const userId = store.user?.id;
  const memberships = await db
    .select({ organizationId: member.organizationId, role: member.role })
    .from(member)
    .where(eq(member.userId, userId))
    .execute();
  const roleMap = new Map(memberships.map((m) => [m.organizationId, m.role]));
  const enriched = orgs.map((o: Record<string, unknown>) => ({
    ...o,
    role: roleMap.get(o.id as string) ?? "member",
  }));
  return { success: true, data: enriched };
}
```

**根因分析：** better-auth `adapter.mjs:345-356` 的 `listOrganizations` 实现：

```javascript
listOrganizations: async (userId) => {
  const result = await adapter.findMany({
    model: "member",
    where: [{ field: "userId", value: userId }],
    join: { organization: true }
  });
  return result.map((member) => filterOutputFields(member.organization, orgAdditionalFields));
  //                                    ^^^^^^^^^^^^^^^^^^^^ 只返回 organization，丢弃了 member.role
}
```

- [x] **Step 3: 验证 precheck 通过**

Run: `bun run precheck`
Expected: 全部通过

- [x] **Step 4: 提交**

Commit: `d14fba6 fix: 组织列表 list action 补充 member.role 字段`

---

### Task 1: 添加 `orgAction()` helper

**Files:**
- Modify: `web/src/api/client.ts:96` (文件末尾追加)

- [x] **Step 1: 在 `client.ts` 末尾添加 `orgAction` 函数**

在 `web/src/api/client.ts` 文件末尾（`setUuid` 函数之后）追加：

```typescript
// --- 组织 API helper ---

type OrgActionBody = Record<string, unknown>;

/**
 * 组织管理 API 统一调用入口。
 * 封装 Eden Treaty 调用 + unwrapEden 解包，消除各页面重复的 try/catch + unwrap 模式。
 */
export async function orgAction<T = unknown>(action: string, params?: OrgActionBody): Promise<T> {
  const res = await client.web.organizations.post({ action, ...params });
  return unwrapEden<T>(res);
}
```

- [x] **Step 2: 验证类型检查通过**

Run: `bun run typecheck:web`
Expected: 无新增 error

---

### Task 2: 添加 i18n key

**Files:**
- Modify: `web/src/i18n/locales/en/orgs.json`
- Modify: `web/src/i18n/locales/zh/orgs.json`

- [x] **Step 1: 在英文翻译文件 `dangerZone` 对象中添加 `cannotDeleteLast` key**

在 `web/src/i18n/locales/en/orgs.json` 的 `dangerZone` 节点中，在 `"deleteOrg"` 之后追加：

```json
"cannotDeleteLast": "You cannot delete the last organization. Please create a new one first."
```

- [x] **Step 2: 在中文翻译文件 `dangerZone` 对象中添加 `cannotDeleteLast` key**

在 `web/src/i18n/locales/zh/orgs.json` 的 `dangerZone` 节点中，在 `"deleteOrg"` 之后追加：

```json
"cannotDeleteLast": "无法删除最后一个组织，请先创建一个新组织。"
```

---

### Task 3: 重构 V2 AgentOrganizationsPage 使用 `orgAction()` + 添加删除保护

**Files:**
- Modify: `web/src/pages/agent-panel/pages/AgentOrganizationsPage.tsx`

- [x] **Step 1: 修改 import 语句**

```typescript
import { orgAction } from "../../../api/client";
```

- [x] **Step 2: 重构 `loadMyOrgs` 函数**

```typescript
const loadMyOrgs = useCallback(async () => {
  try {
    const list = await orgAction<{ id: string; name: string; slug: string; role: string }[]>("list");
    setMyOrgs(list);
  } catch (err) {
    console.error(err);
  }
}, []);
```

- [x] **Step 3: 重构加载详情的 useEffect**

```typescript
useEffect(() => {
  if (!selectedOrgId) {
    setDetail(null);
    return;
  }
  setLoading(true);
  orgAction<OrgDetail>("get", { organizationId: selectedOrgId })
    .then((d) => setDetail(d))
    .catch((err) => {
      console.error(err);
      toast.error(t("toast.loadDetailFailed"));
    })
    .finally(() => setLoading(false));
}, [selectedOrgId, t]);
```

- [x] **Step 4: 重构 `handleCreate` 函数**

```typescript
const handleCreate = async () => {
  if (!formName.trim()) return;
  setFormSaving(true);
  try {
    const result = await orgAction<{ id: string }>("create", {
      name: formName.trim(),
      slug: formSlug || nameToSlug(formName),
      description: formDesc.trim() || undefined,
    });
    toast.success(t("toast.createSuccess"));
    setCreateOpen(false);
    setFormName("");
    setFormSlug("");
    setFormDesc("");
    await loadMyOrgs();
    await refreshOrgs();
    setSelectedOrgId(result.id);
  } catch (err) {
    console.error(err);
    toast.error(t("toast.createFailed"));
  } finally {
    setFormSaving(false);
  }
};
```

- [x] **Step 5: 重构 `handleSaveEdit` 函数**

```typescript
const handleSaveEdit = async () => {
  if (!selectedOrgId || !editName.trim()) return;
  setEditSaving(true);
  try {
    await orgAction("update", {
      organizationId: selectedOrgId,
      data: { name: editName.trim() },
    });
    toast.success(t("toast.updateSuccess"));
    setEditingName(false);
    setDetail((d) => (d ? { ...d, name: editName.trim() } : d));
    await loadMyOrgs();
    await refreshOrgs();
  } catch (err) {
    console.error(err);
    toast.error(t("toast.updateFailed"));
  } finally {
    setEditSaving(false);
  }
};
```

- [x] **Step 6: 重构 `handleAddMember` 函数**

```typescript
const handleAddMember = async () => {
  if (!selectedOrgId || !addMemberEmail.trim()) return;
  setAddMemberSaving(true);
  try {
    await orgAction("add-member", {
      organizationId: selectedOrgId,
      email: addMemberEmail.trim(),
      role: addMemberRole,
    });
    toast.success(t("toast.inviteSent"));
    setAddMemberOpen(false);
    setAddMemberEmail("");
    const d = await orgAction<OrgDetail>("get", { organizationId: selectedOrgId });
    setDetail(d);
  } catch (err) {
    console.error(err);
    toast.error(t("toast.inviteFailed"));
  } finally {
    setAddMemberSaving(false);
  }
};
```

- [x] **Step 7: 重构 `handleRemoveMember` 函数**

```typescript
const handleRemoveMember = async (userId: string) => {
  if (!selectedOrgId) return;
  try {
    await orgAction("remove-member", {
      organizationId: selectedOrgId,
      userId,
    });
    toast.success(t("toast.removeSuccess"));
    const d = await orgAction<OrgDetail>("get", { organizationId: selectedOrgId });
    setDetail(d);
  } catch (err) {
    console.error(err);
    toast.error(t("toast.removeFailed"));
  }
};
```

- [x] **Step 8: 重构 `handleUpdateRole` 函数**

```typescript
const handleUpdateRole = async (userId: string, newRole: string) => {
  if (!selectedOrgId) return;
  try {
    await orgAction("update-role", {
      organizationId: selectedOrgId,
      userId,
      role: newRole,
    });
    toast.success(t("toast.roleUpdated"));
    const d = await orgAction<OrgDetail>("get", { organizationId: selectedOrgId });
    setDetail(d);
  } catch (err) {
    console.error(err);
    toast.error(t("toast.roleUpdateFailed"));
  }
};
```

- [x] **Step 9: 重构 `handleDeleteOrg` 函数，添加自动切换逻辑**

```typescript
const handleDeleteOrg = async () => {
  if (!selectedOrgId) return;
  setDeleteSaving(true);
  try {
    await orgAction("delete", { organizationId: selectedOrgId });
    toast.success(t("toast.deleteSuccess"));
    setDeleteOpen(false);
    setDetail(null);
    await loadMyOrgs();
    // 删除后自动切换到列表中第一个剩余组织
    setSelectedOrgId(null);
    await refreshOrgs();
  } catch (err) {
    console.error(err);
    toast.error(t("toast.deleteFailed"));
  } finally {
    setDeleteSaving(false);
  }
};
```

- [x] **Step 10: 添加"最后一个组织禁止删除"的 UI 保护**

```tsx
{isOwner && (
  <div className="pt-4 border-t border-border-subtle">
    <h3 className="text-sm font-semibold text-destructive mb-2">{t("dangerZone.title")}</h3>
    <p className="text-sm text-text-dim mb-3">{t("dangerZone.description")}</p>
    <Button
      variant="destructive"
      size="sm"
      onClick={() => setDeleteOpen(true)}
      disabled={myOrgs.length <= 1}
    >
      <Trash2 className="w-3.5 h-3.5 mr-1.5" />
      {t("dangerZone.deleteOrg")}
    </Button>
    {myOrgs.length <= 1 && (
      <p className="text-xs text-text-dim mt-2">{t("dangerZone.cannotDeleteLast")}</p>
    )}
  </div>
)}
```

---

### Task 4: 同步重构 V1 OrgsPage 使用 `orgAction()`

**Files:**
- Modify: `web/src/pages/OrgsPage.tsx`

- [x] **Step 1: 修改 import 语句**

```typescript
import { orgAction } from "../api/client";
```

- [x] **Step 2-8: 与 Task 3 相同的重构模式**

`loadMyOrgs`、加载详情 useEffect、`handleCreate`、`handleSaveEdit`、`handleAddMember`、`handleRemoveMember`、`handleUpdateRole` — 全部从 `client.web.organizations.post` + `unwrapEden` 替换为 `orgAction()`。代码与 Task 3 对应步骤完全一致，仅 import 路径不同（`../api/client` 而非 `../../../api/client`）。

- [x] **Step 9: 重构 `handleDeleteOrg` + 添加删除保护**

与 Task 3 Step 9/10 相同的改动：`handleDeleteOrg` 使用 `orgAction("delete", ...)` + 调整 setState 顺序；JSX Danger Zone 添加 `disabled={myOrgs.length <= 1}` 和提示文案。

---

### Task 5: 验证 + 提交

- [x] **Step 1: 运行 precheck**

Run: `bun run precheck`
Expected: 全部通过

- [x] **Step 2: 提交**

Commit: `1c2e587 refactor: 抽取 orgAction helper 并添加最后一个组织删除保护`

---

## Execution Notes

### 执行中发现的额外问题及修复

| 问题 | 根因 | 修复 | Commit |
|------|------|------|--------|
| Owner 看不到邀请/编辑/删除按钮 | better-auth `listOrganizations` 丢弃 `member.role`，前端 `canManage` 永远 false | 后端 `list` action 用 Drizzle 查 member 表补 role | `d14fba6` |
| precheck 反复因格式/import 排序报错 | 旧 precheck 只检查不修复，需手动跑 `format` 再重跑 | precheck 改为先 `format --write` + `check --write --linter-enabled=false` 再严格检查 | `fa79d0f` |
| `biome check --write` 误删 `client.ts` 类型断言 | `--write` 自动移除"无效"的 `biome-ignore` 注释，连带删掉 `as typeof _client & { web: any }` | precheck 的 `--write` 仅用于格式和 import 排序，不触碰 linter | `fa79d0f` |

### CLAUDE.md 更新

将上述教训写入 CLAUDE.md（Commit `c4a32eb`）：
- precheck 工作流说明（先自动修再检查）
- biome-ignore 使用规范（禁止 `--write` 误删 suppression）
- TypeScript 类型编程技巧（Eden Treaty 类型降级、API helper 抽取模式）

---

## Self-Review

### 1. Spec Coverage

| 需求 | 对应 Task |
|------|-----------|
| 完整组织 CRUD + 成员管理 | Task 3（V2 已有代码，重构不影响功能） |
| orgAction helper | Task 1 |
| 删除最后一个组织保护 | Task 2 + Task 3 Step 10 + Task 4 Step 9 |
| 删除后自动切换 | Task 3 Step 9 + Task 4 Step 9（selectedOrgId=null + refreshOrgs 触发 auto-select） |
| 两页面保持一致 | Task 3 + Task 4 |
| i18n 双语 | Task 2 |
| **owner 看不到管理按钮** | **Task 0（执行中发现，原计划未覆盖）** |

### 2. Placeholder Scan

无 TBD/TODO/placeholder，所有步骤含完整代码。

### 3. Type Consistency

- `orgAction<T>` 返回 `Promise<T>`，所有调用点使用一致泛型：`OrgDetail`、`{ id: string; name: string; slug: string; role: string }[]`、`{ id: string }`
- `OrgMember` / `OrgDetail` 接口在两个页面各自定义，结构一致
- i18n key `dangerZone.cannotDeleteLast` 在 en/zh 两文件中都有定义
