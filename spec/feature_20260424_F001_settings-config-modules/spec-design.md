# Feature: 20260424_F001 - settings-config-modules

## 需求背景

RCS（remote-control-server）目前提供 Dashboard、Session、API Keys 三个页面，用户无法通过 Web UI 管理 OpenCode 的 AI 配置。用户只能通过 SSH 到服务器手动编辑 `opencode.json` 或操作文件系统。本 feature 为 RCS 添加 Settings 配置管理 API，让用户通过 Web UI 完成日常的配置调整。

底层 OpenCode 的配置体系包含 6 个层级（remote → global → custom → project → .opencode → inline），本 feature 仅操作全局配置层（`~/.config/opencode/config.json`），定位为个人开发者优先、兼顾团队场景。

## 目标

- 提供统一的 RESTful API 管理全局 OpenCode 配置（`~/.config/opencode/config.json`）
- 第一批覆盖 4 个模块：Providers（AI 服务商）、Models（模型选择）、Agents（Agent配置）、Skills（技能管理）
- 仅暴露 API 层，UI 组件由后续 feature 实现
- 与 OpenCode CLI 行为一致：用户在 CLI 和 Web UI 之间切换无状态冲突

## 方案设计

### 架构总览

RCS 作为 opencode.json 的 HTTP Agent层，直接读写文件系统。

![架构总览](./images/01-architecture.png)

```
Web UI / 第三方客户端
        │
        ▼
RCS API Server (Hono)
        │
        ├── ConfigService ←── 读写 ~/.config/opencode/config.json
        │                     文件锁保护并发写入
        │
        └── SkillService  ←── 操作 ~/.config/opencode/skills/ 文件系统
                              启用/禁用通过移动文件夹实现
```

**核心组件：**

| 组件 | 职责 |
|------|------|
| ConfigService | 读写 opencode.json，提供 `getSection()`、`setSection()`、`deleteSection()` 方法，按顶层 key 操作对应 section。写入时加文件级互斥锁 |
| SkillService | 操作 skills 目录文件系统。列出 skills、创建/删除 SKILL.md、在 `skills/` 和 `skills/_disabled/` 之间移动文件夹 |
| 路由层 | Hono 路由，挂载在 `/web/config/:module` 路径下，复用现有 better-auth 鉴权中间件 |

**数据流：**

1. 客户端 POST `/web/config/:module`
2. 鉴权中间件校验 session
3. 路由层解析 `action` 字段，调用 ConfigService / SkillService
4. Service 层操作文件系统
5. 返回 JSON 响应

**配置文件约定：**

- 全局配置路径：`~/.config/opencode/config.json`
- 配置文件不存在时返回空默认值（不自动创建文件）
- 写入时保留 JSONC 注释（如原文件有注释）

### 通用 API 规范

**基础路径：** `POST /web/config/:module`

`:module` 取值：`providers` | `models` | `agents` | `skills`

**请求格式：**

```jsonc
{
  "action": "list" | "get" | "set" | "delete" | "create" | "test" | "enable" | "disable",
  // 其余字段按 action 和 module 不同而不同
}
```

**响应格式：**

```jsonc
// 成功
{ "success": true, "data": { ... } }

// 失败
{ "success": false, "error": { "code": "NOT_FOUND", "message": "Provider 'ollama' not found" } }
```

**错误码：**

| 错误码 | 含义 |
|--------|------|
| `NOT_FOUND` | 请求的资源不存在 |
| `ALREADY_EXISTS` | 创建时资源已存在 |
| `VALIDATION_ERROR` | 请求数据校验失败 |
| `CONFIG_READ_ERROR` | 配置文件读取失败 |
| `CONFIG_WRITE_ERROR` | 配置文件写入失败（含锁超时） |
| `FORBIDDEN` | 内置资源不可删除/修改 |

**鉴权：** 所有 `/web/config/*` 端点复用现有 better-auth session 中间件。

### Providers 模块

对应 opencode.json 中的 `provider` section。

