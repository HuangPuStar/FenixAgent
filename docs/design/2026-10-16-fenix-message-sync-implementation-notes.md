# FenixAgent 消息同步协议：A–G 阶段实施记录

> 日期：2026-10-16。设计依据：[`2026-10-16-fenix-message-sync-design.md`](./2026-10-16-fenix-message-sync-design.md)（下称「设计」）。
> 范围：本文件只记录**已落地**的部分；设计全文仍是目标契约，未实施项与不可做项见第 5 节。
> 本阶段（G 接线）的模块契约见 `.peri/plans/chat-sync-wiring-spec.md`（工作区内的阶段计划，不入库）。

## 1. 状态

| 项 | 状态 |
| --- | --- |
| A 契约与骨架 | 已落地（身份、帧、错误码、容量档案与准入、存储接口） |
| B 持久化写者 | 已落地为**内存 adapter**（保留 fencing、幂等、全组原子、只读已提交边界语义） |
| C 历史导入 | 已落地（保真 JSON、暂存、入口接收、分块构建、有界构建池、幂等提交、导入编排） |
| D 实时写入 | 已落地（合并缓冲与语义屏障、运行态/控制 Doc 轮换、active → sealed 协议机、单写者编排、纯删除捕获） |
| E 同步 provider | 已落地（握手/订阅/base/tail 状态机、四类额度与公平、ACK 账本与期限、控制帧率 governor） |
| F 客户端调度 | 已落地（有界接收队列、唯一 apply 入口、DocHub、帧↔ApplyTask 传输），浏览器安全，经 `./sync-client` 子路径导出 |
| G 接线（宿主已接入） | 默认启用：接入 relay、`channel/gateway.ts`、每连接 `runtime/`；前端将新文本投影与旧历史合并，复用现有 Chat UI。明确拒绝时自动回退，多标签页仍不共享新投影（见第 3、5 节）。 |
| DB schema 与迁移 | **未实施**：按用户裁定本阶段不动数据库，设计 §9.1 的 5 张表仍属待批准建议 |

## 2. 代码落点

`packages/chat-channel/src/sync/`（服务端面经 `src/server.ts` 的 `export * from "./sync"` 暴露；根入口保持浏览器安全，客户端子集另有子路径）：

- `protocol/`：`identity`、`frames`（11 种帧的 zod/v4 schema 与字节预算）、`errors`。
- `capacity/`：`profile`（设计 §10 全部数值 + 校验）、`admission`（池额度预留与交接）。
- `store/`：`types`（`ProjectionStore` 原语与记录类型）、`memory-store` + `memory-store-state`（内存 adapter）。
- `history/`：`fidelity-json`、`spool`、`ingest`、`block-builder`、`build-pool`、`build-dispatch`（有界在飞窗口）、
  `committer`、`import-service`。
- `live/`：`merge-buffer`（合并窗口与语义屏障）、`runtime-doc`、`rotation`、`sealing`、`live-writer`（单写者编排）、
  `change-capture`（以 Yjs update 事件判变更，纯删除可捕获）。
- `provider/`：`session`（状态机与四类额度）、`quota`、`ack-ledger`、`ack-timeout`、`base-plan`、`tail-plan`、
  `control-governor`。
- `client/`：`apply-queue`（有界队列，唯一 apply 入口）、`doc-hub`、`transport`（帧↔ApplyTask、ACK 回执、RESYNC）。
- `runtime/`：`config`（装配期解析与断言）、`ingress`（ACP `session/update` 规范化 + 记录快照）、`egress`
  （入站协商与派发、出站 socket 门禁与帧类交接、搁置重试、ACK 超时扫描）、`scope-runtime`（scope 级编排者）。

包出口：根入口 `src/index.ts`（浏览器安全，守护测试 `chat-channel-browser-surface.test.ts`）、`src/server.ts`
（服务端全量）、`./sync-client` → `src/sync/client/index.ts`（前端可用的客户端子集）。

## 3. 与设计的偏差（必须在使用前处理）

