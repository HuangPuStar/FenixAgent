# AgentController 上层消费者审计（2026-08-04）

> 背景：编排域重构（AgentController 落地，提交 cc8fdf6c）后，对 `packages/orchestration`
> 上层全部消费者做静态排查。方法：先按消费者划分场景，派发 5 个并行 subagent 深挖各路径，
> 主 agent 再沿 P0/P1 发现抽查源码交叉验证（下文标记 ✅已交叉验证）。
> 本报告是人工验收清单，不包含修复实现。

## 一、场景划分（AgentController 上层消费者）

| 场景 | 消费者路径 | 入口 |
|------|-----------|------|
| A | HTTP 程序化单轮调用 | `routes/api/openai-chat.ts` → `agent-chat-service.openAgentSession` → `spawnInstanceViaController`，dispose 销毁 |
| B | 前端交互式 Chat（YJS relay） | `/acp/yjs/:agentId` → `ws-lifecycle.handleOpen` → `ensureRunning`（复用语义） |
| C | Workflow | `workflow/agent-chat-transport.ts` → `ensureRunning("system", ...)` → `connectAgentRelay`（复用、不随单次执行销毁） |
| D | 外部 API + 系统 meta-agent | `api-instance.ts` → `spawnInstanceViaController`；`meta-agent.ts` → `spawnInstanceViaController("system")` |
| E | 停止 / 回收 / 断连清理 | `instance.ts` stopInstance/stopAllInstances、`acp-idle-monitor.ts`、`acp-ws-handler.ts` machine 清理 → AgentNodeService/AgentNode FSM |

编排域本体：`packages/orchestration/src/agent-controller/index.ts`、`agent-node/*`、
`instance/instance.ts`、`launch-spec/*`；宿主桥接：`src/services/orchestration-instance.ts`、
`orchestration-bootstrap.ts`、`transport/agent-node-bridge.ts`、`services/local-node-service.ts`。

## 二、静态排查发现（按严重度，含交叉验证标记）

### P0

**E-P0.1 机器断连后编排域活跃表/节点引用永久残留（幽灵实例）→ 环境并发额度死锁、无法通过 API 清理** ✅
- `src/services/core-bootstrap.ts:176-189` `unregisterRemoteNode` 直接 `runtime.deleteInstance` +
  `globalInstanceRegistry.unregister`，**不通知 controller**（`agent-controller/index.ts:47` 活跃表、
  `agent-node-service.ts` `#refCounts` 均未清理）
- 后果：supplement 被 reconcile 清掉后 `stopInstance`（`instance.ts:311`）恒返 "Instance not found" →
  web DELETE 永久 404；幽灵实例仍计入 controller 并发检查（`agent-controller/index.ts:64-66,91-93`）→
  maxConcurrency 受限环境永久无法 spawn；`releaseNode` 未调用 → refCount 残留 ≥1 → 节点+计数永久滞留
- 机器重连后 `handleIncomingConnection` 复用节点，幽灵实例状态变回 running，但 core 记录已删、
  supplement 已清 → 三侧状态永久分裂
- 唯一解毒路径：`stopAllInstances` 或重启

### P1

**A-P1.1 openai-chat 路由本地 catch 扁平化所有非 404 错误为 500，全局 error-handler 的编排域映射不生效 + 内部消息泄漏** ✅
- `src/routes/api/openai-chat.ts:70-78` 先于全局插件 `error-handler.ts:27-42` 捕获，仅按 message 子串
  区分 404/500；`ORCHESTRATION_STATUS_MAP`（`error-handler.ts:11-17`：CONCURRENCY_EXCEEDED→409、
  LAUNCH_SPEC_BUILD_FAILED→422、AGENT_NODE_UNAVAILABLE→503、MACHINE_OFFLINE→503）全部落空
- 500 响应体拼接编排域/core 错误原文（envId、machineId、agentConfigId 泄漏）；SSE 流路径
  `openai-chat.ts:97-98` 把 `String(e)` 直接写入流

**A-P1.2 断连节点放行 → 远程节点离线语义回归：旧 MACHINE_OFFLINE(503) 预检消失，变成 NODE_OFFLINE(500)，且状态码随时间漂移** ✅
- `agent-node-service.ts:75-83` `ensureNode` 只拒绝 closing/closed，**disconnected 放行**；随后 core
  `launchInstance` 抛 `CoreRuntimeError("NODE_OFFLINE")`（`instance-orchestrator.ts:111-115`）→ 500
