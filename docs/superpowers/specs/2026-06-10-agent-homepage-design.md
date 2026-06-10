# Agent 首页设计文档

**日期**: 2026-06-10
**状态**: 已确认

## 概述

新增 Agent 首页（`/agent/home`），作为用户创建智能体的入口。页面采用全铺满沉浸式布局，提供两种创建方式：AI 智能生成（输入描述 → AI 结构化输出 → 确认创建）和模板一键创建。

## 路由与导航

- 路由：`/agent/home`，对应文件 `web/src/routes/agent/_panel/home.tsx`
- 入口：左上角 logo icon 点击导航到首页，无 sidebar 导航项
- 首页在 agent panel 布局内，复用 `AgentSidebar` 等布局组件

## 交互流程

### 流程 A：AI 智能生成

1. 用户在居中输入框描述需求，按 Enter
2. 前端调用 `POST /web/agent-generation`，输入框区域下方展开 loading 状态
3. 后端查 skills → 调 LLM → 映射结果 → 返回结构化 JSON（name, systemPrompt, skills）
4. 前端展示可编辑表单（名称、system prompt、skills 选择器），用户可修改后确认
5. 用户点击"创建智能体"，调用现有 `POST /web/config/agents` (action: create)
6. 创建成功后 navigate 到 `/agent/chat/{agentId}`

### 流程 B：模板一键创建

1. 用户点击模板卡片
2. 直接用模板数据（name + prompt + skills）调用 agent create API
3. 创建成功后 navigate 到 `/agent/chat/{agentId}`

## 后端设计

### 环境变量

新增三个环境变量，在 `src/env.ts` 的 `validateEnv()` 中注册：

- `RCS_GENERATION_MODEL_ENDPOINT` — OpenAI 协议 API endpoint
- `RCS_GENERATION_MODEL_KEY` — API Key
- `RCS_GENERATION_MODEL_NAME` — 模型名称（如 `gpt-4o-mini`）

### 接口定义

**`POST /web/agent-generation`**

路由文件：`src/routes/web/agent-generation.ts`，挂载到 `src/routes/web/index.ts`。
认证：`authGuardPlugin` + `requireOrgScope`。

请求体：
```typescript
{ prompt: string }
```

成功响应：
```typescript
{ success: true, data: { name: string, systemPrompt: string, skills: string[] } }
```

失败响应：
```typescript
{ success: false, error: { code: string, message: string } }
```

### 服务层

文件：`src/services/agent-generation.ts`

流程：
1. 调用现有 skill 查询接口获取当前组织所有可用 skills
2. 构建 LLM prompt，包含用户描述 + 可用 skills 列表（名称 + 描述）+ JSON 输出格式要求
3. 使用 OpenAI SDK（`openai` npm 包）调用模型，开启 `response_format: { type: "json_object" }`
4. 解析 LLM 返回 JSON，提取 name、systemPrompt、skills（技能名称数组）
5. 将技能名称映射为真实 skill ID（精确匹配优先，匹配不到的跳过）
6. 返回结构化结果

错误处理：
- 环境变量未配置：返回 `{ success: false, error: { code: "NOT_CONFIGURED", message: "..." } }`
- LLM 调用失败：返回 `{ success: false, error: { code: "LLM_ERROR", message: "..." } }`
- LLM 输出解析失败：返回 `{ success: false, error: { code: "PARSE_ERROR", message: "..." } }`

## 前端设计

### 视觉风格

- **全铺满沉浸式背景**：青蓝薄荷渐变（`#f0fdfa → #ecfeff → #f0f9ff → #ecfdf5`），背景散布装饰光斑
- **标题**：纯色 `#0891b2`，font-weight 800，letter-spacing 2px。三条文案随机显示：
  - "打造专属 Agent"
  - "一句话，召唤 Agent"
  - "一声令下，Agent 出发"
- **标题波浪装饰**：标题文字下方紧贴一条 SVG 正弦波浪线（A1 高度：margin-top -2px），颜色为青→翠→金渐变（`#0891b2 → #0d9488 → #d97706`，opacity 0.5/0.4），stroke-width 2.33，stroke-linecap round
- **副标题**："说一句话，剩下的交给 Agent"，纯色 `#9ca3af`（阶段 3 隐藏副标题）
- **阶段 2（生成中）**：输入框锁定显示用户输入，下方展开半透明玻璃拟态 loading 卡片（旋转动画 + "Agent 正在分析你的需求..." + "正在匹配最佳 Skills 和配置"）
- **阶段 3（表单确认）**：输入框变为可编辑（带"✎ 编辑"按钮），下方展开表单卡片（名称 input / System Prompt textarea / Skills 标签组带删除和添加 / 青绿渐变"创建 Agent"按钮），副标题隐藏
- **输入框**：白底（`rgba(255,255,255,0.92)`）+ 流光渐变边框（蓝→青→翠→金，2s 循环）+ 彩色阴影流光。文字无渐变，placeholder 和提示文字均为 `#9ca3af`
- **模板卡片**：左侧 lucide 图标（渐变色方块 + 白色图标 + 彩色投影）+ 右侧文字，半透明白底玻璃拟态
- **图标色系**：青 `#0891b2`、翠绿 `#0d9488`、琥珀 `#d97706`、蓝 `#2563eb`、翡翠 `#059669`、天蓝 `#0284c7`
- **禁止紫色**

### 组件结构

- `web/src/routes/agent/_panel/home.tsx` — 路由文件，lazy import 页面组件
- `web/src/pages/agent-panel/pages/AgentHomePage.tsx` — 主页面组件，独立 tsx
  - 管理三个状态阶段：idle → generating → form
  - 加载模板列表（通过 `agentApi` 调用 `/web/config/agents` action: `templates`）
  - 模板点击直接创建并跳转
- `web/src/pages/agent-panel/components/AgentGenerationForm.tsx` — AI 生成后的可编辑表单组件
  - 接收 AI 结果作为初始值
  - 包含名称、system prompt、skills 选择器
  - "创建智能体"按钮

### i18n

新增命名空间 `agentHome`，翻译文件：
- `web/src/i18n/locales/en/agentHome.json`
- `web/src/i18n/locales/zh/agentHome.json`

在 `web/src/i18n/index.ts` 中注册。

标题文案需 i18n 化（三条随机标题和副标题均走 `t()`）。

## 文件清单

### 新增文件

| 文件 | 说明 |
|------|------|
| `web/src/routes/agent/_panel/home.tsx` | 路由文件 |
| `web/src/pages/agent-panel/pages/AgentHomePage.tsx` | 首页页面组件 |
| `web/src/pages/agent-panel/components/AgentGenerationForm.tsx` | 生成表单组件 |
| `src/routes/web/agent-generation.ts` | 后端路由 |
| `src/services/agent-generation.ts` | 后端服务（LLM 调用 + skills 映射） |
| `web/src/i18n/locales/en/agentHome.json` | 英文翻译 |
| `web/src/i18n/locales/zh/agentHome.json` | 中文翻译 |

### 修改文件

| 文件 | 说明 |
|------|------|
| `src/routes/web/index.ts` | 注册新路由 `/agent-generation` |
| `src/env.ts` | 新增三个环境变量 |
| `web/src/i18n/index.ts` | 注册 `agentHome` 命名空间 |
| 左上角 logo 组件 | 添加点击导航到 `/agent/home` |

## 依赖

- 新增 npm 依赖：`openai`（OpenAI SDK）
