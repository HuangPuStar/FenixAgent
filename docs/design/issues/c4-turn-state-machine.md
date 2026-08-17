# C4 · Turn 状态机

> 来源：`docs/design/2026-08-04-yjs-chat-streaming-prd.md`（Q7）
> 性质：聚合状态核心切片

## What to build

引入 Turn 状态机为会话执行状态的**唯一权威**，删除现有会话级扁平 `status` 枚举，前端由 `activeTurn.turnStatus` 派生展示状态。

### 状态机契约（文档 8.1）

```
accepting → running → awaiting_permission → running | cancelled
running → cancelling → cancelled | interrupted
running → completed | failed | interrupted
```

- 终态不可逆；恢复执行必须创建显式的新 turn，不能把已终止 turn 改回 running。
- 默认每会话仅一个活动 turn（并行 turn 不在本次范围）。
- `interrupted` 迁移边由"连接丢失 / 取消超时"触发（不依赖租约，Q5）。

### 实现内容

1. **`activeTurn` 状态字段**（Session Doc `session.activeTurn`：`turnId` + `turnStatus` + 时间戳）为权威状态；`turnId` 与 Chat Doc 的 Entry 关联（entry.turnId），turn 进入终态时相关 streaming entry 同步进入终态。
2. **状态迁移实现**（在 CommandCoordinator 驱动的聚合层内）：
   - `accepting`：用户消息 Action 被接受并写入用户 entry 后；
   - `running`：Agent 开始执行（收到规范化事件的内容增量）；
   - `awaiting_permission`：Agent 请求权限（pendingPermissions 写入，与 C5 衔接）；
   - `cancelling`：用户取消 Action（cancel_turn）；
   - 终态：`completed`（终态事件）/ `failed`（错误事件）/ `cancelled`（Agent 确认取消）/ `interrupted`（连接丢失或取消超时）。
3. **删除**现有扁平 `status`（idle/loading/thinking/responding/tool-calling/waiting-user/done/error/ready/plan）枚举及其写入路径；加载类状态（loading 原因）如需保留，改为派生或独立轻量字段（不承载 turn 执行状态）。
4. **晚到增量丢弃**：turn 进入终态后，晚到的内容增量事件被丢弃（不写入、不广播），保证不出现"已取消但还在输出"的中间态。
5. **前端派生**：前端 hook 由 `activeTurn.turnStatus` 派生展示状态（accepting→思考中、awaiting_permission→等待授权、running→回复中/工具执行中、cancelling→取消中…），映射表集中在 `use-session-state.ts` 内，展示层语义与现状一致。
6. **测试**：`command-coordinator-state.test.ts` 覆盖全转换、终态不可逆（终态后任何输入不能改回 running）、单活动 turn、取消/超时路径。

## Acceptance criteria

- [ ] `command-coordinator-state.test.ts` 全绿：状态机全转换 + 终态不可逆 + 单活动 turn；取消后晚到增量被丢弃（投影无新增内容）
- [ ] Session Doc 只有 `activeTurn.turnStatus` 权威状态，grep 不到旧扁平 `status` 枚举写入路径（前端展示层映射除外）
- [ ] 前端展示状态语义无回归（思考中/回复中/等待授权/取消中与现状一致，人工冒烟 + 前端测试适配后全绿）
- [ ] 取消流程端到端可用：cancel_turn → cancelling → cancelled/interrupted，UI 不出现"已取消还在输出"
- [ ] `bun run precheck` 全绿；`bun run build:web` 通过

## Blocked by

- C3（CommandCoordinator 承载状态迁移驱动）