```jsonc
// opencode.json 存储结构
{
  "provider": {
    "anthropic": {
      "apiKey": "{env:ANTHROPIC_API_KEY}",
      "baseURL": "https://api.anthropic.com",
      "timeout": 60000
    },
    "openai": {
      "apiKey": "{env:OPENAI_API_KEY}"
    }
  }
}
```

**API 接口：**

```jsonc
// 列出所有已配置的服务商
POST /web/config/providers
{ "action": "list" }
→ {
    "success": true,
    "data": {
      "providers": [
        { "name": "anthropic", "configured": true, "keyHint": "***ab12", "baseURL": "https://api.anthropic.com" },
        { "name": "openai", "configured": true, "keyHint": "***xy78", "baseURL": "默认" }
      ]
    }
  }

// 获取单个服务商详情
POST /web/config/providers
{ "action": "get", "name": "anthropic" }
→ {
    "success": true,
    "data": {
      "name": "anthropic",
      "apiKey": "{env:ANTHROPIC_API_KEY}",
      "baseURL": "https://api.anthropic.com",
      "timeout": 60000,
      "keyHint": "***ab12"
    }
  }

// 设置服务商配置（创建或更新）
POST /web/config/providers
{
  "action": "set",
  "name": "anthropic",
  "data": {
    "apiKey": "sk-ant-real-key-here",
    "baseURL": "https://api.anthropic.com",
    "timeout": 60000
  }
}
→ { "success": true, "data": { "name": "anthropic", "keyHint": "***here" } }

// 测试服务商连接
POST /web/config/providers
{ "action": "test", "name": "anthropic" }
→ { "success": true, "data": { "models": ["claude-sonnet-4-6", "claude-opus-4-7"] } }

// 删除服务商
POST /web/config/providers
{ "action": "delete", "name": "ollama" }
→ { "success": true }
```

**API Key 安全策略：**

- 用户通过 `set` 提交的明文 API Key，服务端替换为 `{env:RCS_SECRET_<provider_name>}` 存入 opencode.json
- 实际密钥值存入环境变量（RCS 进程的 `.env` 或系统环境变量）
- `get` 和 `list` 接口只返回 `keyHint`（尾 4 位），不返回原文或变量引用

### Models 模块

对应 opencode.json 中的 `model` 和 `small_model` 顶层字段。

```jsonc
// opencode.json 存储结构
{
  "model": "claude-sonnet-4-6",
  "small_model": "claude-haiku-4-5"
}
```

**API 接口：**

```jsonc
// 获取当前模型配置 + 可用模型列表
POST /web/config/models
{ "action": "get" }
→ {
    "success": true,
    "data": {
      "current": {
        "model": "claude-sonnet-4-6",
        "small_model": "claude-haiku-4-5"
      },
      "available": [
        { "id": "claude-sonnet-4-6", "provider": "anthropic", "label": "Claude Sonnet 4.6" },
        { "id": "claude-opus-4-7", "provider": "anthropic", "label": "Claude Opus 4.7" },
        { "id": "gpt-4o", "provider": "openai", "label": "GPT-4o" }
      ]
    }
  }

// 设置主模型和/或轻量模型
POST /web/config/models
{
  "action": "set",
  "data": {
    "model": "claude-opus-4-7",
    "small_model": "claude-sonnet-4-6"
  }
}
→ { "success": true, "data": { "model": "claude-opus-4-7", "small_model": "claude-sonnet-4-6" } }

// 刷新可用模型列表
POST /web/config/models
{ "action": "refresh" }
→ { "success": true, "data": { "count": 12 } }
```

**注意事项：**

- `available` 列表来自各 provider 的模型查询接口，需要缓存避免每次 get 都查询
- `set` 接受部分更新：只传 `model` 或只传 `small_model` 都可以
- 设置的 model ID 不在 available 列表中时仍然允许设置（用户可能使用未列出的模型）

### Agents 模块

对应 opencode.json 中的 `agent` section 和 `default_agent` 顶层字段。

