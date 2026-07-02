---
name: fenix-code-review
description: "执行 FenixAgent 项目专用代码审查。手动触发，默认审查已暂存改动，或按用户提供的文件路径、提交范围、分支 diff 范围进行审查，并生成审查报告。"
disable-model-invocation: true
argument-hint: "[scope]"
---

# Fenix Code Review

执行 FenixAgent 项目专用代码审查，并将结果写入仓库根目录的审查报告文件。

**Announce at start:** "我正在使用 fenix-code-review 技能进行代码审查。"

## 用法

- `/fenix-code-review` — 默认审查已暂存改动
- `/fenix-code-review <scope>` — 审查指定范围

`<scope>` 可填写常见 Git 审查范围，例如：

- 单个或多个文件路径，如 `src/routes/web/config/mcp.ts`
- 带路径限制的 diff 目标，如 `HEAD~1 -- src/routes/web/config/mcp.ts`
- 提交或提交区间，如 `HEAD~1..HEAD`、`abc1234^!`
- 分支 diff 范围，如 `main...HEAD`
- 其他合法的 `git diff` 目标

## 阶段一：前置准备（主会话内联执行）

以下步骤必须在当前主会话中直接执行，**禁止委托给子代理**。

### 步骤1：解析审查范围

审查范围由 `$ARGUMENTS` 决定：有值时用值，无值时默认 `git diff --cached`。

按以下顺序处理：

1. 运行 `git diff --stat <scope>` 检查范围是否有效。
2. 如果是无效的 Git diff 范围（如不存在的文件、错误的 commit hash），立即停止并提示用户修正。
3. 如果范围有效但 diff 为空（如两个完全相同的 commit、无改动的文件），立即停止并说明"该范围内没有可审查的变更"，**不要生成报告文件**。
4. 如果用户未提供范围且 `git diff --cached` 也为空，则停止并显示：

```text
默认审查已 `git add` 暂存的改动，当前未发现任何暂存内容。

请选择以下方式之一指定要审查的变更：

1. 暂存你想审查的文件：`git add <文件>`，然后重新执行 `/fenix-code-review`
2. 直接指定审查范围：`/fenix-code-review <scope>`

`<scope>` 的常用写法：

| 写法 | 含义 | 示例 |
|------|------|------|
| 文件路径 | 审查指定文件 | `/fenix-code-review src/routes/web/config/mcp.ts` |
| 最近 N 个提交 | 审查最近 N 次 commit 的改动 | `/fenix-code-review HEAD~3..HEAD` |
| 单个提交 | 审查某次 commit 的改动 | `/fenix-code-review abc1234` |
| 分支对比 | 审查当前分支相对于 main 的所有改动 | `/fenix-code-review main...HEAD` |
```

5. 范围有效且有变更，继续下一步。

### 步骤2：变更范围概览

快速了解变更规模：

1. 运行 `git diff --stat <scope>` 获取变更文件列表和行数统计。
2. 识别变更涉及哪些代码区域（后端 `src/`、前端 `web/`、数据库 `drizzle/` 等），后续阶段二审查时按区域读取对应的规范文档。

### 步骤3：执行 Precheck（内联执行，不可委托）

**此步骤必须在主会话中直接执行，不能放到子代理中。** 这是为了解决子代理环境中 `bun` 权限受限的问题。

```bash
bun run precheck
```

处理规则：

1. 如果 `bun run precheck` 失败，立即终止审查流程。
2. 不进入问题分析、风险判断和报告撰写阶段。
3. 直接向用户列出 `precheck` 暴露的问题，并明确要求先修复到 `bun run precheck` 通过后再重新发起审查。
4. 不要在 `precheck` 失败时输出"代码审查结论"，避免把基础质量问题和审查结论混在一起。
5. 输出时优先按命令阶段、文件路径和核心报错做摘要，不要原样倾倒整段超长日志。
6. 如果 `bun run precheck` 命令本身不可用（如缺少 `bun`），报告错误并终止。

---

## 阶段二：正式审查（选择执行方式）

只有 **precheck 通过后**，才进入正式审查阶段。此时选择以下两种方式之一执行审查：

### 推荐方式：子代理执行

启动独立子代理执行完整审查，避免当前会话上下文污染审查判断。

启动子代理时的要求：

- **仅传入任务必要信息**：skill 路径、仓库根目录、审查范围。不要附带预设结论或倾向性描述。
- **子代理需要执行的内容**：读取 diff → 读取规范文档 → 按审查标准检查 → 生成报告文件（即技能中步骤4~6）。
- 使用类似提示：

