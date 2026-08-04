# 待决策设计项：AgentNode 自动重连 FSM 空转（E-P2.2）与 workflow 配额桶（C-P2.5）

> 状态：**决策已完成**（2026-08-04）——E-P2.2 选方案 A；C-P2.5 选方案 C（真实 userId 隔离）。
> 决策记录见文末「四、决策结果」；实现与验证随后续提交落地。
> 背景：这两项从 `docs/arch/agent-controller-consumers-audit.md` 的 P2 清单中单独摘出，因为
> 修复方向依赖架构语义决策（连接方向、配额模型），不适合按"自动批次"方式直接实现。
> 其余 P2 项已随 56db60d1 / 4916f412 / 5e91ab5a 三个提交自动完成。

---

## 一、E-P2.2 AgentNode 自动重连是纯 FSM 空转

### 1. 现状与证据

`AgentNode`（`packages/orchestration/src/agent-node/agent-node.ts`）声称"意外断连进入
disconnected 并由内部定时器自动重连（对象不销毁）"（文件头注释 :6-7），但**定时器重连路径
没有任何真实连接动作**：

| # | 事实 | 证据 |
|---|------|------|
| 1 | socket 只能由构造传入；`_attachSocket` 的唯一业务调用点是宿主 `handleIncomingConnection` 的复用分支 | `agent-node.ts:55`（构造 `_attachSocket(options.socket)`）；`agent-node-service.ts:53`（复用分支 `existing._attachSocket(socket)`） |
| 2 | 真实重连完全由**机器端**驱动：机器断连 → socket close/error → `_handleDisconnected`；机器重连（新 WS）→ 宿主 `handleIncomingConnection` → attach 新 socket + `_handleConnected` | `agent-node.ts:123-141`；`agent-node-service.ts:50-72` |
| 3 | `#scheduleReconnect`（断连后定时器）到期只做 `transition("connect")`（进入 connecting）+ `#startConnectTimer`——**不发起连接、不重建 socket** | `agent-node.ts:186-203` |
| 4 | `#startConnectTimer` 超时（10s）后 `transition("fail")` → uninitialized + `notifyAutoReconnectStopped` | `agent-node.ts:206-217`；`types.ts:15` `DEFAULT_CONNECT_TIMEOUT_MS = 10_000` |
| 5 | 每次断连空转约 33s 才耗尽：reconnectDelay 1s + connectTimeout 10s，× maxRetries 3（宿主 `agent-node-bridge.ts:33` 配置） | `types.ts:17`；`agent-node-bridge.ts:8` 注释明示"断连后至多自动重试 3 次，之后保持 disconnected 等待宿主重连" |
| 6 | 空转的唯一实际副作用：重试耗尽 → `onAutoReconnectStopped` → AgentNodeService 在无实例引用时关闭并移出节点 | `agent-node-service.ts:169-175` |

**结论**：`AgentNode` 没有发起连接的能力（无 machineId → 端点/凭证解析，无连接工厂注入），
"自动重连"只是 FSM 状态机的冗余表演。机器端（acp-link）主动连接宿主的架构下，真实恢复路径
完全走 `handleIncomingConnection`，不受空转定时器阻塞（机器在 connecting 窗口期重连到达时
`_isUsable` 为 true，`_handleConnected` 从 connecting → open，无竞态故障）。

### 2. 实际影响

- **诊断误导**：节点状态在 disconnected → connecting → uninitialized 间抖动约 33s，
  `Instance.status` 懒查询自节点状态（`instance/instance.ts`），实例 status 随之在
  error/starting 间抖动；日志/监控/宿主看到虚假的"连接尝试"信号，实际没有任何网络动作。
- **回收延迟**：无引用断连节点要等空转耗尽（33s）才被回收，而不是断连即评估。
- **维护陷阱**：FSM 语义（"自动重连"）与现实（"机器主动连回"）脱节，后续维护者容易
  误以为节点具备自愈能力，或误改 `#scheduleReconnect` 引入真实重连却缺少连接工厂。

### 3. 候选方案

