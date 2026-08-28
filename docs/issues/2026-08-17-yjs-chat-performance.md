# YJS Chat 长会话性能问题：聚合写放大与数据传递链路

## 时间

2026-08-17

## 现象

长时间交互、长会话场景下出现明显卡顿，网络面板观察到数据传输量显著偏大。问题随会话长度加重，表现为：

- 流式输出期间服务端 CPU 与 Redis 流量随会话长度线性上涨（累计 O(N²)）；
- 前端主线程在流式期间高频全量重算，长会话下卡顿、GC 压力大；
- 每次 WS 重连/新开标签页都重新下载两份完整 Y.Doc 快照；
- 完全空闲的连接也在持续产生 doc 更新、广播与 Redis 写入。

## 频率模型（读 sub plan 前先建立量级感）

流式输出时，relay 每个 `session/update` 帧翻译为 `message_delta`，DocManager 以 16ms 窗口微批合并（`packages/chat-channel/src/state/doc-manager.ts:22`）。因此**流式期间每秒约 60 个批次**，每个批次在当前实现下触发：

```
1 个批次 = 2 个 doc 更新（Chat + Session，见 A2）
         = 2 帧广播（base64+JSON，见 A4）
         = 2 轮 Redis 全量快照 CAS（读全量 + merge + 写全量，见 A1）
         = 前端 2 个 store 触发重算（每个都全量遍历会话，见 B2/B3/B5）
```

会话越长（doc 越大），每一环成本线性增长，累计 O(N²)。这是"长会话越用越卡"的结构性原因。

## 根因清单

优先级：P0（先做，收益/成本比最高）→ P2（协议级/二期）。

| ID | 位置 | 问题 | 影响量级 | 优先级 |
|----|------|------|----------|--------|
| A1 | `persist/redis.ts:171-229` | 每次 doc 更新做全量快照 CAS：encode 全量 → GET 旧全量 → mergeUpdates → SET 全量，背靠背执行 | 流式期间每 16ms 一次 O(doc)，Redis 往返与 CPU 随会话线性涨 | P0 |
| A2 | `state/aggregator.ts:528-531` | 每个 applied 事件对**两份** doc 都 bump `projectionVersion`，与事件实际触碰的 doc 无关 | Session Doc 被流式噪声污染：帧/CAS/前端 meta 重算 ×2 | P0 |
| A3 | `state/aggregator.ts:168`、`state/chat-writer.ts:166-173` | 每 delta 重复 `set("status","streaming")`；yjs 13.6.31 `Y.Map.set` 无相等性检查（已核实 `AbstractType.js:846`），相同值也产生 op | 每 delta 产生冗余 op + tombstone，撑大 update 帧与快照 | P0（改动极小） |
| A4 | `channel/broadcaster.ts:31,95-101`、`transport/ws.ts:132` | update 帧 base64（+33%）包 JSON 文本帧；`JSON.stringify` 在 `sendToYjsWs` 内执行，广播给 N 客户端序列化 N 次；客户端 `atob` + 逐字节回调解码 | 所有传输体积膨胀 + 大快照解码慢路径（B8 并入此项） | P1 |
| A5 | `channel/gateway.ts:305-322` | 每次 WS open（含每次重连）全量 `encodeStateAsUpdate` 快照，无 state vector 差量同步 | 长会话 × 网络抖动 = "传递数据颇多"直接来源；CLAUDE.md 不变量 2 固化了该行为 | P2（协议级） |
| A6 | `persist/redis.ts:155-161,233-244` | pub/sub 自环：本进程发布的 update 被本进程 subscriber 收到并 re-apply（origin 过滤防了二次扩散，但每条 update 多一次往返 + apply） | 每条 update ×2 Redis 往返 | P2 |
| A7 | `channel/broadcaster.ts:29-30` | 背压策略是静默丢帧：`bufferedAmount > 64KB` 直接跳过，恢复依赖"下次重连"这个不确定事件 | 慢消费者静默丢更新，卡顿后偶发内容缺失/滞后 | P2（正确性交叉风险） |
| B1 | `web/src/pages/agent-panel/ChatPanel.tsx:225-233` + 两个 hook | 同一条 update 喂给 `useChatState` 和 `useSessionState`，两个 hook **各自**维护 chat/session 两份 `new Y.Doc()` | 浏览器同一会话存在 **4 份 Y.Doc 副本**，apply CPU/内存 ×2 | P1 |
| B2 | `web/src/hooks/use-session-state.ts:31-126` | `computeTimelineSnapshot` 每次重算三遍全量（structuredMessages 全文 toString + messages 再全量 + artifacts 第三遍）。**已核实 `messages`/`streaming`/`tools`/`artifacts` 四个派生字段前端零消费（仅 structuredMessages 被消费）** | 流式期间 20 次/秒 × O(全部会话文本)，长会话卡顿主源 | P0 |
| B3 | `state/yjs-store.ts:95-103` + `util/key.ts` | `stableKey` 每次 recompute **先无条件**全量递归序列化整个快照（含全部消息全文）再比较是否变化 | 即使内容没变也付 O(全部内容) 字符串分配，GC 压力 | P0 |
| B4 | `web/src/hooks/use-chat-state.ts:24-44` | `computeTokenSnapshot` 为找最后一个 tokenUsage 从头正向扫描整个 entryOrder | O(N) per 每个流式批次 | P2（改动极小） |
| B5 | `web/src/hooks/use-chat-state.ts:129-212` | `computeMetaSnapshot` 每次遍历整个 sessions map + permissions + modelState 再全量 stableKey；被 A2 放大到每批次执行 | O(会话数) per 批次 | P1（A2 落地后频率大降，此项治理单次成本） |
| B6 | `web/components/ChatInterface.tsx:161-167,251-266`、`ChatArea.tsx:66`、`ChatView.tsx:51,98` | 渲染链连环全量转换：`structuredToThreadEntries` + todoItems filter + `computeStats` + `extractChangedFiles` + `groupToolCalls` 全部依赖整体身份、每次批次 O(N) | 每批次 5+ 遍全量转换 | P2 |
| B7 | `web/components/ChatInterface.tsx:269-275` | `chat:stats` CustomEvent 每次 renderEntries 变化携带**完整 entries** 派发（流式期间 ~20 次/秒） | 高频全量 DOM 事件 | P2 |
| C1 | `persist/redis.ts`（全文件） | `yjs:chat:*` / `yjs:session:*` 无 TTL、无清理任务，内容随历史单调增长且每批次整键重写 | Redis 内存无界增长 | P1 |
| C2 | `channel/relay-event-handler.ts:233-234` | 内存 doc 仅在 relay_closed 释放；实例存活期间所有打开过的 doc 常驻内存 | 服务端内存只增不减 | P2 |

