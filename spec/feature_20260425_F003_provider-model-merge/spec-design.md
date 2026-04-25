# Feature: 20260425_F003 - provider-model-merge

## 需求背景

当前 Settings 页面有两个独立入口：服务商管理（ProvidersPage）和模型管理（ModelsPage）。用户在实际使用中，服务商和模型是强关联的层级关系——服务商包含模型，模型属于服务商。将两者拆分为独立页面导致用户需要频繁切换，且信息分散。

本 feature 将服务商和模型面板合并为统一的"模型"面板，以服务商为主体展示其下所有模型，同时将原有的主模型/轻量模型选择配置改为轻量级的 icon button 弹窗交互。

## 目标

- 合并"服务商"和"模型"两个页面为一个统一的"模型"页面
- 侧边栏删除"服务商"入口，只保留"模型"入口
- 页面以服务商为主体，每个服务商下展示模型子表格，全部默认展开
- 主模型/轻量模型配置改为页面标题栏 icon button 弹窗
- 保留服务商的新建、编辑、删除操作

## 方案设计

### 页面布局

![页面布局](./images/01-wireframe.png)

```
模型页面
├── 标题栏：左侧"模型管理"标题 + 右侧 [齿轮 icon] [新建服务商] 按钮
│     └── 齿轮 icon → 点击弹出"模型配置"Dialog
│           ├── 主模型 Select 下拉
│           └── 轻量模型 Select 下拉
│
└── DataTable<ProviderInfo>（可展开行，默认全部展开）
      ├── 服务商行：ID | 名称 | NPM 包 | API Key | Base URL | 状态 | 模型数 | 操作（编辑/删除）
      └── 展开行：ModelSubrow
            └── 模型子表格：模型 ID | 名称 | 上下文 | 输出 | 模态 | 操作（编辑/删除）
                  └── [+ 新增模型] 按钮
```

### 交互流程 — 模型配置弹窗

![模型配置弹窗](./images/02-flow.png)

```
用户点击标题栏齿轮 icon
       │
       ▼
弹出 Dialog "模型配置"
  ├── 主模型：Select 下拉（选项来自 available 列表 + 手动输入）
  ├── 轻量模型：Select 下拉（同上）
  └── 切换后即时保存（onChange 调用 API）
       │
       ▼
Toast 提示"模型已更新"
```

### 服务商展开行默认展开

DataTable 组件新增 `defaultExpandAll` 属性，初始化时将所有数据行的 key 加入 `expandedRows` state。Provider 行的展开/折叠按钮仍可交互，用户可手动折叠某个服务商。

### 侧边栏变更

删除 `id: "providers"` 的 SidebarItem，路由 `/code/providers` 移除。保留 `id: "models"` 入口，图标和标签不变。

路由层面的变更：
- `ViewId` 类型移除 `"providers"`
- `configViews` 数组移除 `"providers"`
- `App.tsx` 中删除 ProvidersPage 的懒加载引用和路由匹配

### 组件拆分

合并后的 ModelsPage 复用现有组件：

| 组件 | 来源 | 改动 |
|------|------|------|
| `ModelsPage` | 重写 | 合并 ProvidersPage + ModelsPage 的功能 |
| `ModelSubrow` | 从 ProvidersPage 迁移 | 无改动，直接迁移 |
| `ModelConfigDialog` | 新增 | 齿轮 icon button + Dialog，封装主模型/轻量模型切换 |
| `DataTable` | 现有 | 新增 `defaultExpandAll` prop |

### 数据加载策略

页面加载时并行请求两个 API：
1. `apiListProviders()` + 逐个 `apiGetProvider(id)` 获取每个服务商的模型列表
2. `apiGetModels()` 获取当前模型配置 + 可用模型列表

合并为一次 `loadAll()` 调用，使用 `Promise.all` 并行执行。

## 实现要点

1. **DataTable defaultExpandAll**：在 DataTable 组件中新增 `defaultExpandAll?: boolean` prop。当为 true 时，useEffect 初始化将所有行的 key（通过 rowKey 函数）加入 expandedRows Set。

2. **ModelConfigDialog**：新增组件，使用 IconButton（Settings 图标）触发 Dialog。Dialog 内复用 ModelsPage 现有的 Select 下拉逻辑，切换即时保存。

3. **迁移策略**：将 ProvidersPage 中的 `ModelSubrow`、`validateProviderForm`、`buildProviderForm` 等函数直接迁移到新的 ModelsPage 中。ProvidersPage.tsx 文件最终删除。

4. **路由清理**：App.tsx 中移除 providers 相关的 ViewId、configViews、SidebarItem 配置和路由匹配。

## 验收标准

- [ ] 侧边栏只显示"模型"入口，无"服务商"入口
- [ ] 访问 /code/models 显示合并后的模型管理页面
- [ ] /code/providers 路由已移除，不再可访问
- [ ] 服务商列表正确展示，所有服务商行默认展开显示模型子表格
- [ ] 点击齿轮 icon 弹出模型配置 Dialog，可切换主模型和轻量模型
- [ ] 服务商的新建、编辑、删除功能正常
- [ ] 模型的新增、编辑、删除功能正常
- [ ] 搜索、筛选、排序功能正常
