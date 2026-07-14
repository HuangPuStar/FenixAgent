# 多智能体协作

opencode 和 Claude Code 等运行时内置了主 Agent 分派子 Agent 的能力。本章介绍如何在 FenixAgent 中用 Markdown 文件定义自定义 Agent 团队，让不同角色的 Agent 协同完成复杂任务。

## 运行时的多智能体机制

opencode 和 Claude Code 都内置了多智能体调度能力。核心机制是：

```
用户请求 → 主 Agent（primary）→ 分析任务 → 分派给子 Agent（subagent）→ 结果返回主 Agent → 继续推理
```

主 Agent 在推理过程中，可以 spawn 一个或多个 subagent 来处理子任务。每个 subagent 有自己独立的 prompt、权限和工具集。subagent 完成后把结果返回给主 Agent，主 Agent 继续推进对话。

这不是外部编排引擎控制的，而是 Agent 运行时自身的推理能力——主 Agent 通过 prompt 理解"什么时候该分派任务"，然后调用运行时提供的 subagent 接口。

你也可以通过 `@` 提及手动调用子 Agent。例如输入 `@explore 搜索认证相关代码`，会直接派发给 explore Agent 处理。

## 为什么要用多 Agent：上下文节约

单 Agent 处理所有任务时，会遇到一个根本性的瓶颈——**上下文窗口有限，但任务越来越复杂**。多 Agent 架构从根本上解决了这个问题。

### 单 Agent 的上下文膨胀问题

假设你用一个"全能 Agent"同时负责代码编写、代码审查和项目规划。这个 Agent 的上下文中必须同时包含：

- 代码编写的详细工具使用指南和代码风格规范
- 代码审查的检查清单、安全规范、性能标准
- 项目规划的分析框架和输出格式要求
- 所有历史对话记录和中间推理过程

随着对话推进，上下文会快速膨胀。当 Agent 处理完一个复杂的代码编写任务后，接下来做代码审查时，之前编写代码的完整推理过程、工具调用结果、中间变量都还占着上下文空间——但这些信息对审查任务几乎没用。上下文被大量无关信息填满，导致：

- **有效信息密度下降** — 真正有用的指令被淹没在海量历史内容中，Agent 的指令遵循能力减弱
- **响应质量退化** — 当上下文接近窗口上限时，Agent 容易遗忘早期的约束条件，输出变得不一致
- **成本浪费** — 每次推理都要处理整个上下文，大量 token 花费在与当前任务无关的内容上

### 多 Agent 如何节约上下文

多 Agent 的核心优势在于**每个 Agent 只携带自己需要的上下文**：

**独立的 prompt 空间**。explore Agent 的 prompt 只包含搜索相关的指令，不需要知道代码审查的标准；review Agent 的 prompt 只包含审查规则，不需要了解文件系统的搜索策略。每个 Agent 的系统提示词短小精悍，不会互相干扰。

**独立的工作上下文**。子 Agent 执行完毕后，只把**结果摘要**返回给主 Agent，而不是整个推理过程。explore 搜索了 20 个文件、读了 50 段代码，最后只返回"认证相关代码集中在 `src/auth/` 目录下的 5 个文件中"这样的结论。主 Agent 的上下文里只有这一句话，而不是 50 段代码全文。

**隔离的工具描述**。每个 Agent 只加载自己有权限使用的工具。只读的 explore Agent 不会加载 write、edit、bash 的工具描述；审查 Agent 不会加载文件系统的工具。工具描述占用的 token 在每个子 Agent 中都大幅减少。

**按需创建、用完即弃**。子 Agent 的生命周期是短暂的——接到任务、执行、返回结果、销毁。不会像单 Agent 那样把所有历史对话一直累积下去。主 Agent 的上下文始终保持在合理的规模。

### 上下文节约的实际效果

以"重构用户模块"这个任务为例：

**单 Agent 方案**：Agent 先花 10 轮对话分析模块结构（上下文已膨胀），再花 20 轮编写代码（上下文继续膨胀），再花 5 轮审查代码——到审查阶段时，之前 30 轮的完整历史都在上下文中，审查质量因信息过载而下降。总 token 消耗可能是 80K+。

