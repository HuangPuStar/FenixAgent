# Feature: 20260425_F001 - permission-config-enhancement

## 需求背景

F001（settings-config-modules）和 F002（settings-ui）已实现 Settings 配置管理的 4 个模块（Providers/Models/Agents/Skills）的 API 和 UI。当前存在以下问题：

1. **权限体系过时** — Agent 使用 `tools` 字段（布尔型数组）控制工具访问，但 OpenCode 官方已将其标记为 deprecated，引入了更强大的 `permission` 字段（支持 ask/allow/deny 三态、通配符规则、按 skill 粒度控制）
2. **缺少 Skill 权限 UI** — 用户无法通过 Web UI 按 agent 粒度控制哪些 skill 可用
3. **Skills 存储路径分散** — Skills 存放在 `~/.config/opencode/skills/`，需统一迁移到 `~/.agents/skills/`
4. **Agent 配置字段不全** — 缺少 `variant`、`temperature`、`top_p`、`disable`、`hidden`、`color`、`description` 等官方支持的字段

分析 opencode.ai/config.json 的 JSON Schema 后，确认了 `PermissionConfig` 的完整结构，为本次升级提供了设计依据。

## 目标

1. **Skills 目录迁移** — 将 `~/.config/opencode/skills/` 迁移到 `~/.agents/skills/`，启动时自动迁移旧数据
2. **Permission 体系升级** — Agent 的工具配置从 `tools` 切换到 `permission`，与 opencode.ai 官方 Schema 对齐
3. **Agent Skill 权限 UI** — 在 Agent 编辑弹窗中新增 Permission Tab，支持按工具和 Skill 粒度配置权限
4. **Agent 新字段补充** — 补充 `variant`、`temperature`、`top_p`、`disable`、`hidden`、`color`、`description` 字段

## 方案设计

### 架构总览

![架构总览](./images/01-architecture.png)

```
Web UI (Agent 编辑弹窗)
  ├── Tab 1: 基础配置（现有 + 新字段）
  └── Tab 2: 权限配置 ← 新增
        ├── 工具权限编辑器
        └── Skill 权限列表
              │
              ▼
RCS API Server (Hono)
  ├── Agents API ← 读写 permission 字段，兼容 tools 转换
  └── Skills API ← 路径改为 ~/.agents/skills/
        │
        ▼
文件系统
  ├── ~/.config/opencode/config.json  ← permission 对象存于此
  └── ~/.agents/skills/               ← 新路径（原 ~/.config/opencode/skills/）
```

**核心变更点：**

| 变更项 | 旧 | 新 |
|--------|-----|-----|
| 工具配置 | `tools: { bash: true, edit: false }` | `permission: { bash: "allow", edit: "deny" }` |
| Skills 路径 | `~/.config/opencode/skills/` | `~/.agents/skills/` |
| Agent 字段 | model, prompt, tools, steps, mode | +variant, temperature, top_p, disable, hidden, color, description, permission |
| 权限粒度 | 工具级（开/关） | 工具级 + 模式级 + Skill 级（ask/allow/deny + 通配符） |

### Permission 体系设计（对齐 opencode.ai 官方 Schema）

从 opencode.ai/config.json 提取的 `PermissionConfig` 结构：

```
PermissionConfig:
  字符串模式（全局策略）: "ask" | "allow" | "deny"
  对象模式（按工具配置）:
    {
      // ── 规则型工具（支持通配符匹配）──
      "read":  "allow" | { "*.secret": "deny", "*.ts": "allow" }
      "edit":  "allow" | { "*.env": "deny" }
      "glob":  "allow" | ...
      "grep":  "allow" | ...
      "list":  "allow" | ...
      "bash":  "allow" | { "rm *": "deny" }
      "task":  "allow" | ...
      "external_directory": "allow" | ...
      "lsp":   "allow" | ...

      // ── 开关型工具（仅支持三态字符串）──
      "todowrite":   "ask" | "allow" | "deny"
      "question":    "ask" | "allow" | "deny"
      "webfetch":    "ask" | "allow" | "deny"
      "websearch":   "ask" | "allow" | "deny"
      "codesearch":  "ask" | "allow" | "deny"
      "doom_loop":   "ask" | "allow" | "deny"

      // ── Skill（规则型，按 skill 名称匹配）──
      "skill": "allow" | { "internal-*": "allow", "pr-review": "deny" }
    }
```

**工具分类说明：**

| 类型 | 工具 | 值格式 | 说明 |
|------|------|--------|------|
| 规则型 | read, edit, glob, grep, list, bash, task, external_directory, lsp, skill | `"allow"` 或 `{ pattern: action }` | 支持按文件路径/命令/skill 名称设置细粒度规则 |
| 开关型 | todowrite, question, webfetch, websearch, codesearch, doom_loop | `"ask"` 或 `"allow"` 或 `"deny"` | 只有全局开/关/询问三态 |

**tools → permission 兼容转换逻辑：**