## 架构决策（统一裁决原则）

**状态权威在服务端 YJS（Chat Doc / Session Doc）；前端只做轻量投影，不维护第二事实源。** 所有 sub plan 实现中出现取舍冲突时以此裁决，具体约束：

1. 前端持有的 Y.Doc 副本与派生缓存必须可随时从后端 doc 全量重建（纯投影，不承载语义、不持久化本地状态）；SP-B1 的 DocHub 本质是"共享同一份后端投影"，不是新增前端事实源。
2. 任何"前端自行计算/补状态"的方案（前端合成消息、前端补时间戳、前端维护消息去重表等）一律拒绝——缺失字段回到聚合层补投影（参考既有不变量：用户消息只由后端写入 Y.Doc）。
3. SP-B2/SP-B5 的增量缓存只允许作为渲染性能优化存在，缓存失效边界失效时必须回落到全量重算的正确结果，不得为省计算而在前端累积有状态逻辑。

## 交付顺序与依赖

```
SP-0（度量基线，先行）
 ├──► SP-A2 ──► SP-B3       （B3 的 key 票据依赖 A2 消除 Session Doc 噪声）
 ├──► SP-A3                  （独立，可同 PR）
 ├──► SP-A1                  （独立；含 C3 历史累积的 compaction 策略）
 ├──► SP-B2                  （独立；删除死字段可先单独落地）
 ├──► SP-B1 ──► SP-B5
 ├──► SP-A4（含 B8）──► SP-A5（差量重连，协议级）
 ├──► SP-A6 / SP-A7          （独立）
 ├──► SP-B4 / SP-B6 / SP-B7  （独立小项）
 └──► SP-C1 / SP-C2
```

建议节奏：第一批 = SP-0 + SP-A2 + SP-A3 + SP-B2（删死字段部分）+ SP-B3，一批内即可把流式期间的服务端帧数与前端重算成本降低一个数量级；第二批 = SP-A1 + SP-B1 + SP-A4 + SP-C1；协议级（SP-A5）单独评估。

---

## Sub Plans

### SP-0 · 性能度量基线（P0，先行）

> 对应：全局 | 模块：`packages/chat-channel/src/persist/redis.ts`、`channel/broadcaster.ts`、`state/yjs-store.ts`

**What to build**

为上述根因建立可对比的量化基线，避免优化后无法证明收益：

1. 服务端打点（经 `reportLog`/`log`，只含尺寸/耗时/标识，不含内容）：
   - redis provider：每次 CAS 的 `encodeStateAsUpdate` 字节数与耗时、CAS 全程耗时、每分钟执行次数；
   - broadcaster：每帧 base64 后字节数、每秒帧数（按 docName 前缀分组，验证 A2 前后 session: 帧频率）；
