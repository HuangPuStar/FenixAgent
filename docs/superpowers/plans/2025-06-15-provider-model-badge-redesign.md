# Provider/Model 工牌卡片重设计 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `AgentModelsPage` 中的 Provider/Model 卡片从 Collapsible 折叠式重新设计为"工牌"风格——品牌色头像 + Model 始终可见 + 底部纯文字操作栏。

**Architecture:** 修改一个核心组件 `AgentModelsPage.tsx` 的 `renderCard` 渲染回调，新增 `getProviderColor()` 工具函数到 `agent-models-utils.ts`。无需新增文件，无需改数据结构或 API。`AgentCardList` 网格布局保持不变。

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, lucide-react, `@lobehub/icons` (ModelIcon), react-i18next, shadcn/ui Switch

---

### Task 1: 添加 Provider 品牌色映射工具函数

**Files:**
- Modify: `web/src/pages/agent-panel/pages/agent-models-utils.ts`

- [ ] **Step 1: 添加 `getProviderColor` 函数**

在 `agent-models-utils.ts` 末尾追加：

```typescript
/** Provider 名称到品牌色的映射。用于工牌卡片头像背景色。 */
const PROVIDER_COLORS: Record<string, string> = {
  openai: "#10a37f",
  anthropic: "#d4a574",
  deepseek: "#6366f1",
  google: "#f59e0b",
  mistral: "#8b5cf6",
  meta: "#1877f2",
  grok: "#000000",
  qwen: "#615ced",
};

/**
 * 根据 Provider 名称获取品牌色。
 * 匹配逻辑：名称转小写后，按 PROVIDER_COLORS 的 key 做 includes 匹配，返回第一个命中项。
 * 未命中返回默认灰色 #64748b。
 */
export function getProviderColor(name: string): string {
  const key = name.toLowerCase();
  for (const [k, v] of Object.entries(PROVIDER_COLORS)) {
    if (key.includes(k)) return v;
  }
  return "#64748b";
}
```

- [ ] **Step 2: 运行 TypeScript 编译验证**

```bash
cd web && bunx tsc --noEmit
```

Expected: 无类型错误。

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/agent-panel/pages/agent-models-utils.ts
git commit -m "feat(models): add getProviderColor utility for badge card avatars

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

### Task 2: 重写 Provider 卡片渲染 — 头像区 + 整体框架

**Files:**
- Modify: `web/src/pages/agent-panel/pages/AgentModelsPage.tsx:641-835`

- [ ] **Step 1: 更新 import，添加 `getProviderColor`**

将文件顶部的 utils import（第 41-47 行）替换为：

```typescript
// Provider 工具函数从独立模块导入，避免组件文件加载 @lobehub/icons 后影响单元测试
import {
  buildProviderPublicReadablePayload,
  canWriteProvider,
  getProviderColor,
  getProviderDisplayName,
  getProviderKey,
  getProviderResourceBadgeKey,
} from "./agent-models-utils";
```

- [ ] **Step 2: 用新的工牌卡片替换 renderCard 回调（第 641-835 行）**

将整个 `renderCard` 回调体替换为：

```tsx
        renderCard={(provider) => {
          const providerKey = getProviderKey(provider);
          const providerDisplayName = getProviderDisplayName(provider);
          const writable = canWriteProvider(provider);
          const models = providerModels[providerKey] ?? [];
          const brandColor = getProviderColor(provider.id);
          const hasModels = models.length > 0;

          return (
            <div
              key={providerKey}
              className="group rounded-lg border border-border-light bg-surface-1 transition-colors hover:border-border-active hover:shadow-sm overflow-hidden"
            >
              {/* ── 头像区 ── */}
              <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle">
                <div
                  className="flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-base font-extrabold text-white"
                  style={{ backgroundColor: brandColor }}
                >
                  {providerDisplayName.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-text-bright truncate">{providerDisplayName}</div>
                  <div className="text-[11px] text-text-muted mt-0.5">
                    {writable ? null : (
                      <span className="mr-2">
                        {provider.resourceAccess?.sourceOrganizationName
                          ? `${tComponents("resource.external")} · ${provider.resourceAccess.sourceOrganizationName}`
                          : tComponents("resource.readOnly")}
                      </span>
                    )}
                    {t("columns.models")} ({models.length})
                  </div>
                </div>
              </div>

              {/* ── Model 列表区 ── */}
              <div className="px-4 py-2">
                {hasModels ? (
                  <div className="space-y-1">
                    {models.map((m) => {
                      const limit = (m.limit as Record<string, number | undefined>) ?? {};
                      return (
                        <div key={m.id} className="flex items-center gap-2 py-1.5 min-w-0">
                          <ModelIcon modelId={m.id} size={14} />
                          <span className="font-mono text-[11px] font-medium text-text-bright truncate">{m.id}</span>
                          {limit.context ? (
                            <span className="text-[10px] text-text-muted ml-auto flex-shrink-0">
                              {Number(limit.context).toLocaleString()}
                            </span>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="py-3 text-center">
                    <button
                      type="button"
                      onClick={() => openNewModel(providerKey)}
                      className="text-xs text-text-muted hover:text-text-primary transition-colors"
                    >
                      {t("modelSubrow.addButton")}
                    </button>
                  </div>
                )}
              </div>

              {/* ── 操作栏 ── */}
              <div className="flex items-center gap-3 px-4 py-2 border-t border-border-subtle bg-surface-0 text-[11px]">
                {writable ? (
                  <>
                    {/* 左侧：测试 & 编辑 */}
                    <div className="flex items-center gap-2">
                      {hasModels && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleTest(providerKey);
                          }}
                          disabled={testing === providerKey}
                          className="text-text-secondary hover:text-text-primary transition-colors disabled:opacity-40"
                        >
                          {testing === providerKey ? t("actions.testing") : t("actions.test")}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleOpenEdit(provider);
                        }}
                        className="text-text-secondary hover:text-text-primary transition-colors"
                      >
                        {t("actions.edit")}
                      </button>
                    </div>
                    {/* 右侧：公开开关 & 删除 */}
                    <div className="flex items-center gap-2 ml-auto">
                      <label
                        className="flex items-center gap-1.5 cursor-pointer"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <span className="text-text-muted">
                          {provider.resourceAccess?.publicReadable
                            ? tComponents("resource.public")
                            : tComponents("resource.internal")}
                        </span>
                        <Switch
                          checked={Boolean(provider.resourceAccess?.publicReadable)}
                          disabled={
                            sharingProviderKey === providerKey || provider.resourceAccess?.manageable !== true
                          }
                          onCheckedChange={() =>
                            void handleTogglePublic(provider, !provider.resourceAccess?.publicReadable)
                          }
                        />
                      </label>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleDelete(provider.id);
                        }}
                        className="text-red-500 hover:text-red-600 transition-colors"
                      >
                        {t("actions.delete")}
                      </button>
                    </div>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleOpenEdit(provider);
                    }}
                    className="text-text-secondary hover:text-text-primary transition-colors"
                  >
                    {t("actions.view")}
                  </button>
                )}
              </div>
            </div>
          );
        }}
```

