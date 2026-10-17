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
| G 接线（包内可运行） | 已落地：`runtime/` 把 D/E/F 装配成 scope 级运行时可运行整体（入口规范化、出帧网关、编排器、装配期校验）。**未接宿主**（relay、`channel/gateway.ts`、`state/**`、`persist/*`、前端投影适配）——见第 3 节第 5 条 |
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
3. **协议帧的编解码为结构化对象 + JSON**：设计与字节预算已实现，但**尚未**绑定现有 WebSocket 帧层
   （`protocol/update-frame.ts` 的二进制帧）；宿主接线时需要显式映射并决定协议版本协商。
4. **清理宽限期必须显式注入**：设计未固定 `sealGraceMs`/`retireGraceMs`，因此实现不提供默认值，装配期必须给出。
5. **宿主接线未做，非「功能已完成」**：`runtime/` 是包内可运行整体，尚未替换线上聊天链路——
   relay 传输、`channel/gateway.ts`、`state/**` 投影层、`persist/*` 快照与前端 Chat 投影适配都还是旧路径。
   因此设计 §15.2 里依赖宿主的场景（T16 新旧协议共存）与依赖真实持久化的分支无法验收。
   移除条件 = 宿主按设计 §14 步骤 1 引入开关并灰度，接通后本节的偏差 1/3 必须先解决。
6. **网关不参与额度记账**（偏离规格 §2.4 的文字）：连接窗口（已发送未 ACK 字节）的唯一所有者在 `session` +
   `AckLedger`——session 每帧已预留、ACK 经账本归还。网关对同一帧再记一次会让在途帧被扣两份，故工厂入参没有额度；
   网关的判据只剩 socket 真值 `bufferedAmount() + 真实编码字节 > socketHighWatermark`。移除条件 = 额度记账收口到单层后。
7. **网关公开面比 §2.4 多一个 `driveWithheld()`**：搁置帧的重试必须由编排者的 `tick()` 驱动，而 `scanTimeouts()`
   的语义是「只判定超期数」，故另开一个名实一致的入口。
8. **搁置语义分两类**：传输饱和（socket 门禁拒发或 `send` 返回 false）每 tick 重试；控制限流（governor 拒发）不在
   tick 重试（否则违背「搁置 ≠ 排队重发」，T22-2 已固化），只在搁置期限届满时做一次「最后机会」重试。两者共用一个
   一位有界搁置位，期限锚定**首次**拒发时刻，届满仍发不出去即关连接并清账。
9. **入口要求事件带 `turnId`**：真实 ACP `session/update` 载荷本身不含 `turnId`，宿主必须补齐（缺则返回空数组而不是
   猜测归属）。`final` 形态也不在入口产生——它需要存储侧的 `finalDescriptor`，由封口路径产出。
10. **客户端 `rejected` 也回 `APPLY_ACK`**：provider 的 `onAck` 接受 `rejected` 并转入 resync；是否额外发 RESYNC
    由 `APPLY_REJECT_REASONS` 决定。只回执成功会让被拒投递永不结账。
11. **被顶替的数据帧不重发，改由编排者自结算归还窗口**：沿用设计 §8.5「丢弃的是冗余发送任务」，搁置位只有一位，
    被新帧顶替的旧帧不再有引用、也不会有 ACK。故补一条自有释放路径：`egress.withhold` 发现顶替即回调
    `onDeliveryAbandoned(deliveryId)`，经 `scope-runtime` 接 `session.abandonDelivery` → `AckLedger.abandon` 归还该帧
    预留字节（重复调用与异代次返回 0）。缺口不补发、不断连，交由客户端 `doc-hub` 的 `sequence-gap` → RESYNC 补齐。
    移除条件 = 引入第二个产出入口（补发通道）后由其取代。
12. **控制帧被顶替必须立即断连**：控制帧线上无 `deliveryId`、不进 ACK 超时表，也没有第二次产出入口，被顶替即客户端
    永久收不到（典型是半握手：MANIFEST 被数据帧顶替）。因此 `withhold` 对控制帧改为以明确理由关连接
    （`withheld <TYPE> frame was superseded before delivery and has no recovery path`），且不保存顶替者。
    代价：持续饱和且连产控制帧时，每次顶替换来一次断连重连（第三轮 O1 观察）。移除条件 = 控制帧获得可重发身份。