2. 前端打点：yjs-store recompute 次数/单次耗时直方图（`yjs-store.ts:125-133` 已有 `performance.now`，补计数上报即可，仅 DEV 模式）；
3. 采样脚本（可放 `scripts/`）：`redis-cli STRLEN`/`MEMORY USAGE` 对 `yjs:chat:*` 随会话长度采样。

**验收标准**

- [ ] 一份基线数据（长会话模拟：≥100 turn 流式输出）记录在本 issue 附录或 PR 描述中
- [ ] 打点不泄露会话内容（尺寸/耗时/ID only）
- [ ] `bun run precheck` 全绿

**风险/依赖**：无。所有后续 sub plan 的验收都以本基线为对照。

---

### SP-A1 · Redis 持久化改为节流快照 + 明确丢失语义（P0）

> 对应根因 A1 | 模块：`packages/chat-channel/src/persist/redis.ts`

**What to build**

消除"每次 update 全量 CAS"的 O(N²) 累计成本。推荐两步走：

1. **第一步（本切片）：trailing 节流快照**。`scheduleSnapshotFlush`（`redis.ts:171-214`）从 microtask 立即执行改为 trailing 节流：距上次成功写入 ≥ `SNAPSHOT_INTERVAL`（默认 2s，env 可配，收敛到 `src/env.ts`）或有静默期（如 500ms 无新 update）才执行一次现有 CAS 合并；`destroy()`/`closeChat`/`closeSession` 时强制 flush。pub/sub 增量路径不变（实时性不受影响，只有持久化频率下降）。
2. **丢失语义显式化**：节流窗口内进程崩溃会丢失窗口内更新。当前快照本就不是权威（权威 = Agent 侧 ACP session 历史，可通过 `load_session` 回放重建），需在 `redis.ts` 模块头注释与 `docs/design/2026-08-04-yjs-chat-streaming-prd.md` 补充说明该边界。
3. **第二步（二期，另立切片）：增量 append + 周期 compaction**（Redis Stream per doc，读路径 = 末次快照 + replay，compaction 合并）。同时解决 C3（跨 ACP 会话切换的历史累积）：compaction 时以 GC 后状态为准重写快照。

**验收标准**

- [ ] 单测：节流窗口内 N 次 update 只触发 1 次快照 CAS；destroy/close 强制 flush（适配 `__tests__/redis-provider.test.ts`）
- [ ] 多进程收敛语义不变：两个 provider 实例互发增量仍收敛（既有测试保持全绿）
- [ ] 基线对比：流式期间 Redis 读写字节速率与 doc 大小解耦（按帧数而非 doc 尺寸计）
- [ ] `bun run precheck` 全绿

**风险/依赖**：节流参数过大会放大崩溃丢失窗口；需在 PR 中给出参数依据。与 SP-A6（自环过滤）正交，可并行。

---

### SP-A2 · projectionVersion 只递增被触碰的 doc；空转轮询零更新（P0）

> 对应根因 A2 | 模块：`packages/chat-channel/src/state/aggregator.ts`、`state/session-list.ts`

**What to build**

1. `applyNormalizedEvent`（`aggregator.ts:444-535`）中 `bumpProjectionVersion`（`aggregator.ts:528-531`）按事件实际触碰的 doc 递增。**注意不能按事件类型做静态映射**——已核实多类事件会同时写两份 doc：`user_message`（chat entries + session activeTurn）、`permission_resolved`（`permission.ts:42-79`：session pendingPermissions + chat toolCallStatus）、turn 终态（`turn-machine.ts:42-75`：chat entry 状态/usage + session activeTurn）、`applyDelta`/`applyToolCall` 在 accepting→running 迁移瞬间写 session。推荐实现（准确且零逐函数记账）：`Y.Doc.transact` 回调携带 transaction 对象，事务内 `tr.changed`（`Map<parentType, Set<key>>`）记录本次实际写入；在嵌套 transact 回调末尾分别检查两份 doc 的 `tr.changed.size > 0` 再 bump，天然覆盖拒绝写入（未产生 op 则不 bump）与所有双 doc 场景。
2. `applySessionList`（`session-list.ts:16-37`）：当 sessions map 无任何字段变化**且** `sessionListLoaded` 已为 true 时返回 `applied: false`（首个响应必然写入 `sessionListLoaded`，语义不受影响）。10s 轮询空转不再产生任何 doc 更新。
3. 同步修订既有语义锁定测试 `__tests__/doc-schema.test.ts:170-182`（现断言"两份 Doc 各 +1"）为按 touched 断言，并更新该测试上方中文注释。

**验收标准**

