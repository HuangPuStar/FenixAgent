# Hindsight Memory & Documents 前端迁移设计

日期: 2026-06-09
状态: 待实施

## 背景

Hindsight 是 AI 智能体内存系统（Python FastAPI 后端 + Next.js 前端），核心能力是帮 Agent 存储和检索记忆。RCS 已有基础 Hindsight 集成（后端 bank 管理 + MCP server），但前端页面仍需跳转到 Hindsight 独立控制面板查看。

本次目标：将 Hindsight 的 Memory 和 Documents 视图迁移到 RCS 前端，作为 RCS 的独立页面，通过 RCS 后端 API Proxy 转发请求到 Hindsight FastAPI 服务。

## 方案选型

| 方案 | 描述 | 结论 |
|------|------|------|
| A. 组件复制 + API Proxy | 复制 Hindsight 前端组件到 RCS，通过 Elysia proxy 转发 API | **采用** |
| B. iframe 嵌入 | 通过 iframe 嵌入 Hindsight 控制面板 | 体验割裂，放弃 |
| C. NPM 包引用 | 打包为独立 NPM 包引用 | 技术栈不兼容，放弃 |

## 架构

```
RCS 前端 (/agent/memories)
    ├── web/src/api/hindsight.ts              ← API 客户端
    ├── web/src/pages/hindsight/              ← 页面组件（从 Hindsight 复制改造）
    ├── web/src/routes/agent/_panel/memories.tsx ← TanStack Router 路由
    └── i18n 命名空间: hindsight

RCS 后端
    ├── src/routes/web/hindsight.ts            ← 扩展 proxy 端点
    └── src/services/hindsight.ts              ← 扩展 API 转发
        ↓
Hindsight FastAPI (HINDSIGHT_MCP_URL, 默认 localhost:8888)
```

## Bank ID 策略

沿用现有逻辑：**member ID** 作为 Hindsight bank ID。

- 每个 (organizationId, userId) 组合对应一个 member 记录，其 ID 即为 bank ID
- 前端不显示 BankSelector，bankId 从后端 `/web/hindsight/status` 接口获取
- 现有 `ensureBank()` 函数保证 bank 存在（幂等）

## 后端 API Proxy 设计

扩展现有 `src/routes/web/hindsight.ts`（当前仅有 `/status` 端点），新增以下 proxy 端点：

### 内存操作

| RCS 路由 | 方法 | 转发到 Hindsight API |
|----------|------|---------------------|
| `/web/hindsight/status` | GET | 现有，扩展返回 `bankId` |
| `/web/hindsight/memories` | GET | `GET /v1/default/banks/{bankId}/memories` |
| `/web/hindsight/memories` | POST | `POST /v1/default/banks/{bankId}/memories`（创建/retain） |
| `/web/hindsight/memories/:id` | DELETE | `DELETE /v1/default/banks/{bankId}/memories/{id}` |
| `/web/hindsight/recall` | POST | `POST /v1/default/banks/{bankId}/recall` |
| `/web/hindsight/reflect` | POST | `POST /v1/default/banks/{bankId}/reflect` |

### 文档操作

| RCS 路由 | 方法 | 转发到 Hindsight API |
|----------|------|---------------------|
| `/web/hindsight/documents` | GET | `GET /v1/default/banks/{bankId}/documents` |
| `/web/hindsight/documents` | POST | `POST /v1/default/banks/{bankId}/documents`（multipart） |
| `/web/hindsight/documents/:id` | DELETE | `DELETE /v1/default/banks/{bankId}/documents/{id}` |
| `/web/hindsight/documents/:id/chunks` | GET | `GET /v1/default/banks/{bankId}/documents/{id}/chunks` |

### 心理模型

| RCS 路由 | 方法 | 转发到 Hindsight API |
|----------|------|---------------------|
| `/web/hindsight/mental-models` | GET | `GET /v1/default/banks/{bankId}/mental-models` |
| `/web/hindsight/mental-models/:id` | DELETE | `DELETE /v1/default/banks/{bankId}/mental-models/{id}` |

### 认证

所有 proxy 端点使用 RCS 现有的 `requireOrgScope` + `auth` 插件保护。后端从 auth context 解析 member ID 作为 bank ID，前端不需要传 bankId。

### 转发逻辑

```typescript
// src/services/hindsight.ts 新增
async function proxyToHindsight(path: string, options?: RequestInit): Promise<Response> {
  const config = getHindsightConfig();
  if (!config) throw new Error("HINDSIGHT_MCP_URL not configured");
  return fetch(`${config.url}${path}`, options);
}
```

## 前端页面设计

### 路由

- 路径: `/agent/memories`
- 文件: `web/src/routes/agent/_panel/memories.tsx`
- 入口: 在 Agent 面板 AgentSidebar 的 "更多菜单" 中添加 "Memories" 导航项

### 页面结构

