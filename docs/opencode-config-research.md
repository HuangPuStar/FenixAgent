# OpenCode 配置系统研究报告

> 研究目标：为 remote-control-server 后续开发 OpenCode 配置操控 API 提供参考

## 1. 配置文件格式

- **文件名**: `opencode.json`（支持 JSON/JSONC 注释）
- **Schema**: `https://opencode.ai/config.json`
- **用途**: 定义 AI 编码Agent的 provider、model、agent、MCP、权限等全部行为

## 2. 配置文件层级与合并

OpenCode 按 6 个层级加载配置，**低优先级值被高优先级覆盖，而非替换整个文件**：

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 (最低) | remote | 远程配置服务 |
| 2 | global | `~/.config/opencode/config.json` |
| 3 | custom | 用户自定义路径 |
| 4 | project | 项目根目录 `opencode.json` |
| 5 | `.opencode/` | `.opencode/config.json` |
| 6 (最高) | inline | 命令行参数或 API 调用时传入 |

## 3. 顶层配置项一览

```
$schema              - JSON Schema URI
logLevel             - 日志级别
server               - 服务器模式配置 (host, port, auth)
command              - 自定义 CLI 命令
skills               - 技能定义
watcher              - 文件监控配置
snapshot             - 快照配置
plugin               - 插件配置
share                - 分享功能配置
autoupdate           - 自动更新
disabled_providers   - 禁用的 provider 列表
enabled_providers    - 启用的 provider 列表
model                - 默认模型
small_model          - 小模型（用于摘要等轻量任务）
default_agent        - 默认 agent
username             - 用户名
agent                - Agent 定义（见第 4 节）
provider             - Provider 定义（见第 5 节）
mcp                  - MCP 服务器配置（见第 6 节）
formatter            - 代码格式化器配置
lsp                  - Language Server Protocol 配置
instructions         - 全局指令/系统提示
permission           - 权限配置（见第 7 节）
tools                - 工具配置
enterprise           - 企业功能配置
compaction           - 上下文压缩配置
experimental         - 实验性功能开关
```

## 4. Agent 系统

### 内置 Agent

| 名称 | 用途 |
|------|------|
| `build` | 代码构建/修改 |
| `plan` | 规划分析 |
| `general` | 通用任务 |
| `explore` | 代码探索 |
| `title` | 生成会话标题 |
| `summary` | 生成会话摘要 |
| `compaction` | 上下文压缩 |

### Agent 配置结构

```jsonc
{
  "agent": {
    "my-agent": {
      "model": "claude-sonnet-4-6",       // 使用的模型
      "prompt": "You are a ...",           // 系统提示
      "tools": ["bash", "edit", "read"],   // 可用工具列表
      "steps": 50,                         // 最大执行步数
      "mode": "subagent",                  // subagent | primary | all
      "permission": { ... }                // 该 agent 的权限覆盖
    }
  }
}
```

## 5. Provider 系统

支持多 provider，每个 provider 可独立配置：

```jsonc
{
  "provider": {
    "anthropic": {
      "apiKey": "{env:ANTHROPIC_API_KEY}",  // 支持变量替换
      "baseURL": "https://api.anthropic.com",
      "timeout": 60000,
      "setCacheKey": true,
      "chunkTimeout": 30000
    },
    "openai": {
      "apiKey": "{env:OPENAI_API_KEY}",
      "baseURL": "https://api.openai.com/v1"
    }
    // 还支持: amazon-bedrock, google-vertex, azure, ollama, etc.
  }
}
```

### Provider 选项

| 字段 | 类型 | 说明 |
|------|------|------|
| `apiKey` | string | API 密钥，支持变量替换 |
| `baseURL` | string | 自定义 API 端点 |
| `timeout` | number | 请求超时(ms) |
| `setCacheKey` | boolean | 启用缓存键 |
| `chunkTimeout` | number | 流式分块超时(ms) |

## 6. MCP (Model Context Protocol) 配置

支持本地和远程两种 MCP 服务器：

```jsonc
{
  "mcp": {
    "my-local-mcp": {
      "command": "npx",
      "args": ["-y", "@my/mcp-server"],
      "env": {
        "API_KEY": "{env:MY_API_KEY}"
      },
      "type": "local"  // 本地进程模式
    },
    "my-remote-mcp": {
      "url": "https://mcp.example.com/sse",
      "headers": {
        "Authorization": "Bearer {env:MCP_TOKEN}"
      },
      "type": "remote"  // 远程 URL 模式
    }
  }
}
```

## 7. 权限系统

嵌套结构，按工具类型分别配置 ask/allow/deny：