- 断连 3-13s 重试窗口内 500 NODE_OFFLINE；窗口后节点被回收 → `AgentNodeUnavailableError`（本路由仍 500）
- 旧路径有 launch 前 `findMachineConnectionById` 预检（503 MACHINE_OFFLINE），新路径无对应物

**A/D-P1.3 `registerSupplement` 在 try/catch 之外：失败即永久孤儿实例** ✅
- `orchestration-instance.ts:115-136` try 只包 build+launch；`:135` `await registerSupplement` 抛错时
  core 进程 + controller 活跃表 + 节点 refCount 全部残留；无 supplement → idle-monitor 跳过
  （`acp-idle-monitor.ts:188-189`）、`stopInstance` 报 not found、用户并发计数不可见，泄漏至进程重启

**A/D-P1.4 openAgentSession 步骤 3-5 失败无清理：connectAgentRelay / startPromptTurn 抛错时实例泄漏** ✅
- `agent-chat-service.ts:309-329`：spawn 成功后 `connectAgentRelay`（:313）或 `startPromptTurn` rpc error
  reject（:209-211）抛错，无 try/catch 调 stopInstanceViaController；两个调用方（openai-chat.ts:70-78、
  agent-executor.ts:70-76）都拿不到实例引用 → 残留到 idle 回收（300s），期间占用用户额度

**C-P1.1 cleanupSpawnedEnvironments 误杀并发 run 的实例** ✅（transport 读取确认）
- `src/services/workflow/index.ts:33-44` cleanup 停止该 env **全部**运行实例，而非"本次 run spawn 的"；
  `agent-chat-transport.ts:279-281` 仅 spawned 记录 envId，reused 不记录 → 并发 Run A/B 共享实例时，
  A 结束 cleanup 杀掉 B 正在使用的实例；与 I4 注释"停止本路径创建的实例"矛盾

**C-P1.2 共享 relay handle 的会话交叉：并发 run 的 session/new 竞态 + 事件流不隔离** ✅
- `instance-orchestrator.ts:233-235` 同实例复用同一 relay handle；`relay-handle.ts:98-109` fan-out 广播；
  `startPromptTurn` 的 rpcId 恒为 `-1`（`agent-chat-service.ts:166-231`），监听器只按 rpc.id 匹配 →
  并发 run 的 session/new 握手互相满足；`iterateEvents` 取事件流第一个 result → 输出可能串流

**C-P1.3 执行超时"兜底"是 no-op + relay_closed 被静默跳过 → 节点永久挂起** ✅（代码读取确认）
- `agent-chat-transport.ts:84-90`：`DEFAULT_EXECUTE_TIMEOUT_MS`（10min）到点只置 `settled=true` +
  `abortCleanup?.()`，**不 resolve/reject**，Promise 永不 settle（节点 timeout >10min 时永久卡 RUNNING，
  workflow cleanup 永不执行）
- `:134-151`：只识别 `type==="error"`，`relay_closed` 无 jsonrpc 字段被 `continue` 跳过 → 实例被回收/
  断连时节点"不失败也不结束"，最终表现为 600s 超时（可诊断性差）或挂死（>10min 配置）

**C-P1.4 Workflow relay 无 idle 观测信号：relay_count 恒 0、无 activity 埋点 → 长任务被活动硬超时（默认 20min）误杀** ✅
- `touchInstanceActivity` 只在 acp-ws-handler / yjs-frontend 调用；Workflow 路径 `connectAgentRelay`
  直接读 `handle.onMessage` 不埋点；`markInstanceRelayAttached` 仅 yjs-frontend 调用 → supplement 的
  `relayCount:0, lastRelayDetachedAt:spawn时刻` 保持，idle 300s / activity 1200s 照常回收

**B-P1.1 ws-lifecycle.ts:173 的 MACHINE_OFFLINE 分支不可达：机器离线 UX 回归 + 1011 无限重连** ✅（grep 确认）
- `MachineOfflineError`（`packages/orchestration/src/errors.ts:43`）定义 + error-handler 映射 + 测试引用
  存在，但**生产代码无抛出点**；且是 `OrchestrationError` 而非 `AppError`，过不了
  `ws-lifecycle.ts:173` 的 instanceof 检查
- 机器离线时 YJS open 走通用分支 → close **1011** + "Agent connection error"；1011 不在
  `NO_RECONNECT_CODES = {4001,4500,4501}`（`packages/acp-server/src/transport/ws.ts:6-9`）→ 指数退避
  无限重连；`machine_unavailable` 终态 UI（ChatPanel.tsx:269）不可达
- 测试 `yjs-frontend-lifecycle.test.ts:250-272` 钉住的是生产不可达行为