```jsonc
// opencode.json 存储结构
{
  "default_agent": "build",
  "agent": {
    "build": {
      "model": "claude-sonnet-4-6",
      "prompt": "You are a coding assistant...",
      "tools": ["bash", "edit", "read", "glob", "grep"],
      "steps": 50,
      "mode": "primary"
    },
    "code-reviewer": {
      "model": "claude-sonnet-4-6",
      "prompt": "你是代码审查专家...",
      "tools": ["read", "glob", "grep"],
      "steps": 30,
      "mode": "subagent"
    }
  }
}
```

**内置 Agent：** `build`、`plan`、`general`、`explore`、`title`、`summary`、`compaction`

**API 接口：**

```jsonc
// 列出所有 Agent
POST /web/config/agents
{ "action": "list" }
→ {
    "success": true,
    "data": {
      "default_agent": "build",
      "agents": [
        { "name": "build", "builtIn": true, "model": "claude-sonnet-4-6", "mode": "primary" },
        { "name": "plan", "builtIn": true, "model": "claude-sonnet-4-6", "mode": "subagent" },
        { "name": "code-reviewer", "builtIn": false, "model": "claude-sonnet-4-6", "mode": "subagent" }
      ]
    }
  }

// 获取单个 Agent 详情
POST /web/config/agents
{ "action": "get", "name": "build" }
→ {
    "success": true,
    "data": {
      "name": "build",
      "builtIn": true,
      "model": "claude-sonnet-4-6",
      "prompt": "You are a coding assistant...",
      "tools": ["bash", "edit", "read", "glob", "grep"],
      "steps": 50,
      "mode": "primary",
      "permission": null
    }
  }

// 更新 Agent（内置 Agent 可修改配置但不可删除）
POST /web/config/agents
{
  "action": "set",
  "name": "build",
  "data": { "model": "claude-opus-4-7", "steps": 100 }
}
→ { "success": true, "data": { "name": "build", "model": "claude-opus-4-7", "steps": 100 } }

// 创建自定义 Agent
POST /web/config/agents
{
  "action": "create",
  "name": "code-reviewer",
  "data": {
    "model": "claude-sonnet-4-6",
    "prompt": "你是代码审查专家，专注于发现潜在 bug 和安全问题...",
    "tools": ["read", "glob", "grep"],
    "steps": 30,
    "mode": "subagent"
  }
}
→ { "success": true, "data": { "name": "code-reviewer" } }

// 删除自定义 Agent（内置 Agent 返回 FORBIDDEN）
POST /web/config/agents
{ "action": "delete", "name": "code-reviewer" }
→ { "success": true }

// 设置默认 Agent
POST /web/config/agents
{ "action": "set_default", "name": "build" }
→ { "success": true, "data": { "default_agent": "build" } }
```

**字段校验规则：**

- `name`：1-64 字符，小写字母 + 数字 + 单连字符，不以连字符开头或结尾，不含 `--`
- `mode`：枚举值 `primary` | `subagent` | `all`
- `steps`：正整数，范围 1-200
- `tools`：字符串数组，每个元素为 OpenCode 支持的工具名

### Skills 模块

采用文件系统操作，通过移动文件夹控制启用/禁用。不读写 opencode.json。

**目录结构：**

```
~/.config/opencode/skills/
  ├── pr-review/              ← 已启用
  │   └── SKILL.md
  ├── deploy/                 ← 已启用
  │   └── SKILL.md
  └── _disabled/              ← 禁用的 skill 存放处（RCS 自动管理）
      └── legacy-review/
          └── SKILL.md
```

**SKILL.md 格式：**

```markdown
---
name: pr-review
description: 审查 Pull Request 的代码质量和安全性
license: MIT
compatibility: ">=1.0.0"
---

# PR Review

你是一个专业的代码审查助手...
```

**API 接口：**