读取 opencode.json 时，如果 agent 有 `tools` 字段但没有 `permission` 字段，自动转换：

```typescript
// 旧格式
tools: { "bash": true, "edit": true, "read": false }
// 自动转换为
permission: { "bash": "allow", "edit": "allow", "read": "deny" }
```

转换规则：`true` → `"allow"`，`false` → `"deny"`。写入时始终写 `permission`，清除 `tools`。

### Skills 目录迁移

![迁移流程](./images/02-migration-flow.png)

**路径变更：**

```
旧: ~/.config/opencode/skills/         → 启用的 skills
    ~/.config/opencode/skills/_disabled/ → 禁用的 skills

新: ~/.agents/skills/                   → 启用的 skills
    ~/.agents/skills/_disabled/          → 禁用的 skills
```

**自动迁移流程（RCS 启动时执行）：**

```
RCS 启动
    │
    ├── 新目录已存在？
    │     ├── 是 → 跳过迁移
    │     └── 否 → 旧目录存在？
    │               ├── 是 → 执行迁移
    │               │         1. 创建 ~/.agents/ 目录
    │               │         2. fs.rename(旧路径, 新路径) // 原子操作
    │               │         3. 在旧路径创建 .migrated 标记文件
    │               │         └── 迁移失败 → 日志警告，使用旧路径降级运行
    │               └── 否 → 创建新目录（全新安装）
    │
    └── 继续启动
```

**迁移策略细节：**

- 使用 `fs.rename()` 实现原子操作（同文件系统下）
- 跨文件系统时回退到 `copy + delete`
- `.migrated` 标记文件防止重复迁移
- 如果新目录已存在但旧目录也有内容（冲突），不自动迁移，日志警告用户手动处理
- `skills.paths` 和 `skills.urls` 配置字段由 OpenCode 运行时处理，RCS 不涉及

### Agent Permission UI 设计

**Agent 编辑弹窗改造 — Tab 结构：**

![Permission Tab 线框图](./images/03-permission-tab-wireframe.png)

```
FormDialog (Tabs)
  ├── Tab 1: 基础配置
  │     ├── 名称 (Input, 编辑时只读)
  │     ├── 模型 (Select + 手动输入)
  │     ├── 模式 (Select: primary / subagent / all)
  │     ├── 步数 (Input[number], 1-200)
  │     ├── Prompt (Textarea)
  │     ├── 描述 (Input)              ← 新增
  │     ├── Variant (Input)           ← 新增
  │     ├── 温度 (Input[number])      ← 新增
  │     ├── Top P (Input[number])     ← 新增
  │     ├── 颜色 (Input[color])       ← 新增
  │     ├── 隐藏 (Checkbox)           ← 新增
  │     └── 禁用 (Checkbox)           ← 新增
  │
  └── Tab 2: 权限配置                 ← 新增
        ├── 全局策略 (Select: 未设置 / ask / allow / deny)
        │
        ├── ── 工具权限 ──────────────────────
        │     ├── 开关型工具区
        │     │     每个工具一行:
        │     │     [工具名] → [Select: 未设置/ask/allow/deny]
        │     │     列表: todowrite, question, webfetch,
        │     │           websearch, codesearch, doom_loop
        │     │
        │     └── 规则型工具区
        │           每个工具一行:
        │           [工具名] → [全局 Select: 未设置/ask/allow/deny] [展开按钮]
        │           展开后:
        │             [Input(通配符)] → [Select(ask/allow/deny)] [删除]
        │             [+ 添加规则]
        │           列表: read, edit, glob, grep, list, bash,
        │                 task, external_directory, lsp
        │
        └── ── Skill 权限 ──────────────────────
              ├── 全局策略 (Select: 未设置/ask/allow/deny)
              │
              └── Skill 列表 (从 Skills API 实时获取)
                    每个 skill 一行:
                    [skill 名称] → [Select: 未设置/ask/allow/deny]

              ── 自定义规则 ──
              支持手动添加通配符:
              [Input(通配符, 如 "internal-*")] → [Select] [删除]
              [+ 添加自定义规则]
```

**交互要点：**

- "未设置"表示该级别不写入配置（让 OpenCode 使用内置默认值），这是默认状态
- 规则型工具展开后显示通配符规则编辑器，每行一个 pattern-action 对
- Skill 权限区从 Skills `list` API 实时获取所有 skill 名称，在 Tab 切换时触发加载
- 同时支持手动输入通配符模式（如 `internal-*`）
- 删除原有的"工具"Checkbox 多选组，被 Permission Tab 完全取代
- 所有变更通过弹窗底部的"保存"按钮统一提交

**数据流：**

