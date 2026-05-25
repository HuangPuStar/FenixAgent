# Skill 开发

Skill 是 RCS 中扩展 Agent 能力的核心机制。一个 Skill 就是一份 Markdown 格式的指令文件（SKILL.md），Agent 读取后按照其中的步骤和规则行动。你可以把 Skill 理解为"教 Agent 完成某类任务的教程"。

## 什么是 Skill

Skill 的本质是一份结构化的 Markdown 文档。当 Agent 需要执行某类任务时，它会读取对应的 SKILL.md，按照文档中描述的步骤、约束和示例来行动。

比如你希望 Agent 学会"代码审查"，就写一份 Code Review Skill，告诉它审查哪些方面、用什么格式输出、遇到问题怎么处理。之后每次让 Agent 做代码审查，它都会遵循这个流程。

## SKILL.md 格式

### Frontmatter（元数据）

SKILL.md 文件开头用 YAML frontmatter 描述元数据，包含 `name`（Skill 标识符，小写字母+连字符）和 `description`（简短用途描述），都是必填字段。

### 正文结构

一份好的 SKILL.md 正文通常包含以下部分：

- **目标** — 这个 Skill 要达成什么
- **执行步骤** — 按顺序列出 Agent 应该做什么
- **输出格式** — 结果应该长什么样
- **约束** — 什么不能做，什么情况下该停止

### 写作原则

- **用祈使句** — "读取文件列表"而非"你应该读取文件列表"
- **给具体示例** — 提供输入输出的样例，减少 Agent 的歧义理解
- **设定边界** — 明确告诉 Agent 什么时候不该用这个 Skill
- **保持聚焦** — 一个 Skill 只做一件事，不要把"代码审查"和"自动修复"混在一起

## Skill 的作用域

Skill 有三个作用域层级，从广到窄：

### 全局 Skill

放在 `~/.agents/skills/` 目录下，所有 Agent 可用。适合通用的、与项目无关的能力，比如"代码审查"、"技术文档编写"。

### 工作区 Skill

放在项目的 `.agents/skills/` 目录下，当前 workspace 的 Agent 可用。适合项目专属的工作流程，比如"我们项目的 API 设计规范"、"数据库迁移流程"。

### Agent 专属 Skill

在 RCS 控制台的 Agent 配置中绑定特定 Skill，只有该 Agent 可用。适合需要特定能力的 Agent，比如给 `explore` Agent 绑定"语义搜索"Skill。

## Skill 配合脚本开发

Skill 不仅限于文字指令，你可以在 Skill 中引导 Agent 调用 bash 执行 Python、Shell 等脚本，实现更强大的自动化。

Agent 本身具备 bash 执行能力（受 Permission 控制）。在 Skill 的步骤中，你可以明确告诉 Agent 执行某个脚本，处理脚本的输出，然后基于结果做进一步操作。

例如数据分析 Skill 可以引导 Agent 调用 Python 脚本处理 CSV，读取 JSON 输出，再用自然语言向用户解释关键发现。部署 Skill 可以引导 Agent 执行部署脚本、监控输出、做健康检查。

Agent 执行脚本需要 bash 权限。如果只想允许特定路径下的脚本自动执行，可以在 Agent MD 文件中用通配符规则精细控制。

## Skill 管理操作

### 通过控制台管理

在 RCS 控制台的 Skills 页面，你可以：

- **创建 Skill** — 直接输入 Markdown 内容或上传包含 SKILL.md 的目录
- **启用/禁用** — 禁用后 Agent 不会加载该 Skill，但不会删除
- **删除** — 彻底移除 Skill
- **批量上传** — 上传一个包含多个 Skill 目录的 zip，支持冲突处理（跳过/覆盖）

### 按来源过滤

控制台支持按来源过滤 Skill：

- **全局** — `~/.agents/skills/` 下的 Skill
- **工作区** — 当前 workspace 的 `.agents/skills/` 下的 Skill

### Skill 权限

通过 Agent MD 文件的 `permission.skill` 字段控制 Agent 可以使用哪些 Skill，支持通配符匹配。

## Skill 生态：skills.sh

[skills.sh](https://www.skills.sh/) 是一个开放的 Agent Skill 生态市场，你可以从中发现、安装和分享 Skill。

### 浏览与安装

```bash
# 搜索 Skill
npx skills search <关键词>

# 安装 Skill 到当前项目
npx skills add <skill-name>
```

安装后，Skill 文件会自动放入 `.agents/skills/` 目录，Agent 即可使用。

### 使用 skill-creator 创建 Skill

如果你不确定怎么写 Skill，可以用 `skill-creator`（来自 `anthropics/skills`）来辅助生成。它是一个交互式工具，会引导你完成 Skill 的设计、编写、测试全流程：

```bash
# 通过 skills.sh 安装 skill-creator
npx skills add anthropics/skills/skill-creator
```

skill-creator 会：
1. 引导你定义 Skill 的目标和适用场景
2. 自动生成 SKILL.md 框架
3. 帮你设计测试用例验证 Skill 效果
4. 支持迭代优化直到满意

### 分享你的 Skill

写好 Skill 后，你可以通过 skills.sh 分享给其他开发者：

```bash
npx skills publish
```

## 下一步

- [多智能体协作](./multi-agent) — 让不同 Agent 各自掌握不同的 Skill，协同工作
