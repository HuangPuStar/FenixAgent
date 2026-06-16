# AgentBadge 双模式扩展设计文档

**日期**: 2026-06-15
**状态**: 已实现

## 概述

将 `AgentBadge` 组件从聊天空状态纯展示组件扩展为支持管理页卡片渲染的双模式组件。通过在现有 props 上追加可选参数，实现同一组件在 ChatView（空状态）和 AgentManagementPage（管理卡片）两处复用，统一智能体卡片的视觉风格。

## 最终设计

### 工牌尺寸

| 属性 | 原值 | 新值 |
|------|------|------|
| 宽度 | 280px | 224px |
| 最小高度 | 420px | 340px |
| header padding | 32px 20px 44px | 24px 18px 32px |
| avatar | 64px, margin-top -40px | 50px, margin-top -30px |
| 名字字号 | 16px, weight 600 | 13px, weight 700 |
| 描述字号 | 12px | 10px |
| body padding | 0 24px | 0 20px |
| divider margin | 0 24px | 0 20px |
| skills padding | 14px 24px 24px | 10px 20px 18px |
| actions padding | 14px 24px 18px | 10px 20px 14px |

### Props

```typescript
export function AgentBadge({
  name,           // Agent 名（不含来源组织前缀）
  description,
  skills,         // AgentSkillInfo[]
  sourceOrg,      // 新增：外部 Agent 来源组织名，灰字小写显示在名字上方
  onEnter,        // 管理模式：进入对话回调
  onEdit,         // 管理模式：编辑回调
  isBusy,         // 按钮 loading 态
}: {
  name: string;
  description?: string;
  skills: AgentSkillInfo[];
  sourceOrg?: string;
  onEnter?: () => void;
  onEdit?: () => void;
  isBusy?: boolean;
})
```

### 渲染逻辑

**管理模式激活条件**：`onEnter`、`onEdit` 任一存在。

| 区域 | 空状态模式（ChatView） | 管理模式（AgentManagementPage） |
|------|----------------------|-------------------------------|
| Header | 蓝色渐变，AGENT tag | 不变 |
| 来源组织 | 无 | `sourceOrg` 存在时灰字 9px uppercase 显示在名字上方 |
| Skills | 可点击（`chat:inject-skill`），有 label + hint | 不可点击，无 label，无 hint |
| 底部 | 无 | 进入对话（#1677ff）+ 编辑（白底灰框），26px 高 |

### 按钮规格

- 高度 26px，圆角 6px，字号 10px，字重 600
- 进入对话：`background: #1677ff`，白色文字，`MessageSquare` 图标 11px
- 编辑：`border: 1px solid #d9e2ee`，白色背景，`#65748a` 文字，`Pencil` 图标 11px
- 间距 4px

### AgentManagementPage 改动

**替换前**：自定义 `<article>` 卡片。

**替换后**：
```tsx
<AgentBadge
  name={agent.name}
  description={agent.description || undefined}
  skills={agent.skillLabels ?? []}
  sourceOrg={agent.resourceAccess?.sourceOrganizationName}
  onEnter={() => void handleEnterAgent(node)}
  onEdit={writable ? () => setEditAgentName(getAgentConfigLookupKey(agent)) : undefined}
  isBusy={enteringId === agent.id}
/>
```

**移除**：`AgentInitial`、`CARD_ACCENTS`、`getStatus`、`handleDeleteAgent`、`deletingId`、`getSkillCount`、卡片内联样式

**网格**：`grid-cols-[repeat(auto-fill,224px)] gap-5`

### 不变的组件

| 组件 | 状态 |
|------|------|
| `AgentBadgeSkeleton` | 骨架同步缩小 |
| `ChatView.tsx` | 零改动 |
| `AgentSidebar.tsx` | 不变 |

## 文件清单

| 文件 | 改动 |
|------|------|
| `web/components/chat/AgentBadge.tsx` | +sourceOrg prop，拆分 name 渲染，移除 status chip |
| `web/src/pages/agent-panel/pages/AgentManagementPage.tsx` | 卡片替换为 AgentBadge，清理 -112 行 |
| `web/src/index.css` | 缩小 badge 尺寸，新增 source/actions/skill-tag-static 样式，移除 status-chip 样式 |
| `web/src/i18n/locales/zh/components.json` | 新增 agentBadge.enterChat/edit |
| `web/src/i18n/locales/en/components.json` | 同上英文 |