```jsonc
// 列出所有 skill（含启用/禁用状态）
POST /web/config/skills
{ "action": "list" }
→ {
    "success": true,
    "data": {
      "skills": [
        { "name": "pr-review", "enabled": true, "description": "审查 Pull Request", "path": "~/.config/opencode/skills/pr-review/SKILL.md" },
        { "name": "deploy", "enabled": true, "description": "部署助手", "path": "~/.config/opencode/skills/deploy/SKILL.md" },
        { "name": "legacy-review", "enabled": false, "description": "旧版审查", "path": "~/.config/opencode/skills/_disabled/legacy-review/SKILL.md" }
      ]
    }
  }

// 获取 skill 内容
POST /web/config/skills
{ "action": "get", "name": "pr-review" }
→ {
    "success": true,
    "data": {
      "name": "pr-review",
      "description": "审查 Pull Request",
      "content": "# PR Review\n\n你是一个专业的代码审查助手...",
      "enabled": true,
      "path": "~/.config/opencode/skills/pr-review/SKILL.md",
      "metadata": { "license": "MIT", "compatibility": ">=1.0.0" }
    }
  }

// 禁用 skill → 移入 _disabled/
POST /web/config/skills
{ "action": "disable", "name": "pr-review" }
→ { "success": true, "data": { "name": "pr-review", "enabled": false } }

// 启用 skill → 移回 skills/
POST /web/config/skills
{ "action": "enable", "name": "legacy-review" }
→ { "success": true, "data": { "name": "legacy-review", "enabled": true } }

// 创建/更新 skill
POST /web/config/skills
{
  "action": "set",
  "name": "custom-review",
  "data": {
    "description": "自定义审查流程",
    "content": "# Custom Review\n\n你是一个...",
    "metadata": { "license": "MIT" }
  }
}
→ { "success": true, "data": { "name": "custom-review", "enabled": true } }

// 删除 skill（彻底删除文件夹）
POST /web/config/skills
{ "action": "delete", "name": "custom-review" }
→ { "success": true }
```

**特殊规则：**

- `_disabled` 目录由 RCS 自动创建和管理，对用户透明
- 同名 skill 不允许同时存在于 `skills/` 和 `_disabled/` 中
- 删除操作不可逆，前端应二次确认
- `set` 操作如果 name 已存在则覆盖内容（无论启用/禁用状态）

### 端点汇总

```
POST /web/config/providers     → AI 服务商管理（list/get/set/test/delete）
POST /web/config/models        → 模型选择（get/set/refresh）
POST /web/config/agents        → Agent 配置（list/get/set/create/delete/set_default）
POST /web/config/skills        → Skill 管理（list/get/set/delete/enable/disable）
```

## 实现要点

1. **ConfigService 文件锁**：使用 `proper-lockfile` 或类似库对 config.json 加互斥锁，防止并发写入导致数据损坏。锁超时设为 5 秒。

2. **配置合并策略**：`set` 操作采用深度合并（deep merge），只更新传入的字段，不清空未传入的字段。RCS 只操作全局配置文件，不触碰项目级和远程层级。

3. **Provider 连接测试**：`test` action 需要实际调用 provider API（如 Anthropic 的 `/v1/models` 端点）。超时设为 10 秒，失败返回具体错误信息。

4. **Skill 文件操作原子性**：移动文件夹使用 `fs.rename()`（同文件系统下是原子操作）。如果跨文件系统则回退到 `copy + delete`。

5. **变量替换透明性**：opencode.json 中的 `{env:VAR_NAME}` 语法由 OpenCode 运行时解析。RCS 不解析这些变量，只原样读写。Provider 的 `keyHint` 通过正则提取变量名来判断是否已配置。

6. **API Key 安全**：明文 Key 存入环境变量，opencode.json 中存为 `{env:RCS_SECRET_<provider>}` 引用。API 响应只返回 `keyHint`。

## 验收标准

- [ ] 所有 4 个模块的 CRUD API 可通过 curl 测试通过
- [ ] opencode.json 的读写不影响 OpenCode CLI 的正常使用
- [ ] Provider test action 能正确返回模型列表或连接错误
- [ ] Skill enable/disable 通过文件夹移动实现，OpenCode CLI 能正确发现/忽略
- [ ] 并发写入不会导致配置文件损坏
- [ ] 内置 Agent 不可删除，自定义 Agent 可完整 CRUD
- [ ] API Key 明文不出现在 API 响应中，只返回 keyHint
- [ ] 配置文件不存在时返回空默认值而非报错