**E-P1.1 节点空闲回收强制关闭在线机器 WS → 每 300s 断连-重连风暴** ✅（agent-node-service 代码确认）
- refCount=0 后 `#startIdleTimer`（300s）→ `node.close()` → connected 分支 `socket.close()` →
  `WsAgentNodeSocket.close` 执行 `ws.close(1000)`——关闭机器与宿主的唯一真实 WS 通道 → 机器端指数退避
  重连 → 注册新节点；机器在线但无实例引用时**每 ~300s 强制断连一次**
- 节点回收语义应是"废弃节点对象"，不应关闭属于机器的 WS

**D-P1.1 connect API 返回的 wsUrl 指向已删除端点 `/acp/relay/:id`** ✅（路由对照确认）｜**已修复**：恢复 `/acp/relay/:agentId` 薄转发端点（`src/transport/relay/external-relay.ts` + `src/routes/acp/index.ts`），wsUrl 附带 `instanceId` query 解决多实例歧义
- `api-instance.ts:126` 返回 `relay.wsUrl = /acp/relay/${environment.id}`，但 `/acp` 只注册
  agents/ws/file-ws/yjs（`routes/acp/index.ts`），无 relay 路由 → 外部客户端 WS 404；
  实例永远 relayCount=0，只能等 idle 回收（每次 connect 产生一个 5 分钟孤儿实例）

### P2（代表性）

- **B-P2.1** ensureRunning 全部失败（AUTO_START_DISABLED / MAX_SESSIONS_REACHED / INSTANCE_NOT_VISIBLE /
  AgentNodeUnavailableError）坍缩为同一行为：1011 + 通用 message，客户端无诊断码；其中
  AUTO_START_DISABLED 是永久失败，重连循环永不成功
- **B-P2.2** 多实例环境 stale sessionId（实例回收后编号不复用）→ `resolveInstanceNumberFromSession`
  抛错 → 4004 关闭，非终态码 → 无限重连
- **B-P2.3** `session:` doc 的 broadcaster 监听器永不注销（`closeReleasedRelay` 只注销 `chat:`），
  长期运行内存增长
- **C-P2.1** 审批（SUSPENDED）run：cleanup 在挂起期间提前执行，resume 后新 spawn 实例无人清理
- **C-P2.2** 子流程（workflow 节点）内 spawn 的实例永不进入 spawnedEnvIds → 泄漏至 idle 回收
- **C-P2.3** relay listener 泄漏：同实例 N 次 run 累积 N 个死 listener（≤5000 条队列/个），永不注销
- **C-P2.4** 编排域节点信道（AgentNode.send）在宿主侧零调用点；机器断连/重连只删 core 记录，
  编排域活跃表成僵尸（与 E-P0.1 同根）；local-default stub 永不触发断连 → 状态恒 running
- **C-P2.5** `ensureRunning("system", ...)` 所有 Workflow 实例计入 "system" 用户桶，配额语义错位
- **D-P2.1** meta-agent ensure 每次无条件新 spawn（不复用运行实例），`:390-395/:415-420` 吞掉全部
  spawn 错误并返回 success:true 但无 instanceId → 客户端"成功"却无实例
- **D-P2.2** 编排域错误在 `/api/instances` 全降级为 500/INTERNAL_ERROR（`mapApiError` 要求 statusCode+code，
  OrchestrationError 只有 code），且 message 泄漏 envId/machineId
- **D-P2.3** API connect 路径绕过环境级并发闸（maxConcurrency 硬编码 1000 虚设，`environment-orchestration.ts:66-70`）
- **A/E-P2.1** web DELETE 重复停止返回 404，与 `instance.ts:325-327` 注释的 200 契约矛盾；
  `instances.ts:94-97` "Already stopped" 分支是死代码
- **E-P2.1** sweep 路径 `triggerMachineCleanupByMachineId`（`acp-ws-handler.ts:415-435`）不调用
  `dispatchAgentNodeWsClose`（与 performMachineCleanup 不一致）→ 节点保持 connected，`WsAgentNodeSocket.send`
  在 `readyState!==1` 时静默 return——**消息丢失无异常**
- **E-P2.2** AgentNode 自动重连是纯 FSM 空转（无真实重连机制），断连期间实例 status 在 error/starting
  间抖动 ~33s；`ensureNode` 对 disconnected/uninitialized 节点照常返回成功 → spawn 走死信道等 30-60s 超时
