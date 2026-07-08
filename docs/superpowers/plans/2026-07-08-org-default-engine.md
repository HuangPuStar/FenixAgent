# 组织默认引擎设置 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 组织 admin 设置默认引擎类型和远程节点，新 Agent 创建时自动预填，用户可覆盖。

**Architecture:** 组织默认值存在 `organization.metadata.defaultEngine` JSONB；Agent 创建后端从 org metadata 读取兜底；前端组织管理页增加设置 UI、Agent 创建表单预填。

**Tech Stack:** Elysia (Bun), React 19 + TypeScript, Drizzle ORM, better-auth, Zod v4

---

## 文件结构

| 文件 | 改动 | 职责 |
|------|------|------|
| `src/routes/web/config/agents.ts` | 修改 | Agent 创建时从 org metadata 读取兜底 engineType/machineId |
| `web/src/api/organizations.ts` | 修改 | 新增 `updateMetadata` 方法，支持透传 metadata 更新 |
| `web/src/pages/agent-panel/pages/AgentOrganizationsPage.tsx` | 修改 | 新增"默认引擎设置"区域（仅 owner 可见） |
| `web/src/pages/agent-panel/AgentFormDialog.tsx` | 修改 | 创建 Agent 时从 org metadata 预填 engineType/machineId |

无新建文件，无 DB 迁移。

---

### Task 1: 后端 — Agent 创建时读取组织默认引擎

**Files:**
- Modify: `src/routes/web/config/agents.ts:365-420`

**背景:** `handleCreate` 函数 (第365行) 处理 Agent 创建，`authCtx` 包含 `organizationId`。只需在 `data` 中未传 `engineType`/`machineId` 时从组织 metadata 兜底读取。

- [ ] **Step 1: 在 `handleCreate` 内添加组织元数据读取**

在 `src/routes/web/config/agents.ts`，找到 `handleCreate` 函数。在 `AGENT_SETTABLE_FIELDS` 白名单过滤前（约第376行），插入组织 metadata 读取逻辑。

```typescript
// 找到 handleCreate 函数签名（第365行附近）
async function handleCreate(ctx: AuthContext, name: string, data: Record<string, unknown>) {
  if (!isValidResourceName(name)) {
    return configValidationError(
      "Invalid agent name: must be 1-64 characters (letters, numbers, spaces, single hyphens)",
    );
  }
  const validation = validateAgentData(data);
  if (validation) return configValidationError(validation);
  const publicReadable = typeof data.publicReadable === "boolean" ? data.publicReadable : undefined;

  // ── 新增：从组织 metadata 读取默认引擎设置 ──
  if (!data.engineType || !data.machineId) {
    try {
      const [org] = await db
        .select({ metadata: organization.metadata })
        .from(organization)
        .where(eq(organization.id, ctx.organizationId))
        .limit(1);
      const defEngine = (org?.metadata as Record<string, unknown> | null)?.defaultEngine as
        | { engineType?: string; machineId?: string }
        | undefined;
      if (defEngine?.engineType && !data.engineType) {
        data.engineType = defEngine.engineType;
      }
      if (defEngine?.machineId !== undefined && !data.machineId) {
        // 空字符串 = 本地执行
        data.machineId = defEngine.machineId || null;
      }
    } catch {
      // 读取失败静默回退，不影响 Agent 创建
    }
  }

  // 白名单过滤（原有逻辑）
  const filtered: Record<string, unknown> = {};
  // ... 后续保持不变
```

**注意:** 需要在文件顶部添加 `organization` 表引用。检查第5行已有 `machine, model, provider, skill` 等 import，需添加 `organization`:

```typescript
// 第5行：在原 import 中添加 organization
import { agentSiteApp, knowledgeBase,
  machine,  // 已有
  model,    // 已有
  organization, // 新增
  provider, // 已有
  skill,    // 已有
} from "../../../db/schema";
```

- [ ] **Step 2: 运行后端构建检查**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck
```

Expected: 无类型错误，lint 通过。

- [ ] **Step 3: Commit**

```bash
git add src/routes/web/config/agents.ts
git commit -m "feat: Agent 创建时从组织默认引擎设置兜底 engineType/machineId"
```

---

### Task 2: 前端 API — 支持组织 metadata 更新

**Files:**
- Modify: `web/src/api/organizations.ts:55,90-95`

**背景:** 现有 `orgApi.update` 只发 `{ name, slug }`。需要新增一个方法传 `{ data: { metadata } }` 以透传到 better-auth。

- [ ] **Step 1: 拓展 `OrgDetail` 类型，添加 metadata**

在 `web/src/api/organizations.ts`，修改 `OrgDetail`:

```typescript
export interface OrgDetail extends OrgInfo {
  members?: OrgMember[];
  /** 与后端 OrganizationDetailSchema 匹配的扩展字段 */
  metadata?: Record<string, unknown> | null;
}
```

- [ ] **Step 2: 新增 `updateMetadata` 方法**

在 `orgApi` 对象末尾追加:

```typescript
  /** 更新组织 metadata（透传给 better-auth 底层） */
  updateMetadata: (orgId: string, data: Record<string, unknown>) =>
    request<OrgInfo>("/web/organizations/:id", {
      method: "PUT",
      params: { id: orgId },
      body: { data },
    }),