- [ ] 单测：N 条 `message_delta` 批次只产生 Chat Doc update，Session Doc 零 update
- [ ] 单测：`session_list` 重复相同响应不产生 update；首次响应落 `sessionListLoaded`
- [ ] 前端无回归：`use-chat-state`/`use-session-state` 均只读内容字段，无 version 依赖（已核实 `projectionVersion` 前端零读者）
- [ ] 基线对比：流式期间 `session:` 广播帧频率从 ~60/s 降至控制事件频率
- [ ] `bun run precheck` 全绿

**风险/依赖**：无外部依赖，是 SP-B3 的前置。

---

### SP-A3 · 相同值写入短路，消除每 delta 冗余 op（P0，改动极小）

> 对应根因 A3 | 模块：`packages/chat-channel/src/state/chat-writer.ts`

**What to build**

yjs 13.6.31 的 `Y.Map.set` 对相同值也会产生新 Item（已核实 `node_modules/yjs/src/types/AbstractType.js:846` `typeMapSet` 无相等性检查）：

1. `setEntryStatus`（`chat-writer.ts:166-173`）：`entry.get("status") === status` 且无需补写 `completedAt` 时直接 return；
2. `setActiveTurn`（`chat-writer.ts:382-392`）：turnId/turnStatus 未变时跳过 `activeTurnUpdatedAt`/`updatedAt` 写入（终态收敛路径保持不变）；
3. `setSessionInfo`（`chat-writer.ts:281-287`）：patch 未引起任何值变化时跳过 `updatedAt` 写入。

**验收标准**

- [ ] 单测：连续 apply 相同状态的 delta，doc `update` 事件计数不随 delta 数增长（在 `acp-aggregator-mapping.test.ts` 补用例）
- [ ] 既有收敛/幂等测试全绿（`completedAt` 首次写入语义保持）
- [ ] `bun run precheck` 全绿

**风险/依赖**：极低。可与 SP-A2 同 PR 交付。

---

### SP-A4 · 广播帧改造：序列化一次 + 二进制帧替代 base64+JSON（P1，含 B8）

> 对应根因 A4/B8 | 模块：`packages/chat-channel/src/channel/broadcaster.ts`、`transport/ws.ts`

**What to build**

1. **序列化去重**：`broadcastMessage`（`broadcaster.ts:113-129`）对同一消息只做一次 `JSON.stringify`，向各连接发送字符串（`sendToYjsWs` 拆出接受预序列化 payload 的变体，其余消息类型不变）；
2. **yjs:update 改二进制 WS 帧**：布局 `[1-byte type=0x01][2-byte docNameLen][docName UTF-8][update bytes]`；`action_ack`/`action_error`/`keep_alive`/`pong`/`error` 保持 JSON 文本帧（`typeof event.data === "string"` 判别）。客户端 `ws.ts:112-147` 的 `onmessage` 增加 `ArrayBuffer` 分支，`atob` + `Uint8Array.from` 逐字节回调慢路径（`ws.ts:132`）随之删除；
3. 保留 64KB 跳帧行为本身（其治理在 SP-A7），但二进制帧使阈值内可传输的有效负载提升 ~33%。

**验收标准**

- [ ] 帧体积对比：同等 update 二进制帧 ≈ base64 帧的 75%
- [ ] `broadcaster.test.ts`、`ws.test.ts`、gateway 相关测试适配后全绿；多标签页手工冒烟（双 tab 流式输出一致）
- [ ] `bun run precheck`、`bun run build:web` 全绿

**风险/依赖**：前后端同仓同构建，无兼容窗口；部署瞬间旧连接重连即升级。是 SP-A5 的载体（差量同步也需要二进制帧传输 SV）。

---

### SP-A5 · 重连差量同步：state vector 协议（P2，协议级）

> 对应根因 A5 | 模块：`packages/chat-channel/src/channel/gateway.ts`、`broadcaster.ts`、`transport/ws.ts`

**What to build**

消除"每次 WS open 全量快照"：

1. 客户端 open 后、收到首帧前上报本端两份 doc 的 state vector（`Y.encodeStateVector`，经 SP-A4 的二进制帧，新增 type=0x02）；
2. 服务端 `handleOpen` 的 `sendSnapshot`（`gateway.ts:305-322`）改用 `Y.encodeStateAsUpdate(ydoc, clientSV)` 差量发送；无 SV（首次连接/刷新页面）回落全量——前端 doc 无本地持久化，刷新本就需全量，行为不变；
3. **修订 CLAUDE.md YJS 不变量 2**：将"必须在 relayReady 前发送 Chat Doc 和 Session Doc 初始快照"更新为"完成初始同步（全量或差量）"，并同步 `docs/design/2026-08-04-yjs-chat-streaming-prd.md` 中"与 19 号文档 10 节的差异记为二期优化项"（`gateway.ts:5-6` 注释自认的二期项即此）。

**验收标准**

