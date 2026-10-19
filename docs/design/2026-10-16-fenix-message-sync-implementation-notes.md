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

### 3.5 入口生命周期与背压（2026-10-19）

- 根因：`LiveIngress.stored` 累计保存已成功事件，生产复用 `maxRecordsPerDoc = 2048` 作为上限，
  第 2049 个文本 chunk 起以 `CAPACITY_EXCEEDED` 停写；且 `accept()` 先挂顺序队列、到 `dispatch()`
  才检查容量，宿主 fire-and-forget 投递时慢写者会让 Promise 队列无界增长。
- 修复：`maxRecords` / `maxBytes` 改为**在飞 + 排队**的 pending 预算，在入队前的同步段完成条数与
  估算字节预留，超限立即拒绝；写者成功或失败都由 `finally` 归还额度。`records()` 只保留最近
  `LIVE_INGRESS_DIAGNOSTIC_LIMIT = 64` 条成功记录用于诊断，不再是累计历史；`lastIngressSeq()`
  仍表达累计进度。生产 pending 字节预算取 `liveWaitPerScopeBytes`（4MiB）。
- 停止语义：宿主 `acceptEvents` 遇到入口失败后置 `stopped`，只报告一次并停止新协议投影旁路；
  后续事件直接丢弃、不再排队。旧 relay 投影在调用本旁路之前已完成，因此不受影响，连接也不关闭。
  停止状态经 `ingressDiagnostics()` 暴露；`SyncConnection` 端口同步提供可选观测入口。
- 边界：突发并发超过 pending 预算时新投影会显式停止而非降级排队；已进入 runtime 的在飞事件
  无法取消；字节数按快照 JSON 的 UTF-8 长度估算，且快照复制发生在字节检查之前（受 16MiB
  原始帧上限约束）。停止后恢复依赖连接重建，当前没有进程内重启入口。
- 验证：新增 3000 条连续接收、慢写者 pending 条数/字节有界、写者失败归还额度、诊断窗口有界、
  宿主停止后不再进入 runtime 等用例；相关 5 个测试文件 80 pass / 0 fail，`fastcheck` 全绿
  （chat-channel 1482 pass / 0 fail）。

### 3.6 目录分页与双向淘汰（2026-10-19）

- 根因：§3.4 的目录单帧超限来自「全部 `contentDocIds` 放在一个 Y.Array」。分页后根目录只持
  `latestPageId`（恒定 <256B），每页固定 `DIRECTORY_PAGE_SIZE = 64` 条并链接 `previousPageId`
  （页号从 1 起，等于 docId 的 `blockIndex`）。目录页复用既有 `SUBSCRIBE`/`DOC_BASE`，没有新增帧。
- 服务端维护：`HostBaseline` 建根 + 第 1 页；`HistoryImportService.finalize` 在
  `commitGeneration` 之前创建控制/运行态/根/全部页 Doc（修复「MANIFEST 的 `directoryDocId`
  在 store 中不可读、订阅直接 DOC_NOT_FOUND」）；`DirectoryAppender` 在 live 内容轮换时把
  successor 追加到最新页，页满后建下一页并原子更新根目录。
- 客户端发现：`sync-frame-router` 分根/页两类镜像；根到达后订阅 `latestPageId`，页到达后合并
  跨页 `contentDocIds` 并交给订阅窗口。`hasEarlierPage` 依据最早已知页的 `previousPageId`，
  用户点击「显示更早」时先订阅上一页，页基线到达后自动续订该页内容。
- 双向淘汰：内容窗口在 live 追加超过 `SYNC_HISTORY_MAX_RETAINED_BLOCKS` 时释放最旧块；向历史
  扩展时释放最新块并记入 `later`，回看期间新块不再自动推走阅读锚点。释放动作同时移出
  `retainedDocs`、协议 retain、投影镜像与 Y.Doc；页镜像在页内无驻留块且不是最新页时释放，
  页元数据（块列表 + `previousPageId`）保留，因此释放后仍可重新加载。