```

- [ ] **Step 3: Commit**

```bash
git add web/src/api/organizations.ts
git commit -m "feat: 组织 API 新增 updateMetadata 方法和 metadata 字段"
```

---

### Task 3: 前端 — 组织管理页添加默认引擎设置

**Files:**
- Modify: `web/src/pages/agent-panel/pages/AgentOrganizationsPage.tsx`

**背景:** 页面左右布局，右侧详情区分为"组织信息 → 成员 → 机器列表 → 危险操作"四个区。在成员区之后、机器列表区之前插入"默认引擎设置"卡片。仅 `owner` 可见。

- [ ] **Step 1: 添加 state**

在组件顶部 state 声明区（约第58行 `const { org: currentOrg, refreshOrgs } = useOrg()` 下方）添加:

```typescript
  // 默认引擎设置状态
  const [defaultEngineType, setDefaultEngineType] = useState<string>("");
  const [defaultMachineId, setDefaultMachineId] = useState<string>("local");
  const [engineDirty, setEngineDirty] = useState(false);
  const [savingEngine, setSavingEngine] = useState(false);
```

- [ ] **Step 2: 在 detail 变化时回填默认值**

在 `useRequest` 获取 detail 后（约第88行），在 `refreshDeps: [selectedOrgId]` 后面添加 `onSuccess` 回调。或者使用 `useEffect` 监听 detail 变化。

在组件中找一个合适的位置（约第110行 `const isOwner = selectedOrgRole === "owner"` 之后）添加:

```typescript
  // 当 detail 加载完成后，回填默认引擎设置
  useEffect(() => {
    if (!detail) return;
    const metadata = (detail as Record<string, unknown>).metadata as
      | { defaultEngine?: { engineType?: string; machineId?: string } }
      | null
      | undefined;
    const def = metadata?.defaultEngine;
    setDefaultEngineType(def?.engineType ?? "");
    setDefaultMachineId(def?.machineId || "local");
    setEngineDirty(false);
  }, [detail]);
```

- [ ] **Step 3: 添加保存函数**

在现有 `useRequest` hooks 区域（约第206行 `runDelete` 之后）添加:

```typescript
  // 保存默认引擎设置
  const saveDefaultEngine = useCallback(async () => {
    if (!selectedOrgId || !detail) return;
    setSavingEngine(true);
    try {
      const metadata = {
        ...((detail as Record<string, unknown>).metadata as Record<string, unknown> || {}),
        defaultEngine: {
          engineType: defaultEngineType || undefined,
          machineId: defaultMachineId === "local" ? "" : defaultMachineId,
        },
      };
      await unwrap(orgApi.updateMetadata(selectedOrgId, {
        name: detail.name,
        slug: detail.slug,
        metadata,
      }));
      toast.success(t("toast.updateSuccess"));
      setEngineDirty(false);
      refreshDetail();
    } catch (err) {
      console.error(err);
      toast.error(t("toast.updateFailed"));
    } finally {
      setSavingEngine(false);
    }
  }, [selectedOrgId, detail, defaultEngineType, defaultMachineId, refreshDetail, t]);
```

- [ ] **Step 4: 在界面中插入默认引擎设置卡片**

在 `{/* Members */}` 区块结束后（约第391行 `</div>` 的成员区结束标签）、`{/* Machines */}` 区块开始前（约第393行），插入默认引擎卡片:

```tsx
              {/* 默认引擎设置 — 仅 owner 可见 */}
              {isOwner && (
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-text-primary">{t("defaultEngine")}</h3>
                  <div className="rounded-lg border border-border-light bg-surface-1 px-4 py-3 space-y-3">
                    <div className="flex items-center gap-4">
                      <label className="text-xs text-text-secondary w-20 shrink-0">{t("form.engineType")}</label>
                      <select
                        className="flex-1 rounded-md border border-border-light bg-surface-2 px-3 py-1.5 text-sm text-text-primary"
                        value={defaultEngineType}
                        onChange={(e) => {
                          setDefaultEngineType(e.target.value);
                          setEngineDirty(true);
                        }}
                      >
                        <option value="">{t("form.engineTypePlaceholder")}</option>
                        <option value="opencode">OpenCode</option>
                        <option value="ccb">CCB</option>
                        <option value="claude-code">Claude Code</option>
                      </select>
                    </div>
                    <div className="flex items-center gap-4">
                      <label className="text-xs text-text-secondary w-20 shrink-0">{t("form.machine")}</label>
                      <select
                        className="flex-1 rounded-md border border-border-light bg-surface-2 px-3 py-1.5 text-sm text-text-primary"
                        value={defaultMachineId}
                        onChange={(e) => {
                          setDefaultMachineId(e.target.value);
                          setEngineDirty(true);
                        }}
                      >
                        <option value="local">{t("form.machineLocal")}</option>
                        {machines.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name || (m.machineInfo as { hostname?: string } | null)?.hostname || m.agentName}{" "}
                            ({m.id.slice(0, 8)})
                          </option>
                        ))}
                      </select>
                    </div>
                    {engineDirty && (
                      <div className="flex gap-2 pt-1">
                        <Button size="sm" onClick={saveDefaultEngine} disabled={savingEngine}>
                          {savingEngine ? t("saving") : t("save")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            const metadata = (detail as Record<string, unknown>).metadata as
                              | { defaultEngine?: { engineType?: string; machineId?: string } }
                              | null
                              | undefined;
                            const def = metadata?.defaultEngine;
                            setDefaultEngineType(def?.engineType ?? "");
                            setDefaultMachineId(def?.machineId || "local");
                            setEngineDirty(false);
                          }}
                        >
                          {t("cancel")}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              )}