## 4. 验证证据

- 包内测试：**1451 通过 / 0 失败**（73 个文件；含全部存量测试，无回归）；`src/sync/**` 与接线阶段的验收、
  对抗与规模用例均在 `packages/chat-channel/src/__tests__/` 下。
- `bun run precheck` 全绿（类型检查、lint、依赖边界、架构检查）；`bunx biome check packages/chat-channel` 0 告警。
- 浏览器安全边界：`chat-channel-browser-surface.test.ts` 走根入口与 `./sync-client` 的值导入图，断言未触及
  node 内建 / ioredis / 服务端模块。
- 对抗式验证（以证伪为目标）共发现 **20 个真实缺陷**，全部修复并留下回归用例：
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
    `sync-verify-supersede.test.ts` 16 用例）；记 3 条观察未判缺陷——顶替控制帧即断连的代价（已记入第 3 节偏差 12）、
    被顶替的 base 服务端无兜底重规划（恢复依赖客户端 SUBSCRIBE/RESYNC）、`session.onAck` 不查账本（对已归还的迟到
    ACK 仍推进 attempt，生产不可达）。
- 历史导入规模：**20,000 个对象（≈100MiB）导入成功**，722 个提交块，5834 对象/秒、29.17 MiB/秒，总耗时 3.4s；
  接收阶段 8404 对象/秒、42.02 MiB/秒（缺陷修复前该路径必然失败）。进程内存峰值 `processPeakRssMiB ≈ 481`，
  **未归因**（含 Y.Doc、暂存与构建槽的多份副本），需在宿主接线前定位。
- 性能：本机短时采样（Apple M5 Pro / 18 核 / Bun 1.4.2 / Yjs 13.6.31）——单次 apply（N=2500）1KiB 载荷
  p99 0.0227ms、16KiB 载荷 p99 0.0381ms（目标 p99 ≤8ms）；热工作集 5 批：活文档 `loadedPerAppendedByte = 1`、
  已释放文档 `loadedBytes` 差 0、GC 后 heapUsed 增量 +24.5KB，即不随已封存历史线性增长。**明确不是证据**：非设计
  §15.3 的固定硬件 profile，未覆盖实时端到端延迟、控制消息/公平性与 24 小时 soak。原始数据见
  `.peri/plans/chat-sync-runtime-profile-result.md`。

## 5. 未覆盖与不可做

| 项 | 结论 | 原因 |
| --- | --- | --- |
| T13 长跑与资源趋势 | 不可做 | 需 24 小时墙钟与固定硬件 profile；假时钟只能覆盖轮换/热工作集的正确性分支 |
| T16 新旧协议共存 | 不可做 | 需旧二进制 + 旧投影 + 可灰度的宿主装配层；单版本进程内无法构造 |
| T23 暂存盘满与故障注入 | 不可做 | 需 sharedrelay 真实进程与真实磁盘故障；`history/spool.ts` 没有失败注入点，进程内近似会冒充已覆盖 |
| T07 / T21 持久化分支 | 未覆盖 | 需真实 SQL 幂等语义与进程重启；进程内等价物已覆盖 fencing 与指针单调（用例名标注「等价物」） |
| 宿主接线与前端投影适配 | 未实施 | 见第 3 节第 5 条；不动 DB 使「持久化保证」无法成立，故不在本阶段替换线上链路 |

## 6. 下一步（按设计分阶段）

1. 宿主接线：按设计 §14 步骤 1 引入开关，接通 relay 传输与 `channel/gateway.ts`、`state/**` 投影层、前端 Chat 投影适配。
2. 定位导入路径的内存峰值（481MiB）后再开灰度。
3. 存储接线：先经用户批准设计 §9.1 的表结构，再实现 DB adapter 并接入现有 DocManager/persist 路径；同时替换
   偏差 1/2 的两处占位（内存存储、进程内构建池）。
4. 验收补齐：T13/T16/T23 与 T07/T21 的持久化分支，以及设计 §15.3 的固定 profile 性能门槛。