```jsonc
{
  "permission": {
    "bash": {
      "allow": ["git status", "npm test"],
      "deny": ["rm -rf *"]
    },
    "edit": {
      "allow": ["src/**"],
      "deny": ["**/.env*"]
    },
    "read": { "allow": ["**"] },
    "write": { "deny": ["**/secrets/**"] },
    "glob": { "allow": ["**"] },
    "grep": { "allow": ["**"] }
    // 还有: list, task, webfetch, websearch, mcp:*
  }
}
```

支持通配符模式 (`**`, `*`)，deny 优先于 allow。

## 8. 变量替换

配置值中可使用变量替换语法：

| 语法 | 含义 | 示例 |
|------|------|------|
| `{env:VAR_NAME}` | 环境变量 | `{env:ANTHROPIC_API_KEY}` |
| `{file:path}` | 文件内容 | `{file:/path/to/key.pem}` |

## 9. CLI 命令

OpenCode 提供的 CLI 命令，部分与配置操控相关：

| 命令 | 说明 |
|------|------|
| `opencode tui` | 终端交互界面 |
| `opencode run` | 非交互执行 |
| `opencode serve` | 启动 HTTP API 服务 |
| `opencode web` | 启动 Web UI |
| `opencode agent` | 列出/管理 agent |
| `opencode auth` | 认证管理 |
| `opencode mcp` | MCP 服务器管理 |
| `opencode models` | 列出可用模型 |
| `opencode session` | 会话管理 |
| `opencode import/export` | 配置导入导出 |

### 环境变量

| 变量 | 说明 |
|------|------|
| `OPENCODE_CONFIG` | 自定义配置文件路径 |
| `OPENCODE_HOME` | 数据目录（默认 `~/.local/share/opencode`） |
| `OPENCODE_DISABLE_TELEMETRY` | 禁用遥测 |

## 10. Server 模式

`opencode serve` 提供 HTTP API，支持 basic auth：

```jsonc
{
  "server": {
    "host": "0.0.0.0",
    "port": 3000,
    "auth": {
      "username": "admin",
      "password": "{env:SERVER_PASSWORD}"
    }
  }
}
```

## 11. `.opencode` 目录结构

项目级配置目录 `.opencode/` 可包含：

```
.opencode/
├── config.json        # 项目级配置（最高文件优先级）
├── instructions.md    # 项目级指令
├── skills/            # 自定义技能
│   └── *.md
└── agents/            # 自定义 agent 定义
    └── *.md
```

## 12. API 设计：从用户看到的页面出发

### 现有产品页面

```
Sidebar:
  ├── Dashboard      → Agent 列表 + Session 列表
  ├── Session        → 单个会话对话界面
  ├── API Keys       → 密钥管理
  └── Logout         → 用户邮箱 + 退出
```

### 新增 Settings 页面

用户在 Sidebar 看到一个齿轮图标（Settings），点击进入配置中心。配置中心用顶部标签页切换：

```
Settings
  ├── AI 服务商      → 我用的是哪家的 AI？Key 填了没？
  ├── 模型选择       → 用哪个模型干活？摘要用什么小模型？
  ├── Agent 配置     → 有哪些 Agent？各自的行为怎么定？
  ├── MCP 工具       → 接了哪些外部工具？连没连上？
  ├── 权限与安全     → Agent 能做什么、不能做什么？
  └── 全局指令       → 给所有 Agent 的通用规矩
```

### 统一接口格式

所有接口 POST，`action` 字段区分意图：

```jsonc
// 请求
POST /web/config/:page          // :page = providers | models | agents | mcp | permissions | instructions
{
  "action": "get" | "set" | "delete" | "test" | "list" | "create",
  // 以下按页面不同而不同
}

// 响应
{
  "success": true,
  "data": { ... }
}
```

### 页面 1：AI 服务商

用户看到的：一张卡片列表，每个卡片是 Anthropic、OpenAI、Ollama... 显示状态和 Key 尾号。

```jsonc
POST /web/config/providers

// 打开页面 → 加载所有服务商
{ "action": "list" }
→ [
    { "name": "anthropic", "configured": true, "keyHint": "sk-ant-***ab12", "baseURL": "默认" },
    { "name": "openai", "configured": false },
    { "name": "ollama", "configured": false }
  ]

// 用户填写 API Key → 保存（服务端加密存储，配置文件中替换为 {env:RCS_SECRET_xxx}）
{ "action": "set", "name": "anthropic", "data": { "apiKey": "sk-ant-real-key" } }
→ { "name": "anthropic", "configured": true, "keyHint": "sk-ant-***ab12" }

// 用户点「测试连接」
{ "action": "test", "name": "anthropic" }
→ { "success": true, "models": ["claude-sonnet-4-6", "claude-opus-4-7"] }

// 用户删除服务商
{ "action": "delete", "name": "anthropic" }
```