1. **存储是内存实现**：设计的 PostgreSQL 投影存储（事务、行锁、跨进程 fencing、崩溃恢复）未实施。
   `memory-store` 用注入 `Clock` 模拟租约、用「先全量校验再一次写入」实现全组原子，并提供
   `exportCommittedState`/`restoreFromCommittedState` 供测试验证「已提交快照 + 连续 tail」的恢复语义——它**不是**持久化。
   影响：重启丢投影、无跨实例 fencing。移除条件 = DB adapter 落地并由真实恢复路径取代该占位。
2. **构建池是进程内异步调度器**：保留「2 个构建者 / 执行+等待 ≤6 个任务 / 输入按文件范围传递」的额度语义，
   但不创建 `node:worker_threads`，因此未完全满足设计 §10.5「主线程只做受限小任务」。移除条件 = 落地 worker executor 后替换（接口不变）。
3. **协议帧的编解码为结构化对象 + JSON**：设计与字节预算已实现；线上以 UTF-8 JSON 二进制承载，宿主按首字节 `{`
   与旧 Yjs 帧分流，版本协商在 HELLO / egress 层完成。**未改为** `protocol/update-frame.ts` 那样的紧致二进制编解码，
   这是保留的真实偏差。
4. **清理宽限期由 env 提供默认值**：`RCS_CHAT_SYNC_SEAL_GRACE_MS` / `RCS_CHAT_SYNC_RETIRE_GRACE_MS` 分别给出
   2000ms / 30000ms 默认值，装配期可覆盖；缺失或非法值仍在装配期校验并拒绝。
5. **网关不参与额度记账**（偏离规格 §2.4 的文字）：连接窗口（已发送未 ACK 字节）的唯一所有者在 `session` +
   `AckLedger`——session 每帧已预留、ACK 经账本归还。网关对同一帧再记一次会让在途帧被扣两份，故工厂入参没有额度；
   网关的判据只剩 socket 真值 `bufferedAmount() + 真实编码字节 > socketHighWatermark`。移除条件 = 额度记账收口到单层后。
6. **网关公开面比 §2.4 多一个 `driveWithheld()`**：搁置帧的重试必须由编排者的 `tick()` 驱动，而 `scanTimeouts()`
   的语义是「只判定超期数」，故另开一个名实一致的入口。
7. **搁置语义分两类**：传输饱和（socket 门禁拒发或 `send` 返回 false）每 tick 重试；控制限流（governor 拒发）不在
   tick 重试（否则违背「搁置 ≠ 排队重发」，T22-2 已固化），只在搁置期限届满时做一次「最后机会」重试。两者共用一个
   一位有界搁置位，期限锚定**首次**拒发时刻，届满仍发不出去即关连接并清账。
8. **入口要求事件带 `turnId`**：真实 ACP `session/update` 载荷本身不含 `turnId`，宿主必须补齐（缺则返回空数组而不是
   猜测归属）。`final` 形态也不在入口产生——它需要存储侧的 `finalDescriptor`，由封口路径产出。
9. **客户端 `rejected` 也回 `APPLY_ACK`**：provider 的 `onAck` 接受 `rejected` 并转入 resync；是否额外发 RESYNC
   由 `APPLY_REJECT_REASONS` 决定。只回执成功会让被拒投递永不结账。
10. **被顶替的数据帧不重发，改由编排者自结算归还窗口**：沿用设计 §8.5「丢弃的是冗余发送任务」，搁置位只有一位，
    被新帧顶替的旧帧不再有引用、也不会有 ACK。故补一条自有释放路径：`egress.withhold` 发现顶替即回调
    `onDeliveryAbandoned(deliveryId)`，经 `scope-runtime` 接 `session.abandonDelivery` → `AckLedger.abandon` 归还该帧
    预留字节（重复调用与异代次返回 0）。缺口不补发、不断连，交由客户端 `doc-hub` 的 `sequence-gap` → RESYNC 补齐。
    移除条件 = 引入第二个产出入口（补发通道）后由其取代。