- [ ] **Step 3: 运行 TypeScript 编译验证**

```bash
cd web && bunx tsc --noEmit
```

Expected: 无类型错误。修复任何缺失的 import 或类型问题。

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/agent-panel/pages/AgentModelsPage.tsx
git commit -m "feat(models): redesign provider/model cards as badge-style

Replace Collapsible-based layout with badge card design:
- Brand-colored avatar header with provider name and model count
- Model list always visible, showing icon + name + context limit
- Bottom action bar with text-only test/edit/delete/public toggle
- Empty state shows 'add model' link
- Read-only state shows source label and 'view' action

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

### Task 3: 清理不再使用的 import

**Files:**
- Modify: `web/src/pages/agent-panel/pages/AgentModelsPage.tsx:1-21`

- [ ] **Step 1: 移除 Collapsible 和 ChevronDown 的 import**

Collapsible 相关组件（`Collapsible`, `CollapsibleContent`, `CollapsibleTrigger`）不再使用，`ChevronDown` 也不再使用。

将第 1 行的 import：
```typescript
import { ChevronDown, Plus, Search } from "lucide-react";
```
改为：
```typescript
import { Plus, Search } from "lucide-react";
```

将第 10 行：
```typescript
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
```
**整行删除**。

- [ ] **Step 2: 检查 `Skeleton` import 是否仍在使用**

`Skeleton` 在第 14 行导入，用于页面初始加载状态（第 576-579 行）——保留。

- [ ] **Step 3: 运行 TypeScript 编译验证**

```bash
cd web && bunx tsc --noEmit
```

Expected: 无类型错误，无 unused import 警告。

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/agent-panel/pages/AgentModelsPage.tsx
git commit -m "chore(models): remove unused Collapsible and ChevronDown imports

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

### Task 4: 构建前端并验证

**Files:**
- (none — 验证步骤)

- [ ] **Step 1: 构建前端**

```bash
bun run build:web
```

Expected: 构建成功，无错误。

- [ ] **Step 2: 运行 precheck**

```bash
bun run precheck
```

Expected: biome format、biome import sort、tsc、biome lint 全部通过。

- [ ] **Step 3: Commit（如有格式修正）**

如果 precheck 自动修正了格式或 import 排序：
```bash
git add -A
git commit -m "chore(models): apply precheck auto-fixes

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```

---

### Task 5: 运行现有测试确认无回归

**Files:**
- `web/src/__tests__/` — 前端测试

- [ ] **Step 1: 搜索 models 相关测试文件**

```bash
find web/src/__tests__ -name "*model*" -o -name "*provider*" 2>/dev/null
```

- [ ] **Step 2: 运行 models 相关测试（如果存在）**

```bash
bun test web/src/__tests__/ 2>&1 | head -60
```

Expected: 所有现有测试通过，无回归。

- [ ] **Step 3: 启动开发服务器做手动冒烟验证**

```bash
# 终端1: 后端
bun run dev

# 终端2: 前端
bun run dev:web
```

在浏览器打开 `/agent/models`，验证：
- 常规 Provider 卡片显示工牌风格
- Model 列表始终可见，显示 icon + 名称 + context 长度
- 操作栏测试/编辑/删除可正常触发
- 公开/私有开关可正常切换
- 空模型 Provider 显示"添加模型"
- 只读/外部 Provider 显示来源信息和"查看"
- 页面搜索过滤正常工作

- [ ] **Step 4: Commit（如有修复）**

```bash
git add -A
git commit -m "fix(models): address manual testing issues on badge cards

Co-Authored-By: deepseek-v4-pro <deepseek-ai@claude-code-best.win>"
```
