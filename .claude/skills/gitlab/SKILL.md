---
name: gitlab
description: 处理 GitLab issue 的完整闭环：定位项目、读取 issue 与讨论、按证据定 P 级、在独立 worktree 修复、验证、提交 GitHub PR、等待 CI 与 CodeRabbit、回帖 GitLab issue 并在合并后关闭。当用户给出 GitLab issue 链接或编号、提到 GitLab issue、工单、VER 问题、修复 #40，或调用 /gitlab 时使用。即使用户只贴了 issue 标题或编号，也先加载本 skill 解析项目与问题。
argumentHint: "<issue 链接 | 项目路径#IID | issue 标题 | 编号>"
---

# GitLab Issue 修复闭环

本 skill 是 `fix-bug` 的 GitLab 入口适配：修复动作与验证仍按 `fix-bug` 的纪律执行，这里补齐「GitLab 取数 → GitHub PR → GitLab 回帖/关闭」的差异与踩坑。主 agent 是唯一控制者与验收人。

## 0. 先确认三件事

1. **问题在哪个 GitLab 项目**：IID 只在项目内唯一，编号本身不足以定位。
2. **代码在哪个仓库**：本仓 `origin` 是 GitHub `HuangPuStar/FenixAgent`，GitLab 只承担 issue 跟踪，不要用 origin 反推 issue 项目。
3. **是否已有修复分支或 PR**：先查分支与 PR，避免重复修复。

## 1. 定位项目并读取 issue

1. 从链接解析：`https://<gitlab>/<group>/<project>/-/work_items/<iid>` 或 `/-/issues/<iid>`。
2. 用户只给编号时，先用关键词搜索项目，不要猜：
   - `mcp__gitlab__search_repositories`（`query`）
   - `mcp__gitlab__list_projects`（`search` / `membership`）
3. 本项目的已知映射：
   - E2E / VER 问题：`aos-test/aos-e2e-test`
   - 代码仓库：GitHub `HuangPuStar/FenixAgent`
4. 读取 issue：`mcp__gitlab__get_issue`，参数 `project_id` + `issue_iid`（字符串）。
5. 读取讨论：`mcp__gitlab__list_issue_discussions`。返回 `null` 表示没有讨论，不是失败。
6. 提取并复述：现象、期望、复现步骤、环境/版本、优先级、影响面。只追问阻塞复现的信息。

**404 的排查顺序**：项目路径错 → IID 属于其它项目 → issue 已删除。优先用 `list_issues` 在候选项目里核对，不要直接判定 issue 不存在。

## 2. 定级

| 级别 | 判据 | 动作 |
| --- | --- | --- |
| P0 | 数据丢失/损坏、安全漏洞或密钥泄露、崩溃/无法启动、核心流程完全不可用且无规避 | 停止修复，立即汇报 |
| P1 | 核心功能错误或明确回归、稳定复现、影响主要路径但有临时规避 | explorer 确认 → 写 `spec/issues/` → coder 修复 |
| P2 | 非核心功能错误、边界条件、明显性能退化、错误提示/日志缺失 | 主 agent 一次性修复 |
| P3 | 轻微文案/格式、低影响边界、可维护性 | 与 P2 同批修复 |

issue 里的「优先级」是证据，不是结论；判不准取更高级别，P0/P1 有争议按 P0 处理。定级依据写入最终汇报。

## 3. Worktree

1. `git status --short --branch`，记录既有 dirty 文件；本流程**不 stash、不 reset、不 clean、不顺手提交**这些改动。
2. `git fetch origin`，从 `origin/main` 创建：
   ```bash
   git worktree add --no-track -b fix/<slug> .worktrees/<slug> origin/main
   ```
3. worktree 没有 `node_modules` 时先 `bun install --frozen-lockfile`。
4. 运行期间若出现与本任务无关的新 dirty 文件（并行会话/用户操作），保持原样；每次提交前重查 `git status`，只暂存本任务文件。

## 4. 复现与修复

1. 优先运行时复现；不能复现时用失败测试、日志或代码证据，并标注「未运行时复现」。
2. 写出根因链：`触发 → 机制 → 用户可见后果`，关键步骤带 `文件:行号`，区分观察与推断。
3. 搜索同一根因或同一模式的其它调用点，按「修复一类问题」确定范围；不要扩大到无关重构。
4. 前端修复优先写覆盖用户流程的集成测试，不写纯 UI 结构或重复类型检查的测试。
5. 改动会改变已记录的产品决策时，同步 `docs/design/` 或 `docs/arch/` 中仍有效的事实与约束。
6. 注释只解释「为什么」；不留缺上下文的 `TODO`。

## 5. 验证

按顺序执行，前一步通过再进入下一步：

1. 目标测试：`bun test <相关测试文件>`
2. 快检：`bun run fastcheck`
3. 前端改动：`bun run build:web`
4. 全量门禁：`bun run precheck`
5. 文档改动：`bun run docs:build`
6. `git diff --check`

注意事项：

- `precheck` 需要完整日志时重定向到文件，不要接 `| tail -60`，否则失败步骤会被截掉。
- `precheck` 可能在并发测试批下触发 Bun 段错误。先单独重跑失败批（如 `bun test packages/ --path-ignore-patterns 'tmp/**' --isolate`），再重跑全量 `precheck`；只有断言或产品证据才判定为修复失败，不要用「历史问题」掩盖。
- 目标测试先失败、修复后通过，才算复现证据成立。

## 6. 提交与 PR