| 方案 | 内容 | 优点 | 代价/风险 |
|------|------|------|-----------|
| **A. 移除空转，断连即终态**（推荐） | 删除 `#scheduleReconnect`/`#startConnectTimer` 空转逻辑；`_handleDisconnected` 的 connected 分支直接进入 uninitialized 并通知宿主；状态机收敛为 connected ↔ 断连终态，恢复完全交给 `handleIncomingConnection` | 消除虚假状态抖动与诊断误导；回收时机提前（断连即评估）；代码减少约 40 行；与既有真实重连路径（宿主驱动）完全一致 | 行为变化：节点状态不再有 connecting 中间态；需同步 agent-node-service.test.ts 中 6+ 处钉住空转行为的测试 |
| **B. 接入真实重连能力** | 给 `AgentNode` 注入连接工厂（machineId → 端点/凭证解析 + 发起 WS 的回调），定时器到期后真正重连 | 满足"节点自愈"语义；未来宿主主动连机器的架构可复用 | 当前架构下机器必须主动连宿主（acp-link），宿主没有发起连接所需的路由/认证信息；改动面大（agent-node-bridge、acp-ws-handler、配置） |
| **C. 保持现状 + 文档澄清** | 不改代码，仅把"自动重连由机器端驱动，FSM 定时器仅用于耗尽回收"写入节点类注释与设计文档 | 零改动 | 状态抖动与诊断误导持续存在；注释与文件头"自动重连"语义的矛盾仍在 |

### 4. 需要决策的问题

1. **连接方向是否长期不变**：机器端（acp-link）主动连宿主是否是不可变的架构前提？
   若是 → 方案 A；若未来需要宿主主动连机器（如按需拉起机器）→ 方案 B。
2. **断连节点回收时机**：无引用断连节点应"断连即回收"（更快释放管理集合，方案 A 隐含）
   还是保留观察窗口（避免机器秒回导致节点抖动重建，现状 33s 空转即一种窗口）？
   若保留窗口，窗口时长与由谁驱动回收（宿主 sweep？断连事件？）需要定义。
3. **状态语义**：`disconnected` 状态是否值得保留（语义：机器断连、等待机器重连），
   还是断连后直接 uninitialized（等待新连接重建）？当前 FSM 的 disconnected/connecting
   两个中间态在无真实重连时都没有信息量。

### 5. 推荐

**方案 A**：当前架构下机器必须主动连宿主，"自动重连"语义不成立，空转定时器是纯负债。
建议保留 `notifyNodeDisconnected`（上批次已加，宿主 sweep 路径用）与
`onAutoReconnectStopped`（回收信号），把"重连"语义从节点内部定时器移到宿主连接事件
（`handleIncomingConnection`），断连后节点直接进入等待重连的终态。

---

## 二、C-P2.5 workflow 实例计入 "system" 用户桶，配额语义错位

### 1. 现状与证据

Workflow 路径启动实例时，userId 恒为字面量 `"system"`：

```
agent-chat-transport.ts:336  ensureRunning("system", envRow.id, "system")
  → instance.ts:430  spawnViaOrchestration("system", environmentId, "system")
  → orchestration-instance.ts  spawnInstanceViaController(environmentId, "system", "system")
  → agent-concurrency.ts:68    beginSpawnReservation("system", "system")
  → assertAgentConcurrencyAvailable("system", "system")   // userId = "system"
```

`assertAgentConcurrencyAvailable`（`agent-concurrency.ts:150-170`）按三档限额检查：
- 总限额 `RCS_AGENT_MAX_CONCURRENCY`（全平台，跨租户）——正确生效
- **用户限额 `RCS_USER_AGENT_MAX_CONCURRENCY`：按 `getActiveUserAgentCount(userId)` 统计，
  userId="system" 使所有 workflow 实例聚合成一个"system 用户"桶**（`agent-concurrency.ts:121-140`）
- 定时限额 `RCS_SCHEDULED_AGENT_MAX_CONCURRENCY`：仅 source==="scheduled" 计入——不受影响

### 2. 实际影响

| 影响 | 说明 |
|------|------|
| **跨租户配额共享** | 所有租户的 workflow 实例共享同一 "system" 桶：`RCS_USER_AGENT_MAX_CONCURRENCY` 配 5 时，租户 A 的 5 个 workflow 实例会让租户 B 的 workflow 全部 429——多租户隔离被破坏（CLAUDE.md「所有功能均按多租户设计」） |
| **配额意图错位** | `RCS_USER_AGENT_MAX_CONCURRENCY` 的意图是"每用户并发 Agent 实例上限"；workflow 用字面 "system" 参与统计，该配置实际变成"全平台 workflow 并发上限"，且无人知道 |
| **反向不约束** | workflow 实例不计入触发用户的桶：单用户可用 workflow 路径绕过自己的用户限额（只要 system 桶与总限额没满） |