- [ ] 集成测试：预填充大 doc 后模拟重连，第二次 open 传输字节 ≈ 差量而非全量；刷新场景回落全量且正确
- [ ] 同一 ACP session 的重连不再触发 Agent 全量回放（既有跳过回放语义不变）
- [ ] CLAUDE.md 与 PRD 文档同步更新

**风险/依赖**：依赖 SP-A4；协议双端同批发布；不变量修订需 owner 评审。

---

### SP-A6 · Redis pub/sub 自环过滤（P2）

> 对应根因 A6 | 模块：`packages/chat-channel/src/persist/redis.ts`

**What to build**

`publishUpdate`（`redis.ts:155-161`）的 channel 载荷加发布者标识头（进程级 UUID，模块初始化生成）：`[1-byte flag][16-byte publisherId][update bytes]`；`onMessage`（`redis.ts:233-244`）发现 publisherId 是自己则跳过 apply。本进程 doc 已含该内容，跳过安全；多进程间不受影响。

**验收标准**

- [ ] 单测：同一 provider 发布的 update 不触发自身 apply（update 事件计数）；两个 provider 实例（模拟双进程）互发仍收敛
- [ ] 基线对比：单进程部署下 channel 消息处理量减半

**风险/依赖**：channel 载荷格式为内部契约，同仓双端同批修改即可；滚动部署期间新旧格式混布需兼容读取（旧格式无头 → 按 flag 缺失回落全量 apply，无损）。

---

### SP-A7 · 背压语义修复：lagging 标记 + 定向追赶（P2）

> 对应根因 A7 | 模块：`packages/chat-channel/src/channel/broadcaster.ts`、`connection-registry.ts`

**What to build**

把"静默丢帧等重连"改为确定性收敛：

1. `sendToYjsWs` 跳帧时对该连接登记 `needsResync`（registry entry 上）；
2. 后续发送前检测 `bufferedAmount` 回落后，向该连接**定向** `sendSnapshot` 全量追赶（复用现有快照路径，只发给 lagging 连接，非广播）；
3. 若 lagging 持续超阈值（如 30s），主动 `close(1013)` 交给客户端重连走全量同步；
4. 补充 lagging/resync 日志信号（可观测）。

**验收标准**

- [ ] 单测（fake ws 模拟 bufferedAmount 波动）：丢帧连接最终收到快照并一致；持续 lagging 被关闭
- [ ] CLAUDE.md 不变量 9 的"修改时必须保留限流、资源释放和单连接故障隔离"约束逐条核对并在 PR 说明
- [ ] `bun run precheck` 全绿

**风险/依赖**：与 SP-A5 组合时追赶用全量快照（lagging 时无法信任客户端 SV 的新鲜度），逻辑独立无冲突。

---

### SP-B1 · 前端 Y.Doc 副本合一：DocHub（P1）

> 对应根因 B1 | 模块：`web/src/hooks/use-chat-state.ts`、`use-session-state.ts`、`web/src/pages/agent-panel/ChatPanel.tsx`

**What to build**

1. 新建 per-rcsSessionId 的 DocHub（模块级 Map + 引用计数）：持有一份 chat Y.Doc + 一份 session Y.Doc，提供 `apply(docName, update)` 路由；
2. `ChatPanel.tsx:225-233` 的 `onYjsUpdate` 改为只调 hub（删除对两个 hook `applyUpdate` 的双写）；
3. 两个 hook 改为从 hub 取同一 doc 实例，各自 `createYjsStore` 绑定（computeSnapshot 独立、不再各自 `Y.applyUpdate`）；`switchDoc`/StrictMode 双挂载/`destroy` 语义由 hub 引用计数统一处理（沿用 `yjs-store.ts:167-211` 的幂等保护思路）；
4. 会话切换时 hub 按 rcsSessionId 换 doc，两个 hook 自然跟随。

**验收标准**

- [ ] 页面内同一会话 Y.Doc 实例数 = 2（heap snapshot 验证，现状为 4）
- [ ] `use-chat-state`/`use-session-state` 既有测试适配全绿；切换会话、StrictMode 双挂载行为不回归
- [ ] `bun run build:web` 通过

**风险/依赖**：hub 生命周期与 ChatPanel 挂载/卸载对齐，注意多组件共享同一 rcsSessionId 时的引用计数正确性。

---

### SP-B2 · 时间线快照降本：删死字段 + 增量派生（P0）

> 对应根因 B2 | 模块：`web/src/hooks/use-session-state.ts`、`web/src/lib/structured-to-thread.ts`

**What to build**

分两步，第一步独立可先交付：