```text
Use the fenix-code-review skill at .claude/skills/fenix-code-review/SKILL.md to review the scope "HEAD~1..HEAD" in /path/to/repo.
The precheck has already passed. Read the skill, read the diff for the scope, read relevant dev guides, perform the review as specified in the skill's "阶段二执行内容" section, and write the report.
```

子代理完成任务后，主会话向用户报告结果（报告文件名）。

### 备选方式：内联直接执行

在当前会话中直接执行审查步骤。**注意**：如果当前会话上下文已经较长或包含其他任务的中间结果，建议用户先执行 `/clear` 清空上下文后再发起审查，避免已有上下文干扰审查判断。

---

## 阶段二执行内容（子代理或内联均按此执行）

以下为审查的核心逻辑，无论用哪种方式执行，都必须完整执行。

### 步骤4：收集完整审查上下文

1. 逐个读取变更文件的完整 diff（`git diff <scope>`）。
2. 在必要时读取相邻代码（`git diff` 无法展示的上下文），理解行为、依赖关系和回归风险。
3. 根据变更涉及的区域，读取对应的规范文档：
   - 后端变更（`src/`）→ `docs/developer/guide/backend-development.md`
   - 前端变更（`web/`）→ `docs/developer/guide/frontend-development.md`
   - 数据库迁移（`drizzle/`）→ `docs/developer/guide/backend-development.md`

如果上述某文档不存在，在报告中标注"审查依据不完整：缺少 `<文档路径>`"，继续审查但不虚构规范要求。

### 步骤5：审查标准

#### 5.1 问题严重程度定义

| 级别 | 含义 | 示例 |
|------|------|------|
| 🔴 高 | 必须修复才能合并。会导致功能异常、数据丢失、安全漏洞、生产事故 | SQL 注入、API Key 泄露、静默破坏兼容性、数据迁移不可逆错误 |
| 🟡 中 | 建议修复。违反项目规范、可能引发未来 bug、存在边界条件未处理 | 缺少错误处理、未走 repository 直调 db、i18n 硬编码、缺少必要日志 |
| 🔵 低 | 改进建议。代码可读性、可维护性优化，不影响功能正确性 | 缺少注释、变量命名可优化、函数可拆分 |

标记为 🔴高 的问题，必须在报告中说明：如果不修复会导致什么具体后果。

#### 5.2 后端变更专项检查

对照 `docs/developer/guide/backend-development.md`，重点检查：

- **分层违规**：route 是否直接访问了 repository/db？service 是否通过 repository 访问数据库？
- **API 设计**：URL 是否 kebab-case、资源名复数？`/web` 和 `/api` 是否按用途分层？
- **Schema 变更**：是否同时提交了完整的 `drizzle/` 产物（SQL + meta）？DDL 和数据迁移是否分离？
- **错误处理**：`catch` 块是否有 `console.error(err)`？响应是否统一返回 `{ success, error }` 格式（`/web`）？
- **注释和日志**：公共函数是否有文档注释？关键业务流程是否有日志？
- **API 兼容性**：（`/api/*`）是否保持了向后兼容？（`/api/*`）破坏性变更是否新增了版本化接口？
- **组织隔离**：新增资源是否包含 `organizationId` 字段和租户隔离逻辑？
- **OpenAPI 文档**：route 是否补充了 `detail`、`params`、`response` 等元数据？schema 是否定义在 `src/schemas/`？

#### 5.3 前端变更专项检查

对照 `docs/developer/guide/frontend-development.md`，重点检查：

- **API 建模层**：组件中是否有裸 `fetch` 调用？API 调用是否通过 `web/src/api/` 域模块？
- **路由和导航**：是否使用了 `window.location.href` 等写操作？新页面是否在 `_panel/` 下并懒加载？
- **表单**：是否使用 react-hook-form + zod？是否手写 `useState` 管理表单状态？
- **数据获取**：是否使用 ahooks `useRequest` 而非手动 `useState(loading)` + `useEffect`？
- **i18n**：用户可见字符串是否全部走 `t()`？新命名空间是否正确注册？
- **安全**：是否有不经清洗的 `dangerouslySetInnerHTML`？API Key 是否存入 localStorage？
- **错误边界**：新增面板是否包裹了 ErrorBoundary？
- **组件声明**：是否使用 `function` 声明（非箭头函数）？
- **图标**：UI 图标是否只用 lucide-react？模型图标是否走 `<ModelIcon>`？
- **样式**：是否使用项目 CSS 变量体系（`text-bright`、`bg-surface-1` 等）？
- **类型**：禁止 `as any`（业务代码），字段类型是否与后端实际结构一致？