- 实施中发现并修复：目录 appender 自举/建页时把同一份快照编码了两次（一次落库、一次作为本地
  游标），两个 Y.Doc 的 `clientID` 不同，后续增量在读取方成为悬空 struct——目录看似写入成功，
  但重建后新块不可见。现在每个 Doc 的 canonical 字节只编码一次，落库与本地游标共用。
- 验证：`sync-directory-pagination.test.ts` 覆盖 64/64/2 切页、6000 块时根目录尺寸有界与页
  快照低于单帧上限；`sync-live-writer.test.ts` 覆盖轮换追加 successor、页满切换第 2 页与链接；
  `sync-import-service.test.ts` 覆盖导入后根/页可读；`sync-content-window.test.ts` 覆盖驻留预算
  淘汰、释放后重新加载与回看期间不自动订阅；`sync-chat-session.test.ts` 覆盖跨页加载、首屏四块、
  基线与 ACK。chat-channel 同步面 **781 pass / 0 fail**，agent-runtime web + 浏览器会话
  **137 pass / 0 fail**，`tsc-rs` 类型检查通过。

### 3.7 真实恢复与共享投影（2026-10-19）

- 共享边界：`SyncStoreRegistry` 按 `scopeKey`（`organizationId/rcsSessionId`）复用同一
  `ProjectionStore` 并引用计数，**只共享 store 与一次历史引导**；runtime、provider、配额和订阅
  仍按连接隔离。`bootstrap` 的并发调用共享同一 Promise，成功值（含 `null`）缓存、失败不缓存，
  因此下一次连接可以重试；引用归零但引导在途时保留条目到引导落定。
- 单写者竞争：共享 store 下每个连接必须用独立 owner，`uniqueOwner(base, random)` 追加
  `#<8 hex>`；否则同 owner 会被存储当作续租，两个标签页同时持有写权。抢不到租约的连接按
  follower 降级：`acceptEvents` 遇 `SCOPE_BUSY` 时置 `writerRetryAtMs = now + FOLLOWER_RETRY_MS`
  （1000ms）并丢弃实时入口事件，**不** `stopIngress`；它的 tick 从共享 store 的已提交边界追赶，
  因此 follower 仍能看到 leader 提交的更新。
- 真实历史源：握手时经 `attachGatewaySyncConnection` 注入
  `createLegacyChatHistorySource({ docs: DocManager, rcsSessionId, acpSessionId })`，把旧 Chat Doc
  的已提交时间线映射为 `importHistory` 记录。只取终态（跳过 pending/streaming）、`user`/`assistant`
  的 `type:"text"` 正文，entryId 原样保留，长文本按 UTF-16 code units 切片且不拆代理对
  （`LEGACY_HISTORY_PART_CHARS = 64KiB`）。选择旧 Chat Doc 是因为它是仓库内唯一可验证的稳定投影。
- 阻塞证据（不伪造恢复成功）：仓库内不存在 Peri 持久化历史的读取契约——
  `grep -rn "importHistory" apps packages/agent-runtime/src` 零命中；ACP `load_session` 只提供
  增量回放。因此生产历史源以可注入的 `SyncHistorySource` 接缝实现，未来接入 Peri 持久接口时
  只需替换这一适配器，sync runtime 不改。已知限制：导入只发生在握手时，之后旧 Doc 新增的稳定
  条目不会追补；条目级时间戳与非文本内容不在映射范围。
- 恢复判定：`bootstrapGeneration` 三分支——已提交且 `importEndOrdinal > 0` 的代次直接复用
  （重启/重连不重复导入）；有历史源则读取，空列表回退空基线（不得把「无历史」伪装成导入成功）；
  无源或读取失败由调用方回退空基线并 `reportError`。失败从引导任务抛出、注册表不缓存，下一次
  连接重试。并发回退经 `ensureBaseline` 的 `SCOPE_BUSY` 退避（最多 40 次 × 5ms）重读指针复用
  赢家代次，避免一次恢复失败让部分标签页握手失败。