1. **删死字段（第一步）**：已核实 `messages`/`streaming`/`tools`/`artifacts` 在 `web/src`、`web/components` 零消费（仅 `structuredMessages` 被 `ChatInterface.tsx:163-164,253-254` 消费）。从 `SessionTimelineSnapshot`/`SessionStateSnapshot` 中删除这四个派生字段及对应计算循环（`use-session-state.ts:46-124` 三个循环删两个半）。**注意**：`SessionStateSnapshot` 是 `@fenix/chat-channel` 导出类型，删除字段属于对外导出面变更，同批清理类型定义与测试引用。
2. **增量派生（第二步）**：`chatDocEntriesToStructuredMessages`（`structured-to-thread.ts:170-264`）改为缓存 + dirty 标记：per-entry 缓存派生结果（entryId → StructuredMessage），用 `entries` Y.Map 的 `observeDeep` 或 update 事件标记 dirty entry，重算时只重建 dirty 项并复用其余引用（同时让 `ChatView` 的 `prev.entries === next.entries` 引用比较真正生效于未变 entry）。

**验收标准**

- [ ] 第一步：grep 确认四个死字段及计算循环删除；前端测试适配全绿
- [ ] 第二步：基准测试（1000 entries 构造 doc，尾部 append delta）单次重算耗时 < 2ms（对比基线记录加速比）；未变 entry 的派生结果引用稳定（`===` 断言）
- [ ] `bun run precheck`、`bun run build:web` 全绿

**风险/依赖**：第一步动共享类型导出面，前后端类型同批；第二步缓存失效边界（entry 删除、blockOrder 变更、toolCall 状态变更）需测试覆盖。

---

### SP-B3 · stableKey 替换为 O(1) 变更票据（P0）

> 对应根因 B3 | 模块：`packages/chat-channel/src/state/yjs-store.ts`、两个前端 hook

**What to build**

1. `getSnapshotKey` 不再全量序列化快照内容。改为轻量票据：`${projectionVersion}:${docUpdateSeq}`——`projectionVersion` 来自 doc（SP-A2 后语义精确），`docUpdateSeq` 由 store 自身在 update 事件里 O(1) 自增（覆盖本地事务不 bump version 的场景，保证测试直写路径仍能通知）；
2. 两个 hook（`use-chat-state.ts:241,258`、`use-session-state.ts:262,268`）的 `(s) => stableKey(s)` 替换为票据函数；`stableKey` 若无其他调用方则从导出面移除；
3. 语义保持：票据变化 ⇔ doc 有 update ⇒ 允许通知（可能多通知，不会漏通知——与现状"内容全量比较"相比，牺牲少量误报换取 O(1)）。

**验收标准**

- [ ] 单测：本地事务（非 APPLY_UPDATE_ORIGIN）仍触发通知（seq 兜底）；switchDoc 后票据重置（现有 `prevSnapshotKey = ""` 路径保持）
- [ ] recompute 路径无全量字符串化（profiler 中 `stableKey` 调用消失）
- [ ] `bun run precheck`、`bun run build:web` 全绿

**风险/依赖**：**依赖 SP-A2**——否则 Session Doc 每 16ms 的版本噪声使 meta store 票据每批次都变，退化为每次重算（但那也正是现状，无 correctness 问题）。

---

### SP-B4 · tokenUsage 扫描倒序化（P2，改动极小）

> 对应根因 B4 | 模块：`web/src/hooks/use-chat-state.ts:24-44`

**What to build**

`computeTokenSnapshot` 从 entryOrder 尾部倒序找第一个带 `tokenUsage` 的 assistant message entry，找到即停；空/缺失结构保持现有早退。

**验收标准**

- [ ] 行为等价单测：多条 usage 取最后一条；无 usage 返回 null
- [ ] `bun run build:web` 通过

**风险/依赖**：无。

---

### SP-B5 · meta 快照按需派生（P1）

> 对应根因 B5 | 模块：`web/src/hooks/use-chat-state.ts:129-212`

**What to build**

`computeMetaSnapshot` 拆分派生单元并做变更短路（SP-A2 已把频率降到控制事件级，此项治理单次成本）：

1. sessions 列表派生仅在 `sessions` map 或 `session.sessionId` 变化时重建（per-key 缓存或 observeDeep dirty 标记，复用 SP-B2 的缓存模式）；
2. permissions/modelState/modeState/availableCommands 各自独立派生与缓存；
3. 快照对象字段级复用引用，未变子树保持 `===`。

**验收标准**

- [ ] 基准：sessions 数 = 200 时单次重算耗时不随 sessions 数线性增长（或增长 < 10×）
- [ ] 既有 hook 测试全绿；权限卡片、模型选择、slash 菜单冒烟无回归

**风险/依赖**：建议在 SP-B1 之后做（缓存挂在共享 doc 实例上更自然）。

---

### SP-B6 · 渲染链依赖收窄（P2）