1. 只暂存本任务文件，提交信息用 Angular 风格中文标题，正文写「为什么」：
   ```text
   fix(scope): 中文标题

   根因与修复说明。

   Refs: <project>#<iid>
   Co-Authored-By: deepseek-v4-flash <deepseek-ai@claude-code-best.win>
   ```
2. 允许 pre-commit hook 正常执行（biome 会格式化暂存文件）；不跳过 hook，不 `--amend`，不 force push。
3. 推送并创建 GitHub PR（本仓代码托管在 GitHub）：
   ```bash
   git push -u origin HEAD
   gh pr create --base main --title "<提交标题>" --body-file <body.md>
   ```
4. PR 正文固定包含：`## 问题`、`## 根因`、`## 修复`、`## 验证`、`## 风险与遗留`、`## 关联`（GitLab issue 链接）。模板：

```markdown
## 问题

<现象、触发条件、影响面；P 级与定级依据>

## 根因

<根因链，含关键 文件:行号>

## 修复

<改动概述、范围、明确不做的事>

## 验证

- `<命令>` → <结果>
- 回归测试：<新增或修改的测试>

## 风险与遗留

<兼容性、性能、未覆盖项；无则写「无」>

## 关联

- GitLab issue: <链接>
```

5. **创建 PR 后立即回帖 GitLab**：PR 链接、分支、根因、修复范围、验证结果，并写明「PR 尚未合并，issue 保持 open」。之后的每次推送与 CI 结果都要继续同步（见 §8）。

## 7. CI 与 CodeRabbit

1. 用后台任务等待，不要用 `sleep` 轮询：
   ```bash
   gh pr checks <n> --watch --interval 30
   ```
   `gh pr checks` 退出码 8 表示仍有 pending。
2. 全部 check 通过后，再确认 CodeRabbit 有**晚于最后一次 push** 的 review 或 comment；只看它最初的「Review in progress」摘要不算完成。
3. 读取行级意见与评审时间：
   ```bash
   gh api repos/<owner>/<repo>/pulls/<n>/comments
   gh api repos/<owner>/<repo>/pulls/<n>/reviews
   ```
4. 意见处理：
   - 成立：修复 + 补回归测试 + 在对应 thread 回复 + 确认 thread resolved。
   - 不成立：在 thread 回复证据，不静默忽略。
   - 每轮新开 commit，最多 3 轮；禁止 force push 和跳过 hook。
5. 回复格式：说明改了什么、对应 commit、验证结果，避免只写「已修复」。
6. 确认 thread 状态（可选，GraphQL）：
   ```bash
   gh api graphql -f query='query { repository(owner:"<owner>", name:"<repo>") {
     pullRequest(number:<n>) { reviewThreads(first:20) {
       nodes { isResolved isOutdated path }
     } } } }'
   ```
   已修复的意见应为 `isResolved: true`。
7. **CI 全绿后立即回帖 GitLab**：通过的 check 数量/名称、CodeRabbit 结论、最后一次 push 的 commit；不要等合并才更新。

## 8. 回帖 GitLab 与关闭

1. 修复完成并创建 PR 后，用 `mcp__gitlab__create_issue_note` 回帖：
   - PR 链接、分支、根因、修复范围、回归测试、门禁结果
   - 明确写「PR 尚未合并，issue 保持 open」
2. **同步节点**：GitLab 信息不是合并时一次性补，而是随开发进度持续更新。

   | 节点 | 回帖内容 |
   | --- | --- |
   | 创建 PR 后 | PR 链接、分支、根因、修复范围、初始验证 |
   | 每次追加提交/推送 | commit、变更点、追加原因 |
   | CI 全绿 | check 数量与结果、CodeRabbit 状态、最后一次 push |
   | CodeRabbit 意见处理 | 意见结论、修复 commit、回归测试 |
   | 合并后 | 合并信息，并关闭 issue |

   同一次推送触发的「commit + CI」可以在 CI 出结果后合并成一条，但 CI 结果本身必须回帖；不要把多次推送积累到合并时一次补。
3. **不要在 PR 合并前关闭 issue**。合并后（或用户确认）再 `mcp__gitlab__update_issue`，`state_event: "close"`；需要时补一条合并说明。
4. 回帖只写可公开的事实；不得出现密钥、token、连接串、完整环境变量或内部凭据。

## 9. 汇报

用简短有序列表，先给结论：

1. P 级与依据
2. worktree / 分支 / PR 链接
3. 改动文件与核心改动
4. 验证命令与结果
5. CI / CodeRabbit 状态
6. 遗留与未做的事（如 issue 未关闭、已知边界）

未实际运行的检查不得写成通过；环境性失败与产品失败分开说明。

## 踩坑清单

- **IID ≠ ID**：API 用 `issue_iid`；项目用 `project_id`（路径或数字）。
- **不要把 GitHub origin 当成 GitLab 项目**：本仓代码在 GitHub，issue 在 GitLab。
- **`/-/work_items/<iid>` 是正常 URL**：GitLab 会把 issue 展示为 work item。
- **`list_issue_discussions` 返回 `null`**：没有讨论，不是权限或接口错误。
- **`gh pr checks` 的退出码**：8 = 仍有 pending，不是「检查失败」。
- **CodeRabbit 摘要评论不是最终评审**：以晚于最后 push 的 review/comment 为准。
- **并行 worktree 污染**：运行中可能出现无关 dirty 文件，绝不清理或混入提交。
- **`precheck` 的 Bun 段错误**：单独重跑失败批与全量，保留完整日志。
- **只改草稿/输入框类逻辑**：保留已有内容，明确空串与纯空白的语义，补充连续操作与边界字符的回归测试。
- **用户偏好**：汇报少字、多有序列表。
