# Provider/Model 工牌卡片重设计

**日期**: 2025-06-15
**状态**: 设计确认
**范围**: `AgentModelsPage` 中 Provider 和 Model 的卡片展示组件

---

## 1. 设计目标

将当前功能性的可折叠卡片（`Collapsible` + Tailwind utility）重新设计为"工牌"风格，提升品牌感和信息层次，同时保留所有现有操作能力。

## 2. 关键决策

| 维度 | 选择 |
|------|------|
| 整体风格 | 挂牌简约版，无挂绳装饰 |
| 卡片结构 | 头像+名称区 → Model 列表 → 底部操作栏 |
| Provider 区分 | 每个 Provider 使用其品牌色方形头像（首字母） |
| Model 展示 | 始终显示，不折叠。行内展示 model icon + 名称 + context 长度 |
| 空状态 | 仅显示"+ 添加模型"入口（点击打开添加模型弹窗），无额外空态文案 |
| 操作方式 | 底部常驻操作栏，极简文字按钮（测试/编辑/删除 + 公开开关） |
| 价格展示 | 不展示价格数据 |
| Model 图标 | 使用现有 `<ModelIcon modelId={...} />` 组件 |

## 3. 组件结构

```
┌─────────────────────────────┐
│  [品牌色方形头像]  Provider名称  │  ← 头像区
│                    模型数量      │
├─────────────────────────────┤
│  [icon] model-name   context  │  ← Model 列表区
│  [icon] model-name   context  │     (始终展示)
│  [icon] model-name   context  │
├─────────────────────────────┤
│  测试  编辑      [公开 ▼]  删除 │  ← 操作栏
└─────────────────────────────┘
```

### 3.1 头像区

- 方形圆角头像（36×36, `border-radius: 8px`）
- 背景色为 Provider 品牌色（OpenAI=#10a37f, Anthropic=#d4a574, DeepSeek=#6366f1, Google=#f59e0b, Mistral=#8b5cf6, 默认=#64748b）
- 白色首字母（取 Provider name 第一个字符）
- 右侧显示 Provider 名称（12px bold）+ 模型数量（9px gray）

### 3.2 Model 列表区

- 始终可见，不折叠
- 每行：`<ModelIcon size={14}>` + model ID（10px, mono, bold）+ context 长度（9px, gray）
- 无价格列
- 空状态：区域居中显示"+ 添加模型"（点击触发添加模型弹窗）

### 3.3 操作栏

- 底部分隔线 + 浅灰背景（`#f8fafc`）
- 左侧：测试 / 编辑（9px 文字按钮，颜色 `#64748b`）
- 右侧：公开/私有开关（Switch）+ 删除（9px，`#ef4444`）
- 只读/外部来源：仅显示"查看详情"，透明度降至 0.8，头像区显示来源组织名

## 4. 状态变体

| 状态 | 头像区 | Model 区 | 操作栏 |
|------|--------|----------|--------|
| **常规** | 品牌色头像 + 名称 + 数量 | 模型行列表 | 测试/编辑/开关/删除 |
| **空模型** | 品牌色头像 + 名称 + "0 个模型" | 居中"添加模型" | 编辑/开关/删除 |
| **只读外部** | 头像 + 名称 + "来自 xxx" | 模型行列表（不可操作） | "查看详情" |
| **外部可管理** | 头像 + 名称 + "外部 · N 模型" | 模型行列表 | 测试/编辑/开关/删除 |
| **私有** | 正常 | 正常 | 开关为关（灰色） |
| **加载中** | 骨架屏占位 | "加载中..." | 按钮禁用 |
| **错误** | 红色头像 + "连接失败" | 错误信息 + "重试" | 编辑/删除 |
| **测试中** | 半透明遮罩 + "测试中..." | 可见但不可交互 | 按钮禁用 |

## 5. 数据映射

从现有类型到卡片组件：

| 卡片元素 | 数据来源 | 类型字段 |
|----------|----------|----------|
| 头像背景色 | Provider name → 品牌色映射表 | `provider.name` |
| 头像字母 | Provider name 首字符 | `provider.name[0]` |
| Provider 名称 | Provider name | `provider.name` |
| 模型数量 | Model 数组长度 | `models.length` |
| Model 图标 | Model ID → `<ModelIcon>` | `model.id` |
| Model 名称 | Model ID | `model.id` |
| Context 长度 | Model limit config | `model.limit?.context` |
| 公开/私有 | ResourceAccess | `provider.resourceAccess?.publicReadable` |
| 读写权限 | ResourceAccess | `provider.resourceAccess?.writable` |
| 来源组织 | ResourceAccess | `provider.resourceAccess?.sourceOrganizationName` |

## 6. Provider 品牌色映射

```typescript
const PROVIDER_COLORS: Record<string, string> = {
  openai: '#10a37f',
  anthropic: '#d4a574',
  deepseek: '#6366f1',
  google: '#f59e0b',
  mistral: '#8b5cf6',
  meta: '#1877f2',
  grok: '#000000',
  qwen: '#615ced',
};

function getProviderColor(name: string): string {
  const key = name.toLowerCase();
  for (const [k, v] of Object.entries(PROVIDER_COLORS)) {
    if (key.includes(k)) return v;
  }
  return '#64748b'; // default gray
}
```

## 7. 实现要点

### 7.1 文件变更范围

| 文件 | 变更 |
|------|------|
| `web/src/pages/agent-panel/pages/AgentModelsPage.tsx` | 替换 Provider/Model 卡片渲染逻辑 |
| `web/src/pages/agent-panel/shared/AgentCardList.tsx` | 可能需要微调网格/间距 |
| 新增: `web/src/pages/agent-panel/components/BadgeCard.tsx` | 工牌卡片组件（可选，视复杂度） |

### 7.2 注意

- Provider 卡片在 `AgentCardList` 中以 2-3 列网格布局，卡片宽度自适应
- 不再使用 `Collapsible` 组件，Model 始终展示
- 保留现有的 Test/Edit/Delete 对话框逻辑，仅改变触发入口的 UI
- Model 图标继续使用现有 `<ModelIcon>` 组件
- 操作按钮使用纯文字，无 emoji，无彩色背景（除删除按钮的红色文字）
- 国际化：所有按钮文字和标签必须走 `t()` 翻译
- 公开/私有开关使用现有 shadcn/ui `<Switch>` 组件
- Model 的 context 长度从 `model.limit` 字段提取（前端类型为 `unknown`，实现时需处理实际结构）
- 底部操作栏中"测试"仅在有可测试模型时显示

## 8. 不做

- 不改变 Provider/Model 的数据结构和 API
- 不改变 Test/Edit/Delete 的对话框逻辑
- 不改变搜索和过滤功能
- 不改变"添加模型"的交互流程（弹窗）