```
用户切换到 Permission Tab
    │
    ▼
前端调用 GET /web/config/agents { action: "get", name }
    │ 获取 permission 对象
    │
    ▼
前端调用 GET /web/config/skills { action: "list" }
    │ 获取所有 skill 名称
    │
    ▼
渲染 Permission Tab
    │ 解析 permission 为 UI 状态
    │   - 字符串值 → 全局策略 Select
    │   - 对象值 → 逐工具/逐 skill 的 Select + 规则列表
    │
    ▼
用户编辑权限配置
    │
    ▼
用户点击"保存"
    │
    ▼
前端组装 permission 对象
    │   - "未设置"的字段不写入
    │   - 开关型: 直接存为字符串
    │   - 规则型: 有规则时存为对象，否则存为字符串
    │
    ▼
POST /web/config/agents { action: "set", name, data: { permission } }
    │
    ▼
ConfigService 写入 opencode.json
```

### API 变更汇总

**Agents API — get 响应新增字段：**

```jsonc
{
  "name": "build",
  "builtIn": true,
  "model": "claude-sonnet-4-6",
  "prompt": "You are a coding assistant...",
  "steps": 50,
  "mode": "primary",

  // ← 新增字段
  "permission": {
    "bash": "allow",
    "skill": { "internal-*": "allow" }
  },
  "variant": null,
  "temperature": null,
  "top_p": null,
  "disable": false,
  "hidden": false,
  "color": null,
  "description": null,

  // ← 废弃字段，读取时兼容转换
  "tools": null
}
```

**Agents API — set/create 请求变更：**

```jsonc
{
  "action": "set",
  "name": "plan",
  "data": {
    "permission": {
      "bash": "deny",
      "read": { "*.env": "deny", "*": "allow" },
      "skill": { "internal-*": "allow", "pr-review": "deny" }
    },
    "variant": "thinking",
    "temperature": 0.7,
    "disable": false,
    "description": "规划代理，用于分析任务并制定计划"
  }
}
```

- `tools` 字段不再接受，后端忽略
- `permission` 字段写入 opencode.json 的 `agent.<name>.permission` 路径
- 新字段（variant/temperature/top_p/disable/hidden/color/description）写入对应路径

**Skills API — 内部路径变更：**

API 接口契约不变，仅 SkillService 内部存储路径从 `~/.config/opencode/skills/` 改为 `~/.agents/skills/`。

**Models API — 顶层 permission 透传：**

Models 的 `get` 响应和 `set` 请求新增 `permission` 字段，直接读写 opencode.json 的顶层 `permission` 字段。不在 UI 中暴露可视化编辑器，仅在 API 层支持。

## 实现要点

1. **tools 兼容层**：ConfigService 读取 agent 配置时，检测 `tools` 字段。如果存在且 `permission` 不存在，按 `true → "allow", false → "deny"` 规则转换。写入时始终写 `permission`，同时清除 `tools` 字段。

2. **Permission Tab 数据组装**：前端需将扁平的 `permission` 对象解析为结构化的 UI 状态——区分全局策略、开关型工具、规则型工具、skill 权限。保存时反向组装。注意 `permission` 为字符串时表示全局策略，为对象时表示按工具配置。

3. **Skill 列表联动**：Permission Tab 的 Skill 权限区调用 Skills `list` API。使用 Tab 懒加载（用户切到 Permission Tab 时才请求），避免不必要加载。

4. **迁移幂等性**：`.migrated` 标记文件确保迁移只执行一次。迁移失败时降级使用旧路径，不阻塞启动。

5. **新字段校验**：`temperature` 范围 0-2（number），`top_p` 范围 0-1（number），`color` 为 hex 值（`#RRGGBB`）或预设主题色名（primary/secondary/accent/success/warning/error/info）。

6. **FormDialog Tab 化改造**：现有 Agent 编辑弹窗是单页表单，需要改为 Tabs 结构。使用 shadcn/ui 的 Tabs 组件，基础配置和权限配置各占一个 Tab。

7. **通配符规则编辑器**：规则型工具展开后显示的通配符编辑器是一个可复用组件，接收 `PermissionObjectConfig` 类型的值，渲染为多行 `[pattern] → [action]` 编辑器。

## 验收标准

- [ ] Skills 目录成功迁移到 `~/.agents/skills/`，旧数据完整保留，`.migrated` 标记文件存在
- [ ] Agent 编辑弹窗显示"基础配置"和"权限配置"两个 Tab
- [ ] Permission Tab 正确展示所有工具权限类型（开关型/规则型）
- [ ] 开关型工具（todowrite/question/webfetch/websearch/codesearch/doom_loop）各显示一个三态 Select
- [ ] 规则型工具（read/edit/glob/grep/list/bash/task/external_directory/lsp）支持全局策略 + 通配符规则展开编辑
- [ ] Skill 权限区展示所有 skill 名称，支持逐个配置权限
- [ ] Skill 权限支持手动添加通配符模式（如 `internal-*`）
- [ ] 旧的 `tools` 配置能自动转换为 `permission` 格式，UI 正确展示转换结果
- [ ] Agent 新字段（variant/temperature/top_p/disable/hidden/color/description）在基础配置 Tab 可正常编辑和保存
- [ ] 写入 opencode.json 后 OpenCode CLI 能正确解析新的 permission 格式
- [ ] Models API 支持顶层 `permission` 字段读写透传