### 页面 2：模型选择

用户看到的：两个下拉框 —— 「主模型」和「轻量模型」，选项来自已配置的 provider。

```jsonc
POST /web/config/models

// 打开页面
{ "action": "get" }
→ {
    "current": { "model": "claude-sonnet-4-6", "small_model": "claude-haiku-4-5" },
    "available": [
      { "id": "claude-sonnet-4-6", "provider": "anthropic", "label": "Claude Sonnet 4.6" },
      { "id": "gpt-4o", "provider": "openai", "label": "GPT-4o" }
    ]
  }

// 用户切换模型 → 保存
{ "action": "set", "data": { "model": "claude-opus-4-7", "small_model": "claude-haiku-4-5" } }
```

### 页面 3：Agent 配置

用户看到的：Agent 列表（内置 + 自定义），点进去可以改行为。

```jsonc
POST /web/config/agents

// 列出所有 Agent
{ "action": "list" }
→ [
    { "name": "build", "builtIn": true, "model": "claude-sonnet-4-6" },
    { "name": "plan", "builtIn": true, "model": "claude-sonnet-4-6" },
    { "name": "my-custom", "builtIn": false, "model": "gpt-4o" }
  ]

// 点进某个 Agent → 获取详情
{ "action": "get", "name": "build" }
→ { "model": "claude-sonnet-4-6", "prompt": "...", "tools": ["bash","edit"], "steps": 50, "mode": "primary" }

// 修改 Agent → 保存
{ "action": "set", "name": "build", "data": { "model": "claude-opus-4-7", "steps": 100 } }

// 新建自定义 Agent
{ "action": "create", "name": "code-reviewer", "data": { "model": "claude-sonnet-4-6", "prompt": "你是代码审查专家...", "tools": ["read","glob","grep"] } }

// 删除自定义 Agent（内置不可删）
{ "action": "delete", "name": "my-custom" }
```

### 页面 4：MCP 工具

用户看到的：已连接的外部工具列表，每个显示名称、类型、连接状态。

```jsonc
POST /web/config/mcp

// 列出所有 MCP 服务器
{ "action": "list" }
→ [
    { "name": "filesystem", "type": "local", "status": "connected" },
    { "name": "github", "type": "remote", "url": "https://...", "status": "connected" },
    { "name": "database", "type": "local", "status": "error", "error": "connection refused" }
  ]

// 添加 MCP
{ "action": "create", "name": "notion", "data": { "type": "remote", "url": "https://mcp.notion.com/sse", "headers": { "Authorization": "Bearer xxx" } } }

// 测试连接
{ "action": "test", "name": "notion" }
→ { "success": true, "tools": ["search_pages", "create_page"] }

// 更新
{ "action": "set", "name": "notion", "data": { "url": "https://mcp.notion.com/v2/sse" } }

// 删除
{ "action": "delete", "name": "notion" }
```

### 页面 5：权限与安全

用户看到的：按工具分组的权限规则表。每行是：工具名 → 允许 → 拒绝。

```jsonc
POST /web/config/permissions

// 获取当前权限
{ "action": "get" }
→ {
    "rules": [
      { "tool": "bash", "allow": ["git *", "npm *"], "deny": ["rm -rf *"] },
      { "tool": "edit", "allow": ["src/**"], "deny": ["**/.env*"] }
    ],
    "allTools": ["bash", "edit", "write", "read", "glob", "grep", "list", "task"]
  }

// 修改权限 → 整体保存
{ "action": "set", "data": {
    "bash": { "allow": ["git *", "npm *", "bun *"], "deny": ["rm -rf *"] },
    "edit": { "allow": ["src/**", "web/**"], "deny": ["**/.env*"] }
  } }
```

### 页面 6：全局指令

用户看到的：一个编辑框，写的内容成为所有 Agent 的通用指令。

```jsonc
POST /web/config/instructions

{ "action": "get" }
→ { "instructions": "你是一个专业的全栈工程师..." }

{ "action": "set", "data": { "instructions": "新的指令内容..." } }
```

### 端点汇总

```
POST /web/config/providers     → AI 服务商管理
POST /web/config/models        → 模型选择
POST /web/config/agents        → Agent 配置
POST /web/config/mcp           → MCP 工具管理
POST /web/config/permissions   → 权限规则
POST /web/config/instructions  → 全局指令
```

每个端点通过 `action` 字段（`get/set/delete/test/list/create`）区分操作。