#### 5.4 通用检查

- **安全漏洞**：SQL 注入、XSS、命令注入、敏感信息泄露、认证绕过
- **业务逻辑**：边界条件（空数组、null、undefined）、竞态条件、事务边界
- **回归风险**：删除/修改的字段是否在其他地方被依赖？API 签名变更是否影响调用方？
- **测试覆盖**：是否缺少关键路径的测试？新增的核心逻辑是否有测试覆盖？

#### 5.5 不报告的问题

以下问题由 `bun run precheck`（biome + tsc）自动覆盖，审查报告中不应重复报告：

- 代码格式（缩进、换行、空格）
- import 排序
- TypeScript 类型错误（tsc 已检查）
- biome lint 规则覆盖的问题（除非 precheck 未启用该规则，且有明确规范要求）

如果发现 precheck 未覆盖但值得注意的问题，标记为 🔵低 并在报告末尾单独注明"建议纳入自动化检查"。

### 步骤6：撰写审查报告

当且仅当正式审查完成后，将结果写入仓库根目录：

`review-{yyyy-MM-dd}-{随机4位字符串}.md`

命名要求：

1. 日期使用当前本地日期，例如 `2026-07-02`。
2. 随机串使用 4 位小写字母或数字，避免文件名冲突。
3. 如果生成的文件名已存在，重新生成随机串，直到文件名唯一。
4. 报告文件不要执行 `git add`，不要提交到 Git。

报告内容使用中文，并采用如下结构：

```markdown
# Code Review

## 变更概述
- 审查范围: ...
- 变更文件: X 个（+A -B 行）
- precheck: 通过
- 审查依据: frontend guide / backend guide / 其他

## 发现的问题
### `path/to/file`
- 🔴高: 具体问题描述
  - 影响: ...
  - 建议: ...
- 🟡中: ...
- 🔵低: ...

## 缺失的测试
- 如无则写：无
- 如有，列出缺失的测试场景和对应文件

## 建议提交信息
（仅审查范围为 `git diff --cached` 暂存改动时包含此节，审查已提交代码时省略）

```
<type>(<scope>): <中文标题>

- 要点1
- 要点2
```


## 总体结论
- 风险结论: 低 / 中 / 高
- 问题统计: X 个（🔴A / 🟡B / 🔵C）
- 是否建议合并: 是 / 否（附条件）
```

写作规则：

1. 每个问题单独一条，包含具体问题、影响原因、建议修复方向。
2. 按文件分组，问题最多的文件排在最前面。
3. 没有问题的文件不写进"发现的问题"。
4. 如果整体没有需要指出的真实问题，写：`- 未发现需要指出的真实问题。`
5. 若问题与项目规范直接冲突，明确指出违反的是哪份规范的哪条规则。
6. 🔴高 问题必须附"影响"和"建议"两项。
7. 当审查范围为 `git diff --cached`（暂存改动）时，必须包含"建议提交信息"节；审查已提交代码（如 `HEAD~1..HEAD`、commit hash、分支 diff）时省略此节。

---

## 阶段三：结果回复（主会话执行）

无论阶段二采用子代理还是内联方式，最终回复都由主会话完成。

报告生成后，用中文简短回复，并带上实际生成的文件名：

```text
✅ 代码审查已完成，结果已写入 `review-2026-07-02-ab12.md`。
```

> **注意**：如果流程在阶段一步骤3（precheck）提前终止，已在步骤3中直接向用户说明，不会再走到阶段三。

---

## 执行规则

1. 只能手动触发，禁止自动调用。
2. **阶段一（前置准备）必须在主会话内联执行**：范围解析、快速概览、precheck。不可委托子代理。
3. **阶段二（正式审查）在 precheck 通过后选择执行方式**：
   - **推荐：子代理执行** — 避免上下文污染审查判断。
   - **备选：内联直接执行** — 上下文干净时可用。
4. 默认只审查 staged changes，除非用户显式提供 `<scope>`。
5. 报告必须落盘到仓库根目录。
6. 用户可见输出和报告内容都必须使用中文。
7. 默认不改代码，只做审查；除非用户后续明确要求修复。
8. 禁止执行 commit、reset、rebase 或其他改写历史操作。