- **A-P2.1** 用户级并发检查 TOCTOU（检查→registerSupplement 之间核心启动窗口内并发不可见，可超发 1+）
- **A-P2.2** 双构建 nodeId TOCTOU：controller 读 env 决定 machineId，`spawnInstanceViaCore` 重读 env 决定
  core nodeId，两次读取间 machineId 变更会错位（refCount 记旧节点、实例启在新节点）

### 已确认正常（静态证据）

- YJS 不变量 11 条中 9 条符合（rcsSessionId 确定性、快照时序、cwd 注入、status 门禁、广播隔离、
  后端写 doc、事务清理、refCount 共享）；2 条警告（回放兜底分支 `session-transition.ts:83-90` return true、
  64KB 背压静默丢弃）
- extraEnv 全链路注入（meta-agent → buildAgentLaunchSpecForCore → core → acp-link 进程 env）✅
- 多租户 userId/orgId 传递完整（api-instance 环境过滤、meta 三元组、supplement 归属）✅
- 正常路径 dispose 幂等（openai-chat 流式/非流式/scheduler finally 均触发 turn.dispose）✅
- 桥接层 launch 失败回滚（orchestration-instance.ts:120-130）与 controller 二次并发检查回滚（:94-103）✅
- `stopAllInstances` 休克疗法无实际遗漏（core stop 幂等兜底）✅

## 三、人工验收点清单（按优先级）

### P0 验收

1. **幽灵实例死锁（E-P0.1）**
   触发：远程机器上线跑 1 实例（maxConcurrency=1）→ kill 机器进程 → 等心跳超时（90s）/sweep（60s）
   预期（现状）：`GET /web/instances/activity` 实例消失；再 spawn 返回 409 并发超限（即使 core 无实例）；
   `DELETE /web/instances/<id>` 404。看：controller.listInstances()、AgentNodeService.activeCount()/
   refCounts 残留、机器重连后实例状态（应修复为：断连清理同步活跃表 + releaseNode，环境可立即 spawn）

### P1 验收

2. **机器离线 UX（B-P1.1）**：停掉远程机器 acp-link → 打开该 agent Chat 页。现状：WS 1011 关闭 +
   页面无限重连；服务端日志 AGENT_NODE_UNAVAILABLE。期望修复后：4500 + machine_unavailable 终态 UI
   （ChatPanel.tsx:269 手动重试）。看：浏览器 WS close code、yjs-ws.ts:16 的 4500 分支

3. **断连窗口 spawn（A-P1.2）**：断开机器 WS 后 13s 内 POST /api/agents/:id/v1/chat/completions。
   现状：500 "Core node is offline: <machineId>"；13s 后 500 AgentNodeUnavailable。旧语义 503 MACHINE_OFFLINE

4. **错误映射与泄漏（A-P1.1 / D-P2.2）**：`RCS_USER_AGENT_MAX_CONCURRENCY=1` 起满实例后再调用 chat/
   connect。现状：500 + message 含 envId/machineId；期望 429/503 且不暴露标识

5. **registerSupplement 孤儿（A/D-P1.3）**：单测注入 environmentRepo.getById 抛错。现状：core 实例运行 +
   controller 有条目 + registry 无 supplement + idle 永不回收 + 仅 stopAllInstances 可清

6. **会话中途失败泄漏（A/D-P1.4）**：配置 session/new 必失败的 agent 调 chat。现状：500 但实例残留
   （relay_count=0、idle_kill_eligible=true），300s 后被回收，期间占用户额度

7. **Workflow 并发干扰（C-P1.1/C-P1.2）**：同 env 两个并发 workflow run（一长一短）。现状：短 run 结束后
   长 run 实例被 `[wf-execute] background cleanup` 停止，或两 run 输出串流（日志中两 run 拿到相同
   sessionId）。期望：两 run 互不影响

8. **Workflow 长任务挂起（C-P1.3）**：agent 节点 timeout=1200，中途手动停实例。现状：run 永久 RUNNING、
   节点永不失败；10min 时超时兜底 no-op。期望：可预期失败（NODE_TIMEOUT 或"实例被回收"）+ cleanup 执行

9. **Workflow idle 误杀（C-P1.4）**：workflow 单节点任务执行 >20min。现状：`[ACP-IDLE] Stopping inactive
   instance` 后 relay 被关、节点挂起。期望：workflow 活跃期间不被回收

10. **节点回收断连风暴（E-P1.1）**：机器在线 → 启动实例 → 停止实例 → 等 300s。现状：`[ACP-WS-CLOSE]` +
    `[MACHINE-CLEANUP]` 出现、机器端 disconnected/reconnecting、每 300s 循环。期望：节点回收不关机器 WS