11. **控制帧被顶替必须立即断连**：控制帧线上无 `deliveryId`、不进 ACK 超时表，也没有第二次产出入口，被顶替即客户端
    永久收不到（典型是半握手：MANIFEST 被数据帧顶替）。因此 `withhold` 对控制帧改为以明确理由关连接
    （`withheld <TYPE> frame was superseded before delivery and has no recovery path`），且不保存顶替者。
    代价：持续饱和且连产控制帧时，每次顶替换来一次断连重连（第三轮 O1 观察）。移除条件 = 控制帧获得可重发身份。
12. **默认启用但保留旧连接**：服务端 `RCS_CHAT_SYNC_PROTOCOL_ENABLED` 默认 `true`；前端独立默认新协议，
    `?chatSync=0` 显式回退，`?chatSync=1` 保持兼容，不读取服务端 env。旧连接继续读取历史、非文本和发送动作，
    待新协议具备完整历史恢复与动作能力后移除；每连接 runtime / 内存 store、多标签不共享的限制仍在。
    新连接收到 `1008` 且 reason 含 `sync protocol disabled`，或 `1002` / `PROTOCOL_VERSION_UNSUPPORTED` 时，
    释放 transport 与镜像并锁定本会话旧路径，不再自动重连；普通 `1008`、`1011` 与其他内部错误显示错误卡，不静默回退。
    会话/组织切换或显式重新启用才重新尝试，组件卸载释放新连接，旧 Doc 生命周期保持原逻辑。
    合并优先按 `entryId`（投影中的 `id`）去重，异 ID 按角色、完整正文与 5 秒窗口一对一配对；无时间戳时使用首次观察时间，
    不把 `0` 当历史时间。已配对别名保持到条目离开视图，保留首次显示 key、已有相对顺序和未变文本对象；历史按旧 Doc 顺序补入。
    同 ID 纯文本取更完整正文，旧侧错误与非文本保留；时间窗口内同文重复输入仍有误配风险，异 ID 流式内容未追平时可能短暂重复。
13. **历史无生产重建路径**：当前 ACP `load_session` 只提供增量，不能用于构建完整稳定历史，因此生产端尚无历史
    导入入口。
14. **用户消息只写发送连接**：消息进入发起连接的 runtime 投影，另一连接不会观察到；这是当前每连接独立
    runtime 的边界限制。
15. **final / 非文本内容未进入新投影**：final 元信息与 history/tool 对象暂无完整的生产映射，前端投影不呈现
    这些内容。

### 3.1 历史加载窗口（2026-10-19）

- 协议层：目录仍声明全部已封口内容块，但客户端首屏只 retain/SUBSCRIBE 目录末尾 4 块
  （`SYNC_HISTORY_INITIAL_BLOCKS`）；更早块仅在用户点击“显示更早”时每次再订阅 4 块。
  未订阅块不 retain，content 旁路直接忽略其帧，因此不产生 `DOC_BASE` 下行。
- 投影层：单个内容块仍可能包含大量短消息，`SyncContentProjectionHub` 默认只输出最近 600 条
  （`SYNC_PROJECTION_MESSAGE_WINDOW`）并暴露 `hiddenMessageCount`；加载更早时先扩大投影窗口，
  再按需拉取更早块。
- 渲染层：`ChatInterface` 的数据层窗口首屏 100 条（`CHAT_RENDER_WINDOW_INITIAL`），每次“显示更早”
  最多再揭示 300 条（`CHAT_RENDER_WINDOW_STEP`）；`ChatView` 在 `preWindowed` 下不再做第二层裁剪，
  避免揭示后又被裁掉。
  会话/投影换代键（DocHub `replacementVersion`）变化即重置窗口，覆盖同实例切换会话。
- 会话槽位：`ChatArea` 只保留当前 session 的 `ChatPanel`；切换会话时驱逐上一槽位并卸载，
  旧投影/DOM/WebSocket 随之释放；切回旧会话按同一窗口重新加载最近块。
- 边界：旧 Chat Doc 仍持有完整回放（第 12 条偏差），旧通道的下行未在本轮收敛；本轮收敛的是新协议
  路径的订阅量、投影条目与 DOM 挂载量。移除条件 = 新协议具备完整历史恢复并下线旧通道。