- 快照水合时序（2026-10-19 复核修复）：`createRedisProvider` 暴露 `hydration: Promise<SnapshotHydration>`
  （`loaded` / `empty` / `failed` / `stale`，永不 reject），`loadChatDoc` / `loadSessionDoc` 等它落定后
  才补结构并返回；`DocManager.openChat` / `openSession` 对同一会话共享在途 Promise，握手历史源
  `legacy-chat-history.read()` 因此拿到的必然是已水合的旧 Chat Doc。确定行为：无快照 → `empty`
  （空结果才是可缓存的「确实无历史」）；读取失败 / 代次已被替换 → `failed` / `stale`，打开明确
  失败且不留下半初始化 Doc，注册表不缓存，下一次连接重试。
- 快照恢复顺序（复核修复的既有缺陷）：必须先 `Y.applyUpdate` 快照、再执行
  `initChatDocStructure` / `initSessionDocStructure`。顺序交换时本地空 `entries` / `entryOrder` /
  `toolCalls`（Session Doc 的 `session` / `agent` / `sessions` / `tasks`）会参与 Yjs 根 map 同键
  冲突，目标 clientID 较大时空结构覆盖快照，整份历史不可达。`snapshot-hydration.test.ts` 以
  Chat Doc 20 条历史、Session Doc 20 条会话摘要分别在 clientID 0/2/10/1000 下验证恢复完整，并覆盖
  Redis 延迟加载、无快照确定空、加载失败重试与真实握手导入；`loadChatDoc` / `loadSessionDoc`
  因此改为异步，`createChatDoc` / `createSessionDoc` 仍只用于新建世代（`hydration` 固定 `empty`）。
- 实施缺陷一（阻断多标签实时写入）：历史导入的内容块全部由 `HistoryCommitter` 写成 `sealed`，
  恢复时 `rebuildFromCommitted` 却把闭包末位当作活动块，首条实时写入必被存储以
  `RESOURCE_RETIRED` 拒绝。`content-tail.ts` 的 `ensureWritableContentDoc` 在
  `importEndOrdinal > 0` 且目录末位为空或等于闭包末位时，用确定性 nonce `live-tail` 与
  `blockIndex + 1` 新建 active 尾块并追加到目录页；空基线行为不变。已知限制：若在「封口旧块」
  与「目录页追加 successor」之间崩溃，存储没有读取 active Doc 的出口，恢复会显式失败而非伪造可写。
- 实施缺陷二：`MemoryProjectionStore.commitGeneration` 原先未把 `acpSessionId / loadId /
  importEndOrdinal / createdAt` 写回代次记录，重启后无法区分已导入代次与空基线；现已补齐。
  `live-writer.close()` 同时主动 `releaseWriter`，重连不必等待租约 TTL。
- 验证：`sync-host-session.test.ts` 16 pass（未注入注册表各自持有 store、同 scope 共享代次与
  follower 追赶、断线重连重新导入、已提交快照重启不重导、源失败回退且下次重试成功）；
  `sync-store-registry.test.ts` 5 pass、`legacy-chat-history.test.ts` 6 pass；
  `sync-gateway-e2e.test.ts` 6 pass，其中新用例经真实 `ChatChannelController`/`Gateway`/
  `SyncHostSession` 把旧 Chat Doc 的 `legacy hello` 经 stateless 握手导入，两个标签页共享
  generation 与目录，leader 的 `live hello` 落到新 active 尾块后 follower 读到同一正文；
  `sync-chat-projection.test.ts` 11 pass，含 `text_part` 保真 JSON 解码与坏载荷计入 skipped。
  `snapshot-hydration.test.ts` 6 pass：Redis 延迟快照下 `openChat` 与真实 HELLO 导入都等待水合、
  无快照确定空、加载失败拒绝并可重试，以及 Chat/Session Doc 在 clientID 0/2/10/1000 下恢复完整。

### 3.8 旧全量通道退役边界（2026-10-19）

