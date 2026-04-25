# Feature: 20260424_F002 - settings-ui

## 需求背景

F001（settings-config-modules）已完成 4 个配置模块的后端 API 设计：Providers、Models、Agents、Skills。本 feature 为这 4 个模块实现前端管理页面，让用户通过 Web UI 完成日常的 AI 配置调整，无需 SSH 到服务器手动编辑 `opencode.json`。

现有前端基于 React + TypeScript + Vite，使用 shadcn/ui 组件库，有 Dashboard、Session、API Keys 三个页面。本 feature 在现有 Sidebar 中新增 4 个平铺入口，每个模块采用完整管理后台级别的交互体验。

## 目标

- 为 4 个配置模块各提供一个完整的 CRUD 管理页面
- 所有页面基于共享 DataTable 组件构建，保持交互一致性
- 支持列表搜索/筛选/分页、操作二次确认、批量操作、连接测试反馈等高级功能
- 与后端 F001 的 API 接口完全对接

## 方案设计

### 架构总览

![架构总览](./images/01-architecture.png)

```
App.tsx (路由层)
  ├── Sidebar（新增 4 个平铺入口）
  │     ├── 服务商 /providers
  │     ├── 模型   /models
  │     ├── Agent   /agents
  │     └── 技能   /skills
  │
  ├── 共享组件层 (web/components/config/)
  │     ├── DataTable<T>      ← 搜索、筛选、排序、分页、行选择
  │     ├── ConfirmDialog     ← 危险操作二次确认
  │     ├── FormDialog        ← 表单弹窗壳
  │     ├── BatchActionBar    ← 批量操作浮动工具条
  │     ├── StatusBadge       ← 状态标签
  │     └── EmptyState        ← 空状态占位
  │
  └── 4 个模块页面 (web/src/pages/)
        ├── ProvidersPage.tsx
        ├── ModelsPage.tsx
        ├── AgentsPage.tsx
        └── SkillsPage.tsx
```

**所有共享组件基于现有 shadcn/ui 组件构建：**

| 共享组件 | 底层 shadcn 组件 |
|---------|----------------|
| DataTable | Table + Input + Button + Checkbox |
| ConfirmDialog | AlertDialog |
| FormDialog | Dialog + Button |
| BatchActionBar | Card + Button + Badge |
| StatusBadge | Badge |
| EmptyState | Card + Button |

### Sidebar 改造与路由

![Sidebar 布局](./images/02-wireframe.png)

**Sidebar 结构（全部平铺，无分组折叠）：**

```
仪表盘 (LayoutDashboard)       → /code/
会话 (MessageSquare)            → /code/:sessionId
API 密钥 (KeyRound)             → (state: showApiKeys)
─────────────── Separator
服务商 (Cloud)                  → /code/providers
模型 (Cpu)                      → /code/models
Agent (Bot)                       → /code/agents
技能 (Wrench)                    → /code/skills
─────────────── Separator
退出 (LogOut)
```

**改动点：**

- `ViewId` 类型扩展：新增 `"providers" | "models" | "agents" | "skills"`
- `App.tsx` 中新增 4 条路由匹配规则
- 4 个新页面使用 `lazy(() => import(...))` 懒加载
- `SidebarItem[]` 新增 4 个配置，图标来自 lucide-react
- API 密钥下方、退出上方各加一条 Separator 分隔线

### API Client 层

在 `web/src/api/client.ts` 中新增统一配置请求函数和模块特化函数：

```typescript
// 通用配置请求
async function apiConfigAction<T>(
  module: 'providers' | 'models' | 'agents' | 'skills',
  action: string,
  payload?: Record<string, unknown>
): Promise<T>

// 模块特化函数（每个模块 4-7 个）
apiListProviders() → ProviderInfo[]
apiGetProvider(name) → ProviderDetail
apiSetProvider(name, data) → void
apiTestProvider(name) → { models: string[] }
apiDeleteProvider(name) → void
// ... Models、Agents、Skills 类似
```