对比：meta-agent 路径（`meta-agent.ts:383/408`）用**真实 ctx.userId** + source="system"——
meta 实例正确计入发起用户桶，只有 workflow 路径用字面 "system"。

### 3. 候选方案

| 方案 | 内容 | 优点 | 代价/风险 |
|------|------|------|-----------|
| **A. source="system" 豁免用户限额**（推荐） | `assertAgentConcurrencyAvailable` 在 `source === "system"` 时跳过 userLimit 检查（仍受 totalLimit 与 scheduledLimit 约束） | 消除跨租户共享配额；workflow 天然受 env 级 `maxSessions`（`environment-orchestration.ts:69-70`）约束，用户级配额对它无意义；改动 ~5 行 | 行为变化：workflow 实例不再受 `RCS_USER_AGENT_MAX_CONCURRENCY` 限制；若有部署依赖该隐式限制需评估（该限制当前语义本来就是错的） |
| **B. 独立 workflow 限额** | 新增 `RCS_WORKFLOW_AGENT_MAX_CONCURRENCY` 环境变量，system 桶改用该配置 | 保留"全平台 workflow 上限"能力（若产品确实需要） | 新增配置面（env.ts + 部署透传 + 文档）；与 A 的差异仅在"是否需要独立上限" |
| **C. 发起人透传** | 把 run 触发者 userId 透传进 workflow 的 ensureRunning | 理论上最"正确" | workflow 实例是系统级复用/共享的（同一实例被多个 run、可能多个用户复用），归入发起人桶语义同样错误；agent-chat-transport 的 connect 调用点在 engine 内无用户上下文，改动穿透 workflow-engine 包，成本最高 |

### 4. 需要决策的问题

1. **workflow 实例是否应受任何用户级配额约束**？建议否——env 级 `maxSessions` 已是
   workflow 实例数的天然上限（每环境），用户级配额本意是约束"用户交互打开"的实例数。
2. **是否需要全局 workflow 并发上限**（独立于 `RCS_AGENT_MAX_CONCURRENCY`）？
   需要 → 方案 B（新配置）；不需要 → 方案 A。
3. **兼容性**：修改后 workflow 不再计入用户限额统计。`/web/instances/activity` 等视图
   按 supplement.userId 展示（workflow 实例 userId="system"），展示语义是否需要同步调整？

### 5. 推荐

**方案 A**（或 A+B 组合）：`source === "system"` 时跳过 userLimit 检查，消除跨租户误伤；
若产品需要全局 workflow 上限再叠加 B。当前实现把 `RCS_USER_AGENT_MAX_CONCURRENCY`
变成隐式的全平台 workflow 上限且跨租户共享，属于明确的语义错误而非特性。

---

## 四、决策结果（2026-08-04 人工确认）

1. **E-P2.2 → 方案 A**：移除节点内部自动重连空转，断连即终态；**server 端不发起重连，
   重连只由远端 machine 主动连回宿主驱动**（`handleIncomingConnection` 新连接重建/复用节点）。
2. **C-P2.5 → 方案 C（真实 userId）**：不使用豁免（A）也不使用独立桶（B）；workflow
   run 触发者的真实 userId 透传至 `ensureRunning`，**无论谁触发，实例都计入触发者自己的
   用户桶，按 userId 隔离**。

实现要点（决策后确认的落地范围）：

- E-P2.2：删除 `AgentNode.#scheduleReconnect` / `#startConnectTimer` 空转逻辑；
  `_handleDisconnected` 的 connected 分支直接进入等待重连终态并通知宿主；
  保留 `notifyNodeDisconnected`（sweep 路径）与 `onAutoReconnectStopped`（回收信号）；
  同步更新 agent-node-service.test.ts 中钉住空转行为的用例。
- C-P2.5：workflow 触发入口（web 路由 / API / 定时任务 / 审批 resume）取真实 userId，
  经 `runAsync` 执行上下文透传至 `Transport.connect` → `ensureRunning(userId, ...)`；
  `source` 保持 "system"（不影响 scheduled 桶判断）；复用实例的 supplement.userId
  保持首次 spawn 者（既有语义），新 spawn 使用触发者 userId。
