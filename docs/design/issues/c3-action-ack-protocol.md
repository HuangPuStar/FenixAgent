# C3 · Action/Ack 协议 + CommandCoordinator

> 来源：`docs/design/2026-08-04-yjs-chat-streaming-prd.md`（Q5/Q9）
> 性质：协议层核心切片

## What to build

建立 CommandCoordinator 控制面：前端 Action 携带 `commandId`（UUID），服务端完成校验、幂等去重与两阶段 Ack，业务效果恰好一次。

### 协议契约（PRD Action / Ack 章节）

```ts
// 前端发送（Q9：前端只加 commandId）
interface ClientAction<TType extends string, TPayload> {
  commandId: string;              // 幂等键，同会话唯一（前端生成 UUID）
  type: TType;
  sessionId: string;
  payload: TPayload;
}
// protocolVersion / expectedProjectionVersion / client 信封字段在协议类型中保留定义，
// 由服务端按会话绑定补充与校验，前端不感知（乐观并发增强留二期）

interface ActionAck {
  type: "action_ack";
  commandId: string;
  status: "accepted" | "committed" | "duplicate";
  turnId?: string;
  committedProjectionVersion?: number;
}

interface ActionError {
  type: "action_error";
  commandId: string;
  code: "UNAUTHENTICATED" | "FORBIDDEN" | "SESSION_NOT_FOUND" | "VERSION_CONFLICT"
      | "INVALID_STATE" | "RATE_LIMITED" | "AGENT_UNAVAILABLE" | "PAYLOAD_TOO_LARGE";
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}
```

### 实现内容

1. **`channel/command-coordinator`**：Action 校验（会话存在、状态合法、payload 结构）、`commandId` 幂等去重表（每 `rcsSessionId` 进程内 Map：`commandId → ack 结果`，覆盖客户端最大重试窗口，随实例生命周期释放；重复 Action 返回原 Ack/`duplicate`，**不重复调用 Agent**）、命令串行化（每 `rcsSessionId` 有界队列）。
2. **两阶段 Ack**：`accepted`（进入队列）→ `committed`（业务事实已提交，含 `committedProjectionVersion`）；`ActionError` 稳定错误码 + `retryable` 标记。
3. **前端最小配合（Q9）**：`ChatPanel.tsx` 的 `sendViaWs` 及所有 action 发送点（create/load/resume/send_prompt/cancel/respond_permission 等）携带 `commandId`（UUID 生成，一次生成重试复用）；前端类型来自 `@fenix/chat-channel` 导出。
4. **Action 路由**：从原 `yjs-frontend/` 迁移 action 处理逻辑（session-transition 的守卫：`load_session` 需合法 sessionId、Agent status 到达前不发 `list_sessions`、`cwd` 服务端注入等），全部收敛进 CommandCoordinator / SessionChannel。
5. **协议层测试 seam**（Q12）：包内集成测试，实例化控制器（注入 fake 依赖），用假连接对象发送 Action，断言 `action_ack` / `action_error` 与 `yjs:update` 投影结果；无真实网络、无真实 Agent。

## Acceptance criteria

- [ ] `session-channel-action.test.ts` 全绿：Action → Ack → 投影全链路；`commandId` 去重（重发返回原 Ack、Agent 只被调用一次）；版本冲突返回 `VERSION_CONFLICT`；非法会话/状态返回稳定错误码
- [ ] `command-id-dedup.test.ts` 全绿：去重表覆盖重试窗口、重复 Action 不重复调 Agent、随实例生命周期清理
- [ ] 前端 `sendViaWs` 等发送点全部携带 `commandId`，重试复用同一 ID（代码审查确认）
- [ ] 既有守卫语义保留：`load_session` 非法 sessionId 拒绝、Agent status 未达不发 `list_sessions`、`cwd` 由服务端注入
- [ ] `bun run precheck` 全绿；`bun run build:web` 通过

## Blocked by

- C2（聚合层新 schema 投影完成，Ack 的 `committedProjectionVersion` 依赖投影版本）