### 3.2 Legacy 超限帧与连接隔离（2026-10-19）

- 根因：旧 Yjs 通道在 `state-vector` 握手时对 Chat Doc 做全量 `sendDiff`；大会话的 update 可超过
  `MAX_YJS_SYNC_PAYLOAD_BYTES`（8MiB），`encodeGenerationFrame` 抛错后沿 `Gateway.handleMessage`
  的 fire-and-forget 调用进入未处理拒绝，直接结束服务进程（生产实测 11,570,054 字节）。
- 策略：`YjsBroadcaster.encodeLegacyFrame` 是所有 legacy 帧编码的唯一入口；payload 超限或编码失败时
  只丢弃该帧并记录 `prefix/bytes/limit`，不抛回消息循环。旧通道与新同步协议共用同一条 socket，
  因此不能为一个 legacy 帧关闭整条连接；新协议的首屏窗口继续可用，旧 UI 的大会话历史则不送达。
  `DocManager.replaceProjection` 的 legacy 编码预检同样跳过超限 replacement，避免大会话换代在提交前失败。
- 隔离：`Gateway.handleMessage` 捕获任何分派/出站异常，记录带 `wsId` 的诊断，仅关闭受影响连接
  （1011）并清理登记；`sendToYjsWs`、广播 flush 与慢消费者追赶的发送/编码同样按单连接/单帧隔离。
- 取舍：当前帧契约没有可安全拆分任意 Yjs update 的分片格式，故不做“截断分片”（会制造损坏副本）。
  若显式关闭新协议且会话超过 8MiB，旧 UI 将看不到该段历史；移除条件 = 旧通道退役，或协议增加
  可验证的安全分片/按需历史恢复。
- 证据：9MiB 合成 Chat Doc 修复前 `Yjs payload too large: 9437203 bytes`、进程退出码 1；修复后进程
  存活、无 legacy 二进制帧、记录 dropped 诊断；模拟出站抛错时只关闭该连接（1011）。

### 3.3 同 endpoint 的旧通道帧分流（2026-10-19）

- `Gateway.handleOpen` 对所有 `/acp/yjs` 连接都会经 `synchronizeInitialDocs` 发送旧通道文本帧
  `{"type":"yjs:sync-request","docs":[...]}`（`gateway-sync.ts:39-42`）；500ms 未收到 state-vector 时
  还会发送旧 Yjs 快照（`gateway-sync.ts:45-46`，首字节 `0x01`）。
- 新同步客户端此前把文本帧直接判为 `MALFORMED_FRAME`，随后把旧二进制快照交给新协议解码器；
  两者都会让直连会话停在错误卡 + hydrate 骨架。
- 分流规则：文本帧属于旧控制通道，忽略；二进制帧只有首字节 `{` 才属于新协议，其余（旧 Yjs
  `0x01/0x02/0x03/0xa7`）忽略；首字节 `{` 但 JSON/schema 非法仍显式 `MALFORMED_FRAME`，不扩大回退范围。
- 终态出口：同步进入 `error`/带错误的 `closed` 时，`useChatHydration` 立即解除 blocked/replay 并
  `markComplete`；旧通道内容或空状态在 settle 后可见，输入区恢复可用，错误卡仍保留供诊断。

### 3.4 1 天规模上限（2026-10-19 压测）

- 目录 Doc：`contentDocIds` 以 Y.Array 全量放在目录 base；`4000` 个 ID 时 payload `198,934B`、
  `DOC_BASE` 帧 `265,583B`（上限 `294,912B`），`6000` 个 ID 时帧 `398,915B` 已被帧层拒绝。
  按当前 100MB/722 块的打包比例，约 **5–6 亿字节历史 / 4,000 块**就是目录单帧上限。