**状态管理：** 每个模块页面使用独立的 React hooks（useState + useCallback），不引入全局状态库。页面间共享的数据（如 Models 的 available 列表被 Agents 页面引用）通过 API 实时获取。

**错误处理：** 所有 API 调用统一 try/catch，失败时使用 Toast（sonner）提示。

### 服务商（Providers）页面

![服务商页面](./images/03-wireframe.png)

**页面结构：** 单页 DataTable + FormDialog 弹窗

**列表视图列配置：**

| 列 | 字段 | 可排序 | 可筛选 |
|----|------|--------|--------|
| 名称 | `name` | 是 | 是 |
| API Key | `keyHint`（如 `***ab12`） | 否 | 否 |
| Base URL | `baseURL` | 否 | 否 |
| 状态 | 已配置/未配置 Badge | 否 | 是 |
| 操作 | 测试连接、编辑、删除 | — | — |

**新建/编辑弹窗字段：**

| 字段 | 组件 | 校验 |
|------|------|------|
| 名称 | Input | 必填，1-64 字符，编辑时只读 |
| API Key | Input[type=password] + 显示/隐藏切换 | 可选（编辑时留空表示不修改） |
| Base URL | Input | 可选，默认使用服务商默认 URL |
| Timeout | Input[type=number] | 可选，单位 ms |

**测试连接流程：**

1. 点击"测试连接" → 按钮进入 loading 状态
2. 调用 `{ action: "test", name }` API
3. 成功 → 弹出 Dialog 展示模型列表
4. 失败 → Toast 错误提示

**批量操作：** 批量删除（ConfirmDialog 确认）

### 模型（Models）页面

![模型页面](./images/04-wireframe.png)

**页面结构：** 配置卡片 + 可用模型 DataTable

**区域一 — 当前模型配置（顶部 Card）：**

- 主模型：`Select` 下拉，选项来自 `available` 列表 + 允许手动输入
- 轻量模型：`Select` 下拉，同上
- 切换后即时保存（调用 `{ action: "set" }`）

**区域二 — 可用模型列表（DataTable）：**

| 列 | 字段 | 可排序 |
|----|------|--------|
| 模型 ID | `id` | 是 |
| 服务商 | `provider` | 是 |
| 显示名 | `label` | 否 |
| 使用状态 | 主模型/轻量模型 Badge | 否 |

- 顶部"刷新"按钮调用 `{ action: "refresh" }` 更新可用模型列表
- 不需要新建/编辑/删除弹窗，不需要批量操作

### Agent（Agents）页面

![Agent页面](./images/05-wireframe.png)

**页面结构：** 单页 DataTable + FormDialog 弹窗

**列表视图列配置：**

| 列 | 字段 | 可排序 | 可筛选 |
|----|------|--------|--------|
| 名称 | `name` | 是 | 是 |
| 类型 | 内置/自定义 Badge | 否 | 是 |
| 模型 | `model` | 是 | 否 |
| 模式 | `primary`/`subagent`/`all` Badge | 否 | 是 |
| 步数 | `steps` | 是 | 否 |
| 默认 | 星标（是否为 default_agent） | 否 | 是 |
| 操作 | 设为默认、编辑、删除 | — | — |

内置 Agent 的操作列不显示"删除"按钮。

**新建/编辑弹窗字段：**

| 字段 | 组件 | 校验 |
|------|------|------|
| 名称 | Input | 必填，1-64 字符，小写字母+数字+单连字符，编辑时只读 |
| 模型 | Select | 下拉选项从 Models 的 available 列表获取，支持手动输入 |
| 模式 | Select（primary / subagent / all） | 必填 |
| 步数 | Input[type=number] | 1-200 |
| 工具 | Checkbox 多选组 | 列出 OpenCode 支持的工具 |
| Prompt | Textarea（多行） | 可选 |

**批量操作：** 批量删除（仅自定义 Agent，ConfirmDialog 确认）

### 技能（Skills）页面

![技能页面](./images/06-wireframe.png)

**页面结构：** 单页 DataTable + FormDialog 弹窗（内嵌 Markdown 编辑器）