- 服务端分流：路由按 `chatSync=1` 注入 `syncOnly`，`Gateway` 为该连接跳过
  `synchronizeInitialDocs`（不再发 `yjs:sync-request`、不再 500ms 超时后补全量快照）；
  `YjsBroadcaster.broadcastMessage` 按连接跳过旧 Doc 增量；`gateway-message` 忽略其 legacy
  `state-vector`。文本 JSON action（会话切换、取消、权限响应等）与同步 runtime ingress 不变。
- 保留旧通道：无 `chatSync` 标记或 `chatSync=0` 的连接逐字节保持原行为；同一会话可混用新旧
  标签页。旧 Yjs WS 仍由前端独立建立，继续承载动作与非文本文档更新。
- 展示层退役：`createSyncMessageMerger` 在新投影已含文本时丢弃**未配对**的纯文本旧消息
  （用户消息，或无错误、只含 `message` chunk 的助手消息）；工具、计划、思考与错误仍从旧通道
  补充。新投影为空时保留旧全量；`chatSync=0` 或 `shouldFallbackToLegacy` 不进入合并器，
  继续使用旧全量。已按 entryId/正文配对的消息仍取更完整一侧，退役不会误删双写副本。
- 保留理由（真实阻塞，不伪造验收）：仓库内不存在真实 `/history` 端点，Peri 持久历史契约
  不存在（ACP `load_session` 仅增量）；同步 store 仍是进程内 `MemoryProjectionStore`，
  无法做真实重启验收。新投影目前也只覆盖用户/助手文本，final descriptor 与工具对象尚未接入，
  因此不能删除旧通道的非文本/动作能力。
- 移除前置条件：新投影覆盖 final/工具/计划并具备独立历史读取契约；投影 store 具备跨进程
  持久化与重启恢复；真实多版本灰度验证完成。满足前保持 `chatSync=0` 回滚路径与旧 Yjs WS。
- 验收矩阵：真实 `/history` **不可做**（端点不存在）；持续生成由 `sync-gateway-e2e` 的实时
  `DOC_UPDATE` 覆盖；旧页阅读由 `sync-content-window`/`sync-frame-router` 覆盖；重启以
  `exportCommittedState`/`restoreFromCommittedState` 的进程内等价物覆盖；多标签在进程内共享
  store 场景覆盖。新增 `sync-legacy-retirement.test.ts` 验证无旧快照/无广播/忽略 state-vector
  且 action 可达，`sync-chat-messages` 与 `use-chat-hydration` 验证文本退役、非文本保留与回退。

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
- 旧全量通道退役（§3.8）：`sync-legacy-retirement.test.ts` 5 pass（无 sync-request/快照、无旧广播、
  忽略 state-vector、action 可达、旧连接不变）；`sync-chat-messages.test.tsx` 13 pass 与
  `use-chat-hydration.test.tsx` 5 pass 覆盖文本退役、非文本保留、空投影与回退。chat-channel 全量
  **1510 pass / 81 files**，agent-runtime web + apps/web **479 pass / 57 files**；`bun run typecheck`、
  `bun run build:web`、`bun run fastcheck` 均通过；`bun run precheck` 全绿（web 360、server/script 981、
  package 10430 通过 / 2 跳过）。

## 5. 未覆盖与不可做

