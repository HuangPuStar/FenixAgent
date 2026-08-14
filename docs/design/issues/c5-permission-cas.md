# C5 · 权限 CAS

> 来源：`docs/design/2026-08-04-yjs-chat-streaming-prd.md`（Q8）
> 性质：权限安全切片

## What to build

权限请求与解析按文档落地 CAS 语义：`pendingPermissions` 位于 Session Doc（C2 已落地结构），解析是原子迁移（仅 `pending → resolved` 一次），迁移成功后才向 Agent 发送 `permission.resolve`，防止重复授权导致 Agent 执行两遍。

### 实现内容

1. **CAS 解析**：`pendingPermissions` 中每个请求的状态机为 `pending → resolved(approved/denied)`（或超时/会话切换时的终态迁移，如 `expired` / `cleared`）；解析实现为原子迁移（进程内单写者语义 + 状态校验），重复 `permission_response`（相同 `permissionId`）只有第一次生效，后续返回原结果。
2. **与 ACPChannel 衔接**：CAS 迁移成功后才向 Agent 发送 `permission.resolve`；重复响应不重发；权限请求与 `activeTurn` 关联（turn 处于 `awaiting_permission` 时有效，turn 进入终态后请求随之失效清理）。
3. **超时与清理**：权限请求带超时；超时 / 会话切换 / 断链（两类断链）时迁移到终态并清理，不残留 pending 项。
4. **前端适配**：权限请求 UI 数据源改为 Session Doc `pendingPermissions`；提交授权走带 `commandId` 的 Action（C3 协议）；"只能解决一次"在前端体现为响应后立即置为已处理（后端 CAS 兜底）。
5. **安全边界**：敏感策略与工具参数不进入公开视图（Y.Doc 只存展示所需字段）；错误响应只含脱敏 `PublicError`。
6. **测试**：`permission-cas.test.ts` 覆盖：CAS 原子迁移（重复响应仅第一次生效）、迁移成功才发 resolve（失败不发）、超时/切换/断链终态、pending 残留清理。

## Acceptance criteria

- [ ] `permission-cas.test.ts` 全绿：重复 `permission_response` 只有第一次生效且 Agent 只收到一次 resolve；超时/断链/切换后请求进入终态并清理
- [ ] `permission.resolve` 只在 CAS 迁移成功后发送（代码审查 + 测试断言）
- [ ] 前端权限 UI 基于 Session Doc `pendingPermissions`，授权响应走带 `commandId` 的 Action
- [ ] 权限请求与 `activeTurn` 关联：turn 终态后请求失效清理
- [ ] 敏感策略/工具参数不进入 Y.Doc 与日志（代码审查）
- [ ] `bun run precheck` 全绿；`bun run build:web` 通过

## Blocked by

- C2（`pendingPermissions` 结构落地）
- C4（`awaiting_permission` turn 状态与 `activeTurn` 关联）