**列表视图列配置：**

| 列 | 字段 | 可排序 | 可筛选 |
|----|------|--------|--------|
| 名称 | `name` | 是 | 是 |
| 描述 | `description` | 否 | 否 |
| 状态 | 已启用（绿色 Badge）/ 已禁用（灰色 Badge） | 否 | 是 |
| 操作 | 启用/禁用切换、编辑、删除 | — | — |

**新建/编辑弹窗字段：**

| 字段 | 组件 | 校验 |
|------|------|------|
| 名称 | Input | 必填，编辑时只读 |
| 描述 | Input | 可选 |
| 许可证 | Input | 可选 |
| 兼容性 | Input | 可选 |
| 内容 | Markdown 编辑器（左侧编辑 + 右侧实时预览） | 必填 |

**Markdown 编辑器：** 左侧为 `Textarea`（编辑区），右侧为渲染后的预览区。使用 `react-markdown` 或 `marked` 进行轻量渲染。

**批量操作：** 批量启用 / 批量禁用 / 批量删除

**特殊交互规则：**

- 删除操作需 ConfirmDialog 提示"此操作不可逆"
- 启用/禁用为即时切换，不需要确认（可逆操作）
- 编辑已禁用的 skill 时，保存后自动启用

### 交互流程 — Provider 测试连接

![测试连接流程](./images/07-flow.png)

```
用户点击"测试连接"
       │
       ▼
按钮进入 loading 状态（Spinner + "测试中..."）
       │
       ▼
调用 POST /web/config/providers { action: "test", name }
       │
  ┌────┴────┐
  │         │
成功       失败
  │         │
  ▼         ▼
弹出 Dialog  Toast 错误提示
展示模型列表  显示具体错误信息
  │         │
  ▼         ▼
用户关闭     用户自行处理
```

## 实现要点

1. **共享 DataTable 组件**：基于 shadcn/ui Table 构建，支持泛型列配置、客户端搜索/筛选/排序、分页、行选择。这是 4 个模块页面的基础，需要设计灵活的 `Column<T>` 接口。

2. **Markdown 编辑器**：Skills 页面的内容编辑器使用 Textarea + react-markdown 实现左右分栏。不引入重量级编辑器库（如 CodeMirror / Monaco），保持轻量。

3. **Toast 通知**：引入 `sonner` 库处理 API 错误提示和操作成功反馈，与 shadcn/ui 风格一致。

4. **Provider 连接测试**：测试按钮需要有明确的 loading → 成功/失败状态切换。测试结果 Dialog 展示模型列表时，可选择某个模型 ID 自动填充到其他模块的模型选择中。

5. **表单校验**：前端校验规则与后端 F001 设计保持一致（Agent name 格式、steps 范围等）。校验失败在表单字段下方显示红色提示文字。

6. **懒加载**：4 个新页面全部使用 React.lazy 懒加载，避免增加首屏 bundle 大小。

7. **内置资源保护**：内置 Agent 的删除按钮在 UI 层即隐藏（不显示），而非依赖后端报错。双重保护。

## 约束一致性

`spec/global/` 目录不存在，无全局约束需要对照。

## 验收标准

- [ ] Sidebar 正确显示 7 个平铺入口，图标和中文标签正确
- [ ] 4 个模块页面均能正确加载，懒加载生效
- [ ] Providers 页面：列表展示、新建/编辑弹窗、API Key 密码框、测试连接流程正常
- [ ] Models 页面：配置卡片可切换主模型和轻量模型，刷新可用模型列表正常
- [ ] Agents 页面：列表展示、新建/编辑弹窗（含工具 Checkbox 多选）、内置 Agent 不可删除
- [ ] Skills 页面：列表展示、Markdown 编辑器预览、启用/禁用切换正常
- [ ] 所有模块的搜索、筛选、排序、分页功能正常
- [ ] 批量操作（删除/启用/禁用）正常，ConfirmDialog 确认后执行
- [ ] API 错误时 Toast 提示正确显示
- [ ] 所有组件基于 shadcn/ui 构建，风格一致