- 浏览器 20,000 条 / 50MB / 400 块：首屏 `200` 投影、`100` DOM、`722,403B` / `8` 帧、
  首屏可见 `123.5ms`；连续 10 次“显示更早”后 DOM `1200`、累计下行 `4,222,915B`，最大单帧
  `175,026B`；卸载后 DOM `0`，JS heap `215.5MB → 62.5MB`。首屏有界，但显式加载按次累积。
- 服务端 20,000 对象 / 100MB 真实导入：`722` 块、`3.52s`、峰值 RSS `492,814,336B`；按线性外推
  1.2GB 约 `5.9GB`、2.4GB 约 `11.8GB`，当前内存 adapter 无归档/淘汰，GB 级历史存在 OOM 风险。
- 结论：低速率 1 天（约 8.6 万条 / 120MB / 千级块）可落在目录阈值内；高速率 1 天
  （48 万条 / 1.2GB / 万级块）会同时触发目录帧超限与 GB 级 RSS，当前协议不可行。
  硬问题修复方向是目录分页/归档，不是调大单帧上限。

## 4. 验证证据

- 包内测试：**1464 通过 / 0 失败**（75 个文件；包含服务端 host/runtime、网关开关及旧路径行为）。
- 浏览器测试：**11 通过 / 0 失败**，覆盖默认无代次 HELLO、MANIFEST → directory `contentDocIds` → SUBSCRIBE → 消息投影，以及 ERROR 终态不重连。
- 端到端接线：`sync-gateway-e2e.test.ts` 用真实 `ChatChannelController` / `Gateway` / `SyncHostSession` / runtime 与假 WebSocket、假时钟，
  贯通开关开启的 stateless HELLO → MANIFEST → 目录 `contentDocIds` → 内容订阅 → `DOC_BASE` → 用户消息 `DOC_UPDATE` → `APPLY_ACK`，
  每次都断言连接窗口 `{ outstandingBytes: 0, pendingTasks: 0, unackedDeliveries: 0 }`；同文件断言开关关闭时旧文本 ping/pong
  与旧 Yjs state-vector 帧不受影响，而 `{` 帧收到 `1008`。
- 该端到端用例暴露并修复：空基线建代持有写租约未释放，首条实时写入会在租约到期前因 `SCOPE_BUSY` 失败；
  `ensureBaselineGeneration` 提交后现在显式归还写权。
- 服务端 host/runtime 细项：`sync-host-session.test.ts` 覆盖 stateless HELLO、目录发现、订阅基线/APPLY_ACK 与网关开关分流；
  `session-channel-action.test.ts` 的 send_prompt 用例断言用户消息只调用当前连接的 `syncConnection.acceptUserMessage`，
  跨连接隔离仍按第 14 条限制记录。
- `bun run precheck` 全绿（类型检查、lint、依赖边界、架构检查）；`bunx biome check packages/chat-channel` 0 告警。
- 配置投影：`assembly-env.test.ts > 聊天同步协议部署配置进入 agent-runtime module config` 校验三个部署值经真实装配进入模块配置。
- 浏览器安全边界：`chat-channel-browser-surface.test.ts` 走根入口与 `./sync-client` 的值导入图，断言未触及
  node 内建 / ioredis / 服务端模块。