| 项 | 结论 | 原因 |
| --- | --- | --- |
| 灰度与新旧协议共存（T16） | 部分覆盖 | 默认开启、明确拒绝回退、历史合并与 `chatSync=1` 旧全量退役已有浏览器/包内测试；多版本真实部署、灰度观测与回滚验证仍待实施 |
| T13 长跑与资源趋势 | 不可做 | 需 24 小时墙钟与固定硬件 profile；假时钟只能覆盖轮换/热工作集的正确性分支 |
| T23 暂存盘满与故障注入 | 不可做 | 需 sharedrelay 真实进程与真实磁盘故障；`history/spool.ts` 没有失败注入点，进程内近似会冒充已覆盖 |
| T07 / T21 持久化分支 | 未覆盖 | 需真实 SQL 幂等语义与进程重启；进程内等价物已覆盖 fencing 与指针单调 |
| 多标签共享 | 进程内已实施 | 同 scope 共享 `SyncStoreRegistry` 的 store 与一次历史引导，follower 从共享已提交边界追赶；runtime/provider/订阅仍按连接隔离。Redis 快照水合时序已覆盖（延迟加载、无快照、加载失败重试），但投影 store 的跨进程与 Redis 共享仍未覆盖，需持久化 adapter |
| 历史重建 | 旧 Chat Doc 已实施 | 握手时等待 Redis 快照水合后再读旧 Chat Doc 的已提交时间线；无快照才是可缓存的「无历史」，读取失败/代次失效明确失败且下次重试。Peri 持久历史契约不存在（`importHistory` 零命中，ACP `load_session` 仅增量），已留可注入 `SyncHistorySource` 接缝；导入后的新稳定条目不追补 |
| Redis 快照恢复 | 已覆盖 | `loadChatDoc` / `loadSessionDoc` 先 `Y.applyUpdate` 再幂等补结构；provider 在 `GETBUFFER` 前与 apply 后各校验一次 active generation，窗口内换代记为 `stale` 而非 `loaded`。DocManager 为每个 rcsSessionId 维护单调 open/close fence：水合期间发生 `replaceProjection` / `closeChat` / `closeSession` 时，在途 open 销毁自己加载的旧 Doc，不写 map、不注册广播；换代则返回 map 中的新世代 Doc，纯关闭则明确报错。回归覆盖 Chat/Session 换代、关闭后复活与 apply 前换代；跨进程并发换代仍只以进程内 fence 覆盖 |
| final / 非文本展示 | 未覆盖 | final descriptor、history/tool 对象尚未接入新投影 |
| UI 渲染 | 文本已退役旧通道 | 用户/助手文本以新投影为准；未配对旧纯文本不再进入合并视图，工具/计划/思考/错误仍依赖旧 Doc。移除条件 = final/工具对象接入新投影 |
| 旧全量通道退役 | 服务端与展示层已实施 | `chatSync=1` 连接跳过旧快照、旧 Doc 广播与 state-vector；动作与非文本仍走旧 Yjs WS。删除旧通道的前置条件见 §3.8 |
| 初次加载 hydrate 完成信号 | 客户端门控已实施 | 旧路径由服务端在窗口开启时写入 `replay_started`，load/resume 后由 acp-link 发 `session/replay_complete`（含零历史），relay 立即收敛并写 `replayState=complete`；连接建立时写 `timelineEmpty` 供首次加载已有空会话直接放行；新协议用 DOC_BASE 的 processed APPLY_ACK。旧宿主不发 `replay_complete` 时保留 1.5s 兜底、12s 硬上限；完整基线后到的首次合并放宽 5s 配对窗口一次。重连 HELLO 不复用上一代 generation。移除条件 = 全量宿主升级后删除客户端兜底 |
| 大基线渲染窗口 | 已实施 | 默认只挂载最近 1000 条，更早消息由用户显式加载；DOM 有界（10k 条目一次性渲染从 1.7s 降至约 0.2s）。加载更早后滚到第一条新增历史，不再钉在底部；移除条件 = 引入带锚点的虚拟列表 |

## 6. 下一步（按设计分阶段）

1. 完成灰度验证：观测拒绝率、重连与资源占用，验证开关关闭可回滚并覆盖新旧协议共存（T16）。
2. 接入 Peri 持久历史契约后替换 `SyncHistorySource` 适配器；当前以旧 Chat Doc 已提交时间线为源，ACP `load_session` 仅有增量。
3. 经用户批准表结构后实现 DB adapter，把进程内共享 store 扩展为跨进程/重启共享，并解决现有内存 store 的恢复限制。
4. 按 §3.8 的移除前置条件推进：接入 final/工具对象与真实历史契约、完成持久化与灰度后，再删除旧 Yjs WS 与 `chatSync=0` 回退。
4. 补齐 final / 非文本内容映射并接入 UI 渲染；随后验收 T13、T23、T07/T21 持久化分支及固定 profile 性能门槛。