> 对应根因 B6 | 模块：`web/components/ChatInterface.tsx`、`web/src/pages/agent-panel/ChatArea.tsx`、`web/components/chat/ChatView.tsx`

**What to build**

1. `renderEntries` useMemo（`ChatInterface.tsx:161-167`）依赖从 `[sessionState]` 收窄为 `[sessionState.structuredMessages, sessionState.permissionOptions]`（SP-B2 第二步落地后 structuredMessages 已按 entry 稳定引用，未变 entry 不再触发）；
2. `todoItems`（`ChatInterface.tsx:251-263`）改为只扫描 tool_call 类型消息的索引缓存；`computeStats`/`extractChangedFiles` 依赖收窄到 renderEntries（随 1 自然减少）；
3. `groupToolCalls`（`ChatView.tsx:51`）与 `entries.some`（`ChatView.tsx:98`）memo 化（useMemo / hasUserMessages 派生上移）。

**验收标准**

- [ ] React Profiler：流式期间 ChatView 重渲染次数与历史长度解耦（只有变更 entry 的 EntryRenderer 深渲染）
- [ ] `bun run build:web` 通过；相关渲染测试全绿

**风险/依赖**：依赖 SP-B2 第二步（entry 级引用稳定）才能完全生效。

---

### SP-B7 · chat:stats 事件瘦身（P2）

> 对应根因 B7 | 模块：`web/components/ChatInterface.tsx:269-275` 及消费方（agent 路由层 / ArtifactsPanel）

**What to build**

1. `chat:stats` payload 从完整 entries 改为增量摘要：`{ agentName, modelName, entryCount, changedFiles 增量 }`；
2. 派发频率节流至 1s（trailing），或在 entryCount 未变且最后 entry 未变时跳过；
3. 消费方（`chat.$agentId.tsx` 路由派生 changedFiles）同步改为消费增量摘要。

**验收标准**

- [ ] 打点对比：事件 payload 体积与派发频率下降 ≥ 90%
- [ ] ArtifactsPanel changedFiles 行为无回归（手工冒烟 + 既有测试）

**风险/依赖**：消费方协议同批修改；与 SP-B6 有协同但可独立。

---

### SP-C1 · Redis key 生命周期治理（P1）

> 对应根因 C1 | 模块：`packages/chat-channel/src/persist/redis.ts`、会话删除服务路径

**What to build**

1. 快照写入时附带滑动 TTL（`SET ... EX`，默认 7 天，env 收敛到 `src/env.ts`）——活跃会话持续续期，失活数据自然回收；
2. 盘点 RCS 会话删除的业务路径（DB session 删除/用户删除会话入口），在对应 service 中同步 `DEL yjs:chat:{rcsSessionId}` / `yjs:session:{rcsSessionId}`（经 repository/service 层调用，不在 route 直连）；
3. compaction 语义由 SP-A1 第二步承接，本切片不处理快照内部体积。

**验收标准**

- [ ] `redis-cli TTL` 对活跃 key > 0；会话删除后 key 不存在（集成测试覆盖）
- [ ] TTL 期间重连/恢复语义不受影响（TTL ≥ 实例最长存活周期论证记录在 PR）
- [ ] `bun run precheck` 全绿

**风险/依赖**：TTL 过短会导致 Agent 实例存活但快照已过期 → 恢复回落 Agent 回放（功能可用但有回放成本），默认值需保守。

---

### SP-C2 · 内存 doc 生命周期对齐实例回收（P2）

> 对应根因 C2 | 模块：`packages/chat-channel/src/channel/relay-event-handler.ts`、`gateway.ts`、`src/services/acp-idle-monitor.ts`

**What to build**

1. 现状：doc 仅在 relay_closed 关闭（`relay-event-handler.ts:233-234`）；gateway 的 `releaseRelay` 故意不关 doc（C6 断链语义一：重连后同步实时 doc）。在该约束内补充回收路径：实例 idle reclaim（4001 关闭码路径，`acp-idle-monitor` 触发）与 `terminateLocalDeadInstance` 回收时，确认 doc 一并 closeChat/closeSession；
2. 增加 doc 计数与内存占用观测信号（docManager 暴露 `chatDocs.size`/`sessionDocs.size`，周期日志）；
3. 明确禁止的方向（写入注释）：不能在"relay 释放但实例可能存活"时关 doc——`processNormalizedEvent` 对不在内存的会话直接丢事件（`doc-manager.ts:263-268`），提前关闭 = 丢实时流。

**验收标准**

- [ ] 测试模拟：实例 idle 回收路径后 docManager map 大小下降；仅断开前端（实例存活）时 doc 保留
- [ ] 观测信号出现在日志中，长期运行 doc 数量曲线可采集
- [ ] `bun run precheck` 全绿