- 对抗式验证（以证伪为目标）共发现 **21 个真实缺陷**，全部修复并留下回归用例：
  - A/B/C 阶段（10 条）：内存写者 5（refs 校验晚于写入导致半提交、退役代次可继续封口、`putSealedIfAbsent` 写孤儿行、
    跨 scope 同名 docId 误判幂等、指针被失败路径改写）、导入编排 3（目录幻影缺口使完整性校验永不通过、`begin` 未登记
    staging 代次、换代入口闭包缺内容块）、暂存配额 1、身份生成 1。
  - 接线第一轮（8 条 = 对抗 5 + 验收 2 + 规模 1，见 `.peri/plans/chat-sync-wiring-adversarial.md`）：出帧被拒后不重试
    不超时导致缺口永久跳过、持续拒发吃满窗口后永久停发、网关关闭后仍驱动会话使在途账目永不清、socket 门禁字节上界
    对多字节不成立、入口快照对别名/循环引用保留原引用、两条验收建模错误（T07 未真终止连接致 SCOPE_BUSY、T22-2
    半握手无超时）、历史导入 ≥7 块必失败（20,000 对象标准负载不可用）。
  - 接线第二轮（2 条，见 `.peri/plans/chat-sync-wiring-adversarial-2.md`）：报 4 条阻断，逐条对照设计与规格裁决后
    2 条成立并修复——被顶替投递永久占住连接窗口（违反规格 §2.4「`send` 返回 false 时归还上次预留」）、握手响应被
    数据帧顶替后连接挂在半握手（控制帧无第二次产出入口）；2 条不成立——数据帧序号洞与「无补偿路径」由设计 §8.5
    允许（丢弃的是冗余发送任务，缺口交由补齐流程），对应验收断言改写为契约形态。
  - 接线第三轮（0 条，见 `.peri/plans/chat-sync-wiring-adversarial-3.md`）：独立复核 D6–D9 的裁决与修复，
    结算守恒、顶替不二次交接、终态幂等与不变量全部成立，未发现可复现缺陷（新增
    `sync-verify-supersede.test.ts` 16 用例）；记 3 条观察未判缺陷——顶替控制帧即断连的代价（已记入第 3 节偏差 11）、
    被顶替的 base 服务端无兜底重规划（恢复依赖客户端 SUBSCRIBE/RESYNC）、`session.onAck` 不查账本（对已归还的迟到
    ACK 仍推进 attempt，生产不可达）。
  - 端到端接线（1 条）：空基线建代持有写租约未释放，首条实时写入在租约到期前以 `SCOPE_BUSY` 失败；
    `ensureBaselineGeneration` 提交后归还写权，并由 `sync-gateway-e2e.test.ts` 的 DOC_UPDATE 链路守护。
- 历史导入规模：**20,000 个对象（≈100MiB）导入成功**，722 个提交块，5834 对象/秒、29.17 MiB/秒，总耗时 3.4s；
  接收阶段 8404 对象/秒、42.02 MiB/秒（缺陷修复前该路径必然失败）。进程内存峰值 `processPeakRssMiB ≈ 481`，
  **未归因**（含 Y.Doc、暂存与构建槽的多份副本），需在灰度前定位。
- 性能：本机短时采样（Apple M5 Pro / 18 核 / Bun 1.4.2 / Yjs 13.6.31）——单次 apply（N=2500）1KiB 载荷
  p99 0.0227ms、16KiB 载荷 p99 0.0381ms（目标 p99 ≤8ms）；热工作集 5 批：活文档 `loadedPerAppendedByte = 1`、
  已释放文档 `loadedBytes` 差 0、GC 后 heapUsed 增量 +24.5KB，即不随已封存历史线性增长。**明确不是证据**：非设计
  §15.3 的固定硬件 profile，未覆盖实时端到端延迟、控制消息/公平性与 24 小时 soak。原始数据见
  `.peri/plans/chat-sync-runtime-profile-result.md`。

- 前端默认启用补齐：`sync-chat-session` / `sync-chat-projection` / `use-sync-chat-state` / `sync-chat-messages` 四文件
  **36 通过 / 0 失败**；含假 WebSocket 拒绝回退、切换清理，以及真实用户/助手气泡渲染、历史可见、双写去重与稳定引用。
  `fastcheck` / `precheck` 均通过（web 308、server/script 981、package 10278 通过，108 跳过）；最终补充精确身份优先与
  后到消息排序后，重跑四文件、web 全目录（309 通过 / 0 失败）、server/web 类型检查及生产构建通过。构建仍有 Vite 原生配置、Node 弃用、依赖 externalization 与 Tailwind sourcemap 告警，未验证真实服务多版本部署。