## 13. Skill 远程配置统一问题

### 现状

OpenCode 的 skill 是 `SKILL.md` 文件，发现路径有四层：

| 层级 | 路径 | 说明 |
|------|------|------|
| 内置 | OpenCode 自带 | 不可修改 |
| 全局 | `~/.config/opencode/skills/` | 用户手动放置 |
| 项目 | `.opencode/skills/` / `.claude/skills/` / `~/.agents/skills/` | 团队共享（Git） |
| 远程 | `.well-known/opencode` + opencode-remote-config 插件 | 组织级分发 |

官方没有提供统一的远程 skill 分发机制。`.well-known/opencode` 端点只支持 JSON 配置，不支持分发 `SKILL.md` 文件。社区方案 `opencode-remote-config` 通过 Git 仓库 + 软链接实现，但依赖插件安装且没有权限控制。

核心矛盾：skill 是文件而非 JSON 字段，无法直接套用 OpenCode 的 6 层配置合并机制（同名 skill 冲突而非合并）。

### 暂定方案：文件系统操作实现启用/禁用

通过移动 skill 文件夹来控制启用/禁用状态，无需修改 OpenCode 源码：

```
~/.config/opencode/skills/
  ├── pr-review/           ← 已启用的 skill
  │   └── SKILL.md
  ├── deploy/              ← 已启用的 skill
  │   └── SKILL.md
  └── _disabled/           ← 禁用的 skill 存放于此
      └── legacy-review/
          └── SKILL.md
```

**规则：**

- 启用：skill 文件夹在 `skills/` 根目录下 → OpenCode 正常发现
- 禁用：skill 文件夹移入 `skills/_disabled/` → OpenCode 忽略
- `SKILL.md` 命名规范：OpenCode 按目录名识别 skill，文件名固定为 `SKILL.md`

### API 设计

```jsonc
POST /web/config/skills

// 列出所有 skill（含状态）
{ "action": "list" }
→ {
    "skills": [
      { "name": "pr-review", "enabled": true, "source": "global",
        "description": "审查 Pull Request", "path": "~/.config/opencode/skills/pr-review/SKILL.md" },
      { "name": "deploy", "enabled": true, "source": "global",
        "description": "部署助手", "path": "~/.config/opencode/skills/deploy/SKILL.md" },
      { "name": "legacy-review", "enabled": false, "source": "global",
        "description": "旧版审查", "path": "~/.config/opencode/skills/_disabled/legacy-review/SKILL.md" }
    ]
  }

// 获取 skill 内容
{ "action": "get", "name": "pr-review" }
→ {
    "name": "pr-review",
    "description": "审查 Pull Request",
    "content": "# PR Review\n\n你是一个专业的代码审查助手...",
    "enabled": true,
    "path": "~/.config/opencode/skills/pr-review/SKILL.md"
  }

// 禁用 skill → 移入 _disabled/
{ "action": "disable", "name": "pr-review" }
→ { "name": "pr-review", "enabled": false }

// 启用 skill → 移回 skills/
{ "action": "enable", "name": "legacy-review" }
→ { "name": "legacy-review", "enabled": true }

// 创建/更新 skill（直接写 SKILL.md）
{ "action": "set", "name": "custom-review", "data": {
    "description": "自定义审查",
    "content": "# Custom Review\n\n你是一个..."
  }
}
→ { "name": "custom-review", "enabled": true, "path": "~/.config/opencode/skills/custom-review/SKILL.md" }

// 删除 skill（彻底删除文件夹）
{ "action": "delete", "name": "custom-review" }
→ { "success": true }

// 测试 skill 格式是否合法
{ "action": "validate", "data": { "content": "# My Skill\n\n..." } }
→ { "valid": true } 或 { "valid": false, "errors": ["name 超过 64 字符"] }
```

### Skill 权限配置

Skill 的权限通过 OpenCode 的 `permission` 配置控制（已在第 7 节覆盖），这里仅列出 skill 相关部分：

```jsonc
{
  "permission": {
    "skill": {
      "*": "allow",              // 默认允许所有 skill
      "internal-*": "deny",     // 禁止 internal- 前缀的 skill
      "pr-review": "ask"        // pr-review 需要用户确认
    }
  }
}
```

### 端点汇总（更新）

```
POST /web/config/providers     → AI 服务商管理
POST /web/config/models        → 模型选择
POST /web/config/agents        → Agent 配置
POST /web/config/mcp           → MCP 工具管理
POST /web/config/permissions   → 权限规则
POST /web/config/instructions  → 全局指令
POST /web/config/skills        → Skill 管理（启用/禁用/CRUD）
```

---