**多 Agent 方案**：主 Agent 派 explore 搜索代码结构（子 Agent 独立上下文，约 5K token），返回摘要给主 Agent；主 Agent 派 build 编写代码（子 Agent 独立上下文，约 20K token），返回修改结果；主 Agent 派 review 审查（子 Agent 独立上下文，只看最终代码，约 8K token），返回审查意见。主 Agent 自身的上下文始终只有摘要信息（约 10K token），每个子 Agent 的上下文都干净高效。总 token 消耗约 43K，且每个环节的质量更高。

### 小模型也能用

上下文节约还带来一个额外好处：**可以用更便宜的小模型处理子任务**。

当子 Agent 的上下文窗口需求被大幅压缩后，你不再需要为每个子任务都使用最贵的大模型。代码搜索可以用速度快、成本低的轻量模型；标题生成、内容摘要这类简单任务用小模型完全够用。只在需要复杂推理的核心任务上使用大模型，整体成本可以降低数倍。

在 Agent MD 文件中通过 `model` 字段为每个 Agent 指定不同的模型，实现按需选型。

## Agent 类型

### 主 Agent（primary）

主 Agent 是用户直接对话的入口。可以在会话中使用 Tab 键切换不同的主 Agent。每个主 Agent 拥有独立的 prompt 和工具权限配置。

### 子 Agent（subagent）

子 Agent 由主 Agent 自动调用，或通过 `@` 提及手动调用。它们聚焦于特定任务——代码搜索、代码审查、安全审计等。子 Agent 执行完毕后把结果返回给主 Agent。

### 隐藏 Agent

可以设置 `hidden: true` 将子 Agent 从 `@` 自动补全中隐藏，只允许主 Agent 通过 Task 工具以编程方式调用。适合内部辅助型 Agent。

## 用 Markdown 定义 Agent

Agent 通过 Markdown 文件定义，放在项目的 `.opencode/agents/` 目录中。文件名就是 Agent 名称——例如 `review.md` 会创建一个名为 `review` 的 Agent。

### 文件格式

每个 Agent 文件由两部分组成：YAML frontmatter（元数据）和正文（系统提示词）。

frontmatter 中的字段：

| 字段 | 必填 | 说明 |
|------|------|------|
| `description` | 是 | 简要描述 Agent 的能力和适用场景。主 Agent 据此判断何时调用 |
| `mode` | 否 | `primary` / `subagent` / `all`，默认 `all` |
| `model` | 否 | 模型引用，格式 `provider/model` |
| `temperature` | 否 | 温度参数，0.0-1.0 |
| `steps` | 否 | 最大推理步数。达到限制后 Agent 会被强制以纯文本回复 |
| `tools` | 否 | 工具开关，控制哪些工具可用 |
| `permission` | 否 | 权限控制，支持三态值和通配符规则 |
| `hidden` | 否 | `true` 时从 `@` 自动补全中隐藏 |
| `disable` | 否 | `true` 时禁用该 Agent |
| `color` | 否 | UI 显示颜色，十六进制或预设名称 |

frontmatter 下方的正文就是 Agent 的系统提示词，用 Markdown 编写。

### 目录结构

```
my-project/
├── .opencode/
│   └── agents/
│       ├── build.md          ← 主 Agent，代码编写
│       ├── plan.md           ← 主 Agent，任务规划
│       ├── explore.md        ← 子 Agent，代码搜索
│       └── review.md         ← 子 Agent，代码审查
├── CLAUDE.md
└── src/
```

也可以放在全局目录 `~/.config/opencode/agents/` 下，所有项目共享。

## 提示词设计要点

多 Agent 系统中，提示词设计比单 Agent 更关键——不仅要告诉 Agent 自己做什么，还要明确它与其他 Agent 的边界。

### 主 Agent 的 prompt 要点

主 Agent 的 prompt 需要包含**决策规则**——什么时候自己处理，什么时候委派。规则要具体、无歧义，避免两个子 Agent 都能处理同一类任务。