11. **connect API 死端点（D-P1.1）已修复**：POST /api/agents/:id/instances/connect → 用返回 wsUrl 发起 WS
    upgrade。现状：404；实例 300s 后 `[ACP-IDLE]` 回收。修复后：WS 升级成功、`new-session`/`prompt` 可跑通、
    连接期间实例不被 `[ACP-IDLE]` 回收（relayCount=1），断开后约 300s 正常回收

12. **机器重连状态一致性（E-P0.1 变体）**：机器断连（产生幽灵实例）→ 重连 → 对比 activity 列表与
    controller.listInstances()。现状：activity 无实例但 controller 显示 running（占并发额度），机器端旧
    Agent 进程仍在跑。期望：重连即对账清理

13. **静默丢包（E-P2.1）**：机器断连后 sweep 触发清理（非 WS close 路径），期间对实例发消息。
    现状：无异常无回执（WsAgentNodeSocket.send 在 readyState!==1 时静默 return）。期望：断连即
    disconnected/error、send 抛 AgentNodeUnavailableError

### P2 验收（抽样）

14. **stale sessionId 循环（B-P2.2）**：maxSessions=2 环境启两实例，停 #2 后用旧 `ses_inst_{env}_2` URL
    重连。现状：4004 + 无限重连

15. **meta 实例堆积（D-P2.1）**：同一用户 300s 内连续 12 次 POST /web/meta-agent/ensure。现状：前 10 次
    有 instanceId，第 11 次起 success:true 但无 instanceId（错误被吞），活动视图 10 个 relay_count=0 实例

16. **审批/子流程泄漏（C-P2.1/C-P2.2）**：含 audit 节点 workflow 挂起时实例被提前 cleanup，approve 后
    新实例残留；子流程 agent 节点 spawn 的实例永不清理（5min 内可见）

17. **relay listener 泄漏（C-P2.3）**：同实例连续 5 次含 agent 节点的 workflow，relay-handle.ts:69
    listeners.size 线性增长永不回退

18. **web DELETE 幂等（A/E-P2.1）**：DELETE /web/instances/:id 连续两次。现状：第一次 200 第二次 404，
    与注释契约矛盾

## 四、交叉验证记录（主 agent 抽查）

| 发现 | 验证方式 | 结论 |
|------|---------|------|
| E-P0.1 幽灵实例 | 读 core-bootstrap.ts:147-189（unregisterRemoteNode 无 controller 清理） | ✅ 成立 |
| C-P1.3 超时 no-op | 读 agent-chat-transport.ts:84-121（timeout 分支不 settle Promise） | ✅ 成立 |
| D-P1.1 死端点 | 对照 routes/acp/index.ts 路由表（无 /acp/relay） | ✅ 成立 |
| B-P1.1 MACHINE_OFFLINE 死分支 | grep MachineOfflineError/MACHINE_OFFLINE（仅定义/映射/测试，无生产抛出点） | ✅ 成立 |
| A-P1.1 错误扁平化 | 读 openai-chat.ts:70-78（message 子串嗅探 + 拼接内部消息） | ✅ 成立 |

## 五、修复优先级建议

1. **P0 先行**：E-P0.1（断连清理同步编排域活跃表 + releaseNode）——所有远程场景的根
2. **同根问题合并**：A-P1.2 / B-P1.1 / E-P2.1 / E-P2.2 均源于"编排域节点状态与真实连接/错误语义未打通"，
   建议统一在 agent-node-bridge + AgentNodeService 层补状态透传（connected→send 可用、断连→错误上抛）
3. **错误映射收敛**：A-P1.1 / D-P2.2 应移除路由本地 catch，统一走全局 error-handler（409/422/503 映射
   已存在），并对 message 脱敏
4. **泄漏路径统一治理**：A/D-P1.3（registerSupplement 移入 try 并回滚）、A/D-P1.4（openAgentSession
   try/catch 包裹）、C-P2.1/2.2（cleanup 记录真实 spawn 集合）
5. **Workflow 信号缺失**：C-P1.4（touchInstanceActivity 埋点到 agent-chat-transport）、C-P1.3
   （timeout 兜底 settle + relay_closed 处理）
6. **移除/修复死代码**：E-P1.1（节点回收不关机器 WS）、D-P1.1（/acp/relay 端点或删除 wsUrl 字段——已选
   恢复端点并完成）、B-P1.1（ws-lifecycle.ts:173 分支与测试对齐）

> 关联文档：`docs/arch/remote-node-investigation.md`（断裂点 3/7/8 与本报告 E-P0.1、E-P2.1、B-P1.1 同源）。