- 初次加载 hydrate 门控：切换会话后旧/新两路都按批到达（旧路径 ACP 回放、新路径 DOC_BASE/DOC_UPDATE）。展示层以
  确定性事实收口：旧路径在回放窗口开启时由服务端写入 `replay_started`（`presenting=replaying`），load/resume 响应后
  acp-link 再发 `session/replay_complete`（含零历史），relay 立即收敛窗口并写 `replayState=complete`；新协议等首批
  DOC_BASE 的 processed APPLY_ACK 全部匹配。旧宿主不发 `replay_complete` 时保留 1.5s 兜底与 12s 硬上限。10k 消息/
  200 批回放期间 0 次提交，结束后一次提交；渲染窗口默认挂载最近 1000 条，避免单次提交 >1s。用例见
  `chat-hydration-gate.test.ts`、`use-chat-hydration.test.tsx`、`chat-hydration-scroll.test.tsx`、
  `chat-render-window.test.tsx` 与 `chat-replay-signal.test.ts`。
- 空会话与关闭诊断：连接建立时 Session Doc 写入 `timelineEmpty`，首次加载已有空会话可直接渲染空状态（不依赖
  1.5s 计时）；重连 HELLO 改为 stateless，避免复用已销毁连接级 store 的 generation（1008）。同步关闭统一写
  `data/logs/sync-close.log`（code/reason/wsId/entry/pending/org/rcs），客户端错误卡保留原始 reason 与
  wasClean/local 标记。

## 5. 未覆盖与不可做

| 项 | 结论 | 原因 |
| --- | --- | --- |
| 灰度与新旧协议共存（T16） | 部分覆盖 | 默认开启、明确拒绝回退与历史合并已有浏览器测试；多版本真实部署、灰度观测与回滚验证仍待实施 |
| T13 长跑与资源趋势 | 不可做 | 需 24 小时墙钟与固定硬件 profile；假时钟只能覆盖轮换/热工作集的正确性分支 |
| T23 暂存盘满与故障注入 | 不可做 | 需 sharedrelay 真实进程与真实磁盘故障；`history/spool.ts` 没有失败注入点，进程内近似会冒充已覆盖 |
| T07 / T21 持久化分支 | 未覆盖 | 需真实 SQL 幂等语义与进程重启；进程内等价物已覆盖 fencing 与指针单调 |
| 多标签共享 | 未覆盖 | 当前每连接独立 runtime / 内存 store，用户消息仅写发送连接 |
| 历史重建 | 未覆盖 | ACP `load_session` 仅返回增量，尚无可用生产完整历史源 |
| final / 非文本展示 | 未覆盖 | final descriptor、history/tool 对象尚未接入新投影 |
| UI 渲染 | 文本已实施 | 用户/助手文本经合并视图复用现有消息组件；历史和非文本仍依赖旧 Doc |
| 初次加载 hydrate 完成信号 | 客户端门控已实施 | 旧路径由服务端在窗口开启时写入 `replay_started`，load/resume 后由 acp-link 发 `session/replay_complete`（含零历史），relay 立即收敛并写 `replayState=complete`；连接建立时写 `timelineEmpty` 供首次加载已有空会话直接放行；新协议用 DOC_BASE 的 processed APPLY_ACK。旧宿主不发 `replay_complete` 时保留 1.5s 兜底、12s 硬上限；完整基线后到的首次合并放宽 5s 配对窗口一次。重连 HELLO 不复用上一代 generation。移除条件 = 全量宿主升级后删除客户端兜底 |
| 大基线渲染窗口 | 已实施 | 默认只挂载最近 1000 条，更早消息由用户显式加载；DOM 有界（10k 条目一次性渲染从 1.7s 降至约 0.2s）。加载更早后滚到第一条新增历史，不再钉在底部；移除条件 = 引入带锚点的虚拟列表 |

## 6. 下一步（按设计分阶段）

1. 完成灰度验证：观测拒绝率、重连与资源占用，验证开关关闭可回滚并覆盖新旧协议共存（T16）。
2. 定义多标签共享与生产历史重建路径；当前 ACP `load_session` 仅有增量，不可冒充完整历史。
3. 经用户批准表结构后实现 DB adapter，解决每连接内存 store 与重启恢复限制。
4. 补齐 final / 非文本内容映射并接入 UI 渲染；随后验收 T13、T23、T07/T21 持久化分支及固定 profile 性能门槛。