```
┌─────────────────────────────────────────┐
│  Memories                               │
│  Agent 记忆管理                          │
├─────────────────────────────────────────┤
│  [Memories]  [Documents]  [Mental Models]│ ← 主 Tab
├─────────────────────────────────────────┤
│  [World Facts] [Experience] [Observations]│ ← Memories 子 Tab
│                                          │
│  ┌──────────────────────────────────────┐│
│  │  搜索/过滤栏                          ││
│  ├──────────────────────────────────────┤│
│  │  Memory 列表 / Document 列表 / ...    ││
│  │  ...                                  ││
│  └──────────────────────────────────────┘│
└─────────────────────────────────────────┘
```

### 需迁移的 Hindsight 组件

从 Hindsight 项目 (`hindsight-control-plane/src/components/`) 复制并改造：

| 源组件 | 大小 | 改造重点 |
|--------|------|---------|
| `data-view.tsx` | 66KB | API 调用 → `@/api/hindsight`；Radix 原生 → shadcn/ui；去掉 bank-context 依赖 |
| `documents-view.tsx` | 59KB | 同上；文件上传改用 RCS fetch；去掉 Next.js API routes 依赖 |
| `mental-models-view.tsx` | 64KB | API 替换；UI 组件替换 |
| `memory-detail-panel.tsx` | 30KB | API 替换；适配 markdown 渲染 |
| `memory-detail-modal.tsx` | 29KB | Dialog → shadcn Dialog |
| `compact-markdown.tsx` | 小 | 可直接复用 |
| `tag-filter-input.tsx` | 小 | Radix Popover → shadcn Popover |
| `fact-type-filter.tsx` | 小 | 可直接复用 |
| `mental-model-detail-modal.tsx` | 43KB | Dialog → shadcn Dialog；API 替换 |

### API 客户端

新建 `web/src/api/hindsight.ts`：

```typescript
// 类似 RCS 现有的 web/src/api/sdk.ts 风格
// 封装所有 Hindsight proxy 端点的 fetch 调用
export const hindsightApi = {
  getStatus: () => fetch('/web/hindsight/status'),
  getMemories: (params) => fetch('/web/hindsight/memories?' + params),
  recall: (body) => fetch('/web/hindsight/recall', { method: 'POST', body }),
  // ...
};
```

### i18n

- 新增命名空间: `hindsight`
- 翻译文件: `web/src/i18n/locales/{en,zh}/hindsight.json`
- 从 Hindsight 的 `next-intl` JSON 中提取 Memory/Documents/Mental Models 相关键值
- 使用 `NS.HINDSIGHT` 常量（在 `web/src/i18n/index.ts` 注册）

## 不迁移的部分

- **BankSelector / Sidebar** — RCS 有自己的导航
- **Bank Config / Webhooks / Audit Logs** — 管理功能，超出本次范围
- **Entities View (cytoscape)** — 需要额外依赖，超出本次范围
- **Bank Stats (recharts)** — 统计功能，超出本次范围
- **Search Debug / Think View** — 调试功能，超出本次范围
- **Observation History** — 依赖 observations 功能开关，超出本次范围
- **Hindsight 登录页** — RCS 有自己的认证

## 文件变更清单

### 新增文件

| 文件 | 说明 |
|------|------|
| `web/src/api/hindsight.ts` | Hindsight API 客户端 |
| `web/src/routes/agent/_panel/memories.tsx` | TanStack Router 路由页面 |
| `web/src/pages/hindsight/MemoriesPage.tsx` | Memories 页面（含 Tab 切换） |
| `web/src/pages/hindsight/components/DataView.tsx` | 内存数据视图（改造自 Hindsight） |
| `web/src/pages/hindsight/components/DocumentsView.tsx` | 文档视图 |
| `web/src/pages/hindsight/components/MentalModelsView.tsx` | 心理模型视图 |
| `web/src/pages/hindsight/components/MemoryDetailPanel.tsx` | 内存详情面板 |
| `web/src/pages/hindsight/components/MemoryDetailModal.tsx` | 内存详情弹窗 |
| `web/src/pages/hindsight/components/MentalModelDetailModal.tsx` | 心理模型详情弹窗 |
| `web/src/pages/hindsight/components/CompactMarkdown.tsx` | Markdown 渲染 |
| `web/src/pages/hindsight/components/TagFilterInput.tsx` | 标签过滤 |
| `web/src/pages/hindsight/components/FactTypeFilter.tsx` | 事实类型过滤 |
| `web/src/i18n/locales/en/hindsight.json` | 英文翻译 |
| `web/src/i18n/locales/zh/hindsight.json` | 中文翻译 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/routes/web/hindsight.ts` | 扩展 proxy 端点 |
| `src/services/hindsight.ts` | 新增 proxyToHindsight + bankId 解析 |
| `web/src/pages/agent-panel/AgentSidebar.tsx` | 添加 Memories 导航项 |
| `web/src/i18n/index.ts` | 注册 hindsight 命名空间 |

## 风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| Hindsight 组件很大（30-66KB），改造工作量大 | 分阶段迁移：先 DataView → Documents → Mental Models |
| Hindsight API 变更导致 proxy 失效 | proxy 层透传，不做数据转换；版本锁定 |
| 两套 UI 组件共存（Hindsight Radix 原生 vs RCS shadcn） | 复制时统一替换为 shadcn/ui 组件 |
| cytoscape/recharts 未安装 | 本次不涉及 Entities/Stats 视图 |
