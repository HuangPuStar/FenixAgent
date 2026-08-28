# TODO

> 遗留项登记：yjs/chat 链路优化中确认存在但不在当前变更范围内的债务。
> 每项标注证据、影响与处理方向；完成一项删除一项（git 历史可追溯）。

## 架构收敛

- [ ] **PlanEntryPriority / PlanEntryStatus 三处分叉**：`packages/chat-channel` 包内、
  `packages/acp-link`、`web/src/lib/types.ts` 各有一份独立定义，根出口被 acp-link
  同名遮蔽，web 侧另有副本——三处已分叉。影响：类型漂移无法被编译器发现。
  处理方向：确定唯一权威定义（建议 acp-link 或 chat-channel），其余改为 re-export。
  （证据：dead-code-audit-chat-chain.md「隐性分叉」节）

## 前端（需先建测试基础设施）

- [ ] **renderHook 测试辅助提取**：`web/src/__tests__/drag-upload.test.ts` 仍手写
  `react-dom/client` renderHook（注释「项目无 @testing-library/react」）。是
  ACPMain bootstrap 重构（下方两项）的前置条件。
- [ ] **ACPMain bootstrap 逻辑抽取**：3 个 effect + `sessionEnteredRef` +
  300ms 防抖定时器耦合在组件内，无测试配套。抽取为纯函数/hook 后可回归
  覆盖「列表未确认不自动建会话」「空列表自动建会话」等历史 bug 场景。
- [ ] **连接守卫与状态源统一**：`connectionState`（WS 连接状态）与
  `chatState.activeSessionId` / `sessionListLoaded`（Y.Doc 投影）是两套状态源，
  bootstrap effect 依赖两者组合，历史死锁/竞态均源于此。处理方向：
  ConnectionPhase 单状态机派生，消除组合条件漂移。

## chat-channel 包内低优先清理

- [ ] **导出面收窄**：`expireTurnPermissions`、`cancelTurnToolCalls`、
  `mergeYjsSnapshotWithCas`、`getSessionsMap`、`UpdateHandler` 仅包内消费，
  可降级为非导出（turn-machine.ts:58,73 等）。影响：减小对外契约面。
- [ ] **零消费者便利导出**：`index.ts` 10 个 acp-link 便利转导出
  （AgentCapabilities / ModelInfo / SessionUpdate 等）、`types.ts` 导出类型零直接
  import（LoadingState 等，结构性活跃；ToolRun / ArtifactRef 已随 SP-B2 死字段删除）。
  需逐项确认后删除或改为内部类型。
- [ ] **M7 chat-writer 拆分**：494 行接近 500 行红线；按 entry 写入 /
  toolCalls / session 元信息拆分。风险：import 调整面大，暂缓至下次触碰时。

## 其他

- [ ] **测试目录统一**：`packages/chat-channel/src/__tests__/` 与
  `packages/chat-channel/src/channel/*.test.ts` 并存（channel 测试放在被测
  文件同目录），统一归集后与 `src/__tests__/` 惯例对齐。
