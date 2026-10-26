# GitLab MCP 工具速查

本文件只记录本工作流会用到的工具与参数。工具名以当前会话目录为准，名称格式为 `mcp__gitlab__<tool>`。

## 项目定位

| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| `search_repositories` | 按关键词找项目 | `query`、`per_page` |
| `list_projects` | 列出可访问项目 | `search`、`membership`、`simple` |
| `list_issues` | 列项目 issue | `project_id`、`state`、`per_page`、`jmespath` |
| `my_issues` | 当前用户的 issue | `state`、`jmespath` |

`project_id` 接受完整路径（如 `aos-test/aos-e2e-test`）或数字 ID。路径里的 `/` 需要 URL 编码时由 MCP 处理；直接传路径即可。

## 读取 issue

```text
mcp__gitlab__get_issue
  project_id: "aos-test/aos-e2e-test"
  issue_iid: "40"
```

返回字段关注：`iid`、`title`、`description`、`state`、`labels`、`web_url`、`created_at`、`updated_at`。

常见误判：

- `issue_iid` 是项目内编号，不是全局 `id`。
- 404 优先怀疑项目路径或 IID 归属，不要先断定 issue 不存在。
- 返回的 `web_url` 可能是 `/-/work_items/<iid>`，这是 GitLab 的正常展示形式。

## 读取讨论

```text
mcp__gitlab__list_issue_discussions
  project_id: "aos-test/aos-e2e-test"
  issue_iid: "40"
```

- 返回 `null` 表示没有讨论。
- 用 `jmespath` 过滤时，先确认返回结构是数组还是对象；过滤结果为空不等于接口失败。

## 回帖

```text
mcp__gitlab__create_issue_note
  project_id: "aos-test/aos-e2e-test"
  issue_iid: "40"
  body: "..."
```

回帖模板：

```markdown
修复已完成，等待 PR 合并。

- PR: <链接>
- 分支: `fix/<slug>`
- 根因: <一句话>
- 修复: <范围与行为变化>
- 回归测试: <覆盖场景与结果>
- 门禁: <命令与结果>
- 说明: PR 尚未合并，本 issue 保持 open，合并后可关闭。
```

需要回复某条讨论时传 `discussion_id`；普通进展更新不要传，创建顶层 note。

## 进展更新（每次推送 / CI 变化）

GitLab 同步是 workflow 的一部分，不是合并时的一次性动作。每次追加提交、CI 全绿、CodeRabbit 意见处理后都应回帖；同一轮推送的「commit + CI」可以在 CI 出结果后合并成一条。

```markdown
进展更新：
- commit: `<sha>` <标题>
- PR: <链接>
- CI: <通过数>/<总数> pass（run <id>）
- CodeRabbit: <状态 / 结论>
- 遗留: <未完成项；无则写「无」>
```

只写可公开的事实；不要贴 token、环境变量或内部日志原文。

## 关闭 / 改字段

```text
mcp__gitlab__update_issue
  project_id: "aos-test/aos-e2e-test"
  issue_iid: "40"
  state_event: "close"
```

- 只在 PR 合并后关闭，或用户明确要求时关闭。
- 需要修改描述时优先用 `update_issue_description_patch`（支持 `dry_run`），避免整段覆盖。
- 不要为了「看起来处理完了」提前改 `state`、labels 或 assignee。

## 错误处理

| 现象 | 优先排查 |
| --- | --- |
| 404 Not Found | 项目路径、IID 是否属于该项目、issue 是否被删除 |
| 403 / 权限错误 | 当前 GitLab 账号是否为目标项目成员；不要重试到成功为止 |
| 讨论为 `null` | 正常空结果，继续读 issue 描述 |
| 回帖成功但内容为空 | 检查 `body` 是否为空串；空评论没有业务意义 |

## 安全边界

- 回帖、PR 正文、commit、日志中不得出现 token、密钥、连接串、完整环境变量。
- 不把 GitLab 返回的敏感字段原样贴到公开位置。
- 不代替他人发言，不修改与修复无关的 issue 字段。