```

- [ ] **Step 5: 添加 i18n key**

在 `web/src/i18n/locales/` 中找到 `orgs` namespace 的翻译文件，添加 `defaultEngine` key。如果 i18n key 暂时不存在，先使用英文 fallback（`t("defaultEngine", "默认引擎")`）。

检查现有 i18n 文件:
```bash
ls web/src/i18n/locales/zh/orgs.ts
```

如果没有 `defaultEngine` key，需要在中文翻译中添加:

```typescript
defaultEngine: "默认引擎",
```

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/agent-panel/pages/AgentOrganizationsPage.tsx
git commit -m "feat: 组织管理页新增默认引擎设置（仅 owner 可见）"
```

---

### Task 4: 前端 — Agent 创建表单预填默认值

**Files:**
- Modify: `web/src/pages/agent-panel/AgentFormDialog.tsx:173-174,193-222`

**背景:** `AgentFormDialog` 打开时 `formMachineId` 和 `formEngineType` 分别默认为 `"local"` 和 `"opencode"`。需要从当前组织的 `metadata.defaultEngine` 读取覆盖。

- [ ] **Step 1: 导入 useOrg 和 org API**

在 AgentFormDialog.tsx 顶部添加 import:

```typescript
import { useOrg } from "../../contexts/OrgContext";
import { orgApi } from "@/src/api/organizations";
```

- [ ] **Step 2: 在组件内获取组织 metadata**

在组件函数体开始处（约第148行 `const isEdit = mode === "edit"` 之后），添加:

```typescript
  const { org } = useOrg();
```

- [ ] **Step 3: 修改对话框打开时的状态重置**

找到 `useEffect` (第193-222行)，在对话框打开重置状态时，从 org 的 metadata 读取默认值覆盖 `formMachineId` 和 `formEngineType` 的默认值。

将第203行的 `setFormMachineId("local");` 替换为:

```typescript
    // 从组织 metadata 读取默认引擎设置
    const loadOrgDefaults = async () => {
      if (!org?.id) {
        setFormMachineId("local");
        // engineType 已在第174行初始化为 "opencode"，这里不做额外设置
        return;
      }
      try {
        const detail = await unwrap(orgApi.get(org.id));
        const metadata = (detail as Record<string, unknown>).metadata as
          | { defaultEngine?: { engineType?: string; machineId?: string } }
          | null
          | undefined;
        const def = metadata?.defaultEngine;
        if (def?.machineId && def.machineId !== "") {
          setFormMachineId(def.machineId);
        } else {
          setFormMachineId("local");
        }
        if (def?.engineType) {
          setFormEngineType(def.engineType);
        }
      } catch {
        setFormMachineId("local");
      }
    };
    loadOrgDefaults();
```

**注意:** `formEngineType` 初始值已在第174行设为 `"opencode"`，上述代码仅在 org metadata 有值时才覆盖。但如果 org metadata 中 engineType 为空字符串，应保留默认 `"opencode"`。

同时第174行的初始值可以保持不变:

```typescript
  const [formEngineType, setFormEngineType] = useState<string>("opencode");
```

- [ ] **Step 4: Build 前端验证**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web
```

Expected: 构建成功，无类型错误。

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/agent-panel/AgentFormDialog.tsx
git commit -m "feat: Agent 创建表单从组织默认引擎设置预填 engineType/machineId"
```

---

### Task 5: 全量验证

- [ ] **Step 1: 运行 precheck**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck
```

Expected: 格式化、排序、类型检查、lint 全部通过。

- [ ] **Step 2: 运行后端构建**

```bash
bun run build:web
```

Expected: 构建成功。

- [ ] **Step 3: 最终提交**

```bash
git add -A
git commit -m "chore: 组织默认引擎设置全量验证通过"
```