委派时要注意传递足够的上下文——不要把用户的原始请求原封不动地转发，要加上主 Agent 自己的理解和分析。

### 子 Agent 的 prompt 要点

子 Agent 的 prompt 要**聚焦单一职责**。明确输入输出约定，不要在子 Agent 的 prompt 中包含"如果需要可以调用其他 Agent"，避免 A 调 B、B 调 A 的死循环。

### 避免的问题

- **职责重叠** — 不要让两个子 Agent 都能写代码，这会导致主 Agent 不知道该选谁
- **循环调度** — 子 Agent 不应该有调度其他 Agent 的能力
- **信息丢失** — 主 Agent 委派时要传递足够的上下文，子 Agent 不一定能看到完整的对话历史

## 权限与工具控制

### 工具开关

通过 `tools` 字段控制 Agent 可以使用哪些工具。例如一个只读的审查 Agent 应该关闭 `write`、`edit` 和 `bash`。

### 权限三态

`permission` 比 `tools` 更精细，支持三种状态：

- `allow` — 自动允许
- `ask` — 每次执行前向用户请求确认
- `deny` — 禁止

支持通配符规则，例如对 bash 命令做精细化控制：`git status *` 设为 `allow`，`*` 设为 `ask`，表示只有 git status 类命令自动执行，其他命令需要确认。注意通配符匹配顺序——最后匹配的规则优先，所以 `*` 放前面，具体规则放后面。

### 任务权限

通过 `permission.task` 控制主 Agent 可以调用哪些子 Agent。例如只允许调用 `explore` 和 `review`，禁止调用 `build`。设为 `deny` 的子 Agent 会从 Task 工具描述中移除，主 Agent 不会尝试调用它。

## 设计你的 Agent 团队

FenixAgent 中的 Agent 完全由你自定义。以下是几种常见的团队设计模式：

### 代码开发团队

- **build**（primary）— 负责代码编写，拥有完整工具权限
- **plan**（primary）— 负责分析和规划，write/edit/bash 设为 ask，防止意外修改
- **explore**（subagent）— 快速搜索代码库，只读权限，无法修改文件
- **review**（subagent）— 代码审查，关注质量、安全和性能

### 其他团队模式

- **客服团队** — 主 Agent 接待用户，知识库 Agent 查文档回答问题，工单 Agent 创建工单
- **内容团队** — 主 Agent 分发任务，写作 Agent 生成内容，审核 Agent 检查质量
- **数据团队** — 主 Agent 理解需求，查询 Agent 写 SQL 取数据，分析 Agent 做可视化

核心原则：一个主 Agent 负责调度，多个子 Agent 各司其职，权限按最小需要分配。

## 多 Agent + Skill

不同的 Agent 可以掌握不同的 Skill，形成专业化的分工。例如 build Agent 掌握 deploy Skill，explore Agent 掌握 data-analysis Skill，plan Agent 不需要额外 Skill。

在 Agent MD 文件中通过 `permission.skill` 字段控制 Agent 可以使用哪些 Skill，支持通配符匹配。

## 实际场景示例

### 场景：用户说"帮我重构用户模块"

```
1. 用户 → build（主 Agent）："帮我重构用户模块"
2. build 分析：这是复杂任务，先规划
3. build → plan："分析用户模块，制定重构计划"
4. plan 返回：分 3 步，涉及 5 个文件
5. build 向用户展示计划，等待确认
6. 用户确认后，build 执行重构
7. build → review："审查重构后的代码"
8. review 返回：发现 2 个潜在问题
9. build 修复问题，向用户报告结果
```

### 场景：用户说"auth 相关的代码在哪里"

```
1. 用户 → build："auth 相关的代码在哪里"
2. build 分析：搜索任务，委派 explore
3. build → @explore："搜索所有与认证相关的代码"
4. explore 使用 grep/glob 搜索，返回文件列表和关键代码
5. build 整理结果，向用户展示
```

## 下一步

- [Skill 开发](./skill-development) — 为不同 Agent 开发专属 Skill
- [MCP 工具集成](./mcp-integration) — 通过 MCP 为 Agent 提供更多工具