**风险/依赖**：与实例生命周期管理（`orchestration-instance`）耦合，需对齐回收时序，避免与在途事件竞争。

---

## 需要同步修订的既有约定

| 位置 | 修订内容 | 触发切片 |
|------|----------|----------|
| CLAUDE.md YJS 不变量 2 | "发送初始快照" → "完成初始同步（全量或差量）" | SP-A5 |
| CLAUDE.md YJS 不变量 9 | 背压描述从"跳过发送（等待重连后 snapshot 同步）"更新为 lagging 定向追赶语义 | SP-A7 |
| `__tests__/doc-schema.test.ts:170-182` | "两份 Doc 各 +1" 断言改为按 touched doc 断言 | SP-A2 |
| `docs/design/2026-08-04-yjs-chat-streaming-prd.md` | 补充快照持久化的尽力而为语义与差量同步二期项落地 | SP-A1/SP-A5 |
| `@fenix/chat-channel` 导出面 | `SessionStateSnapshot` 死字段删除、`stableKey` 移除 | SP-B2/SP-B3 |

## 全局验收

优化全部落地后，用 SP-0 基线复测同一场景（≥100 turn 长会话流式输出）：

- [ ] 流式期间服务端 Redis 读写字节速率与 doc 大小解耦（常数级/按帧计）
- [ ] 流式期间 `session:` 广播帧频率 ≈ 0（仅控制事件）
- [ ] 前端单次 timeline recompute < 2ms（1000 entries）
- [ ] 重连传输字节 ≈ 差量（非全量）
- [ ] 空闲连接（无流式、无操作）10 分钟内产生的 WS 帧 = keepalive + 0 个 yjs:update
- [ ] `bun run precheck`、`bun run build:web` 全绿

## 实施状态（2026-08-17，分支 refactor/huge-change/yjs-chat 工作区未提交改动）

除下列例外，全部 sub plan 已实现并通过审查验证（每簇经三维度审查 + 对抗验证 + 修复）：

| Sub plan | 状态 | 说明 |
|----------|------|------|
| SP-0 | partial | 打点已落地（CAS 字节/耗时/分钟频次、广播帧频、前端 DEV recompute 直方图）；缺 redis-cli 采样脚本与 ≥100 turn 基线数据，全局验收量化对比未完成 |
| SP-A1 | done | 第一步 trailing 节流（默认 2s + 500ms 静默期 + destroy 强制 flush）落地；第二步 Redis Stream 属二期未实现 |
| SP-A5 | skipped | 按计划排除，需 owner 评审（涉及修订不变量 2）；0x02 帧仅预留常量 |
| SP-C1 | partial | 第 1 项滑动 TTL（默认 EX 7 天）落地；第 2 项会话删除路径同步 DEL yjs key 未实现 |

`bun run precheck`（2639 测试全绿）与 `bun run build:web` 通过；`packages/chat-channel` 独立 tsc 与 lint warning 已在人工收口阶段清零（precheck 不覆盖包级 tsc）。

### 遗留工作（按优先级）

1. **SP-C1 第 2 项**：盘点会话删除业务路径，service 层同步 `DEL yjs:chat:*/yjs:session:*` 并补集成测试。
2. **SP-0 基线**：补采样脚本与长会话基线数据，逐项勾选全局验收清单（含人工冒烟：DocHub heap snapshot 副本 4→2、双标签页流式一致性、React Profiler 验证 ChatView 重渲染与历史长度解耦）。
3. **债务清理**：`ChatPanel.tsx` 536 行超 500 行红线需拆分；doc-manager 10s 空转 `session_list` rejected 日志可按 reason 过滤降噪。
4. **SP-A5 / SP-A1 第二期**：差量同步与 Redis Stream 增量持久化，单独立项。

### 需关注的实现风险（终审 topRisks 摘录）

- **节流快照丢失语义**（persist/redis.ts）：2s 窗口内进程崩溃丢窗口内更新，恢复依赖 ACP session 可回放；实例同时异常且不可回放时丢数据成为事实。PR 需给出 interval 依据并验证降级行为。
- **1013 close reason 字符串匹配**（yjs-ws.ts ↔ broadcaster.ts）：reason 经中间层可能被截断/改写，失配时慢消费者追赶超时被误判为终态导致静默断流；建议改独立关闭码（如 4003）或双端共享常量。
- **WsConnection.send 二进制适配完整性**：目前仅 Elysia adaptWs 更新为 sendBinary，新增该接口适配器时必须同时处理 `Uint8Array` 分支，否则 yjs:update 帧静默损坏。
- **增量派生缓存失效边界**（structured-to-thread.ts / use-chat-state.ts）：正确性依赖 observeDeep 注册时机与 path 路由，结构性新增写入点须接入被观察子树，保留全量重算对照测试。
