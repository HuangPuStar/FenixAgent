# FenixAgent 消息同步协议：A/B/C 阶段实施记录

> 日期：2026-10-16。设计依据：[`2026-10-16-fenix-message-sync-design.md`](./2026-10-16-fenix-message-sync-design.md)（下称「设计」）。
> 范围：本文件只记录**已落地**的部分；设计全文仍是目标契约，未实施项见第 4 节。

## 1. 状态

| 项 | 状态 |
| --- | --- |
| A 契约与骨架 | 已落地（身份、帧、错误码、容量档案与准入、存储接口） |
| B 持久化写者 | 已落地为**内存 adapter**（保留 fencing、幂等、全组原子、只读已提交边界语义） |
| C 历史导入 | 已落地（保真 JSON、暂存、入口接收、分块构建、有界构建池、幂等提交、导入编排） |
| 接线与线上启用 | **未实施**：模块只经 `@fenix/chat-channel/server` 暴露，未接入 relay、gateway 或前端 |
| DB schema 与迁移 | **未实施**：按用户裁定本阶段不动数据库，设计 §9.1 的 5 张表仍属待批准建议 |
| D–G 阶段（实时写入/同步 provider/客户端/验收） | 未实施 |

## 2. 代码落点

`packages/chat-channel/src/sync/`（仅经 `src/server.ts` 的 `export * from "./sync"` 暴露；根入口保持浏览器安全）：

- `protocol/`：`identity`（scope/generation/docId/epoch 类型与生成）、`frames`（11 种帧的 zod/v4 schema 与字节预算）、
  `errors`（协议内部稳定错误码与 `SyncProtocolError`）。
- `capacity/`：`profile`（设计 §10 全部数值 + 8 条校验）、`admission`（池额度预留与交接）。
- `store/`：`types`（`ProjectionStore` 14 个原语与记录类型）、`memory-store` + `memory-store-state`（内存 adapter）。
- `history/`：`fidelity-json`、`spool`、`ingest`、`block-builder`、`build-pool`、`committer`、`import-service`。

## 3. 与设计的偏差（必须在使用前处理）

1. **存储是内存实现**：设计的 PostgreSQL 投影存储（事务、行锁、跨进程 fencing、崩溃恢复）未实施。
   `memory-store` 用注入 `Clock` 模拟租约、用「先全量校验再一次写入」实现全组原子，并提供
   `exportCommittedState`/`restoreFromCommittedState` 供测试验证「已提交快照 + 连续 tail」的恢复语义——它**不是**持久化。
   影响：重启丢投影、无跨实例 fencing。移除条件 = DB adapter 落地并由真实恢复路径取代该占位。
2. **构建池是进程内异步调度器**：保留「2 个构建者 / 执行+等待 ≤6 个任务 / 输入按文件范围传递」的额度语义，
   但不创建 `node:worker_threads`，因此未完全满足设计 §10.5「主线程只做受限小任务」。移除条件 = 落地 worker executor 后替换（接口不变）。
3. **协议帧的编解码为结构化对象 + JSON**：设计的握手/订阅/ACK 语义与字节预算已实现，但**尚未**绑定现有 WebSocket 帧层
   （`protocol/update-frame.ts` 的二进制帧），接线阶段需要显式映射并决定协议版本协商。
4. **清理宽限期必须显式注入**：设计未固定 `sealGraceMs`/`retireGraceMs`，因此实现不提供默认值，装配期必须给出。

## 4. 验证证据

- `packages/chat-channel` 全量测试 **990 通过 / 0 失败**（含全部存量测试，无回归）；`src/sync/**` 新增 292 个用例。
- 非测试源文件的 `tsc-rs` 诊断为 0（包内 25 条存量测试文件诊断在 `main` 基线同样存在）。
- `chat-channel-browser-surface` 守护测试通过：根入口值导入图未被污染。
- 容量数值与设计 §10 逐条核对一致（8 个子池、31 项输入上限、29 项并发/连接上限、客户端预算、公平权重）。
- 两路对抗式验证（以证伪为目标）共发现 **10 个真实缺陷**，全部修复并留下回归用例：内存写者 5（refs 校验晚于写入导致半提交、
  退役代次可继续封口、`putSealedIfAbsent` 写孤儿行、跨 scope 同名 docId 误判幂等、指针被失败路径改写）、
  导入编排 3（目录幻影缺口使完整性校验永不通过、`begin` 未登记 staging 代次、换代入口闭包缺内容块）、
  暂存配额 1（段目录缺失时配额不归还）、身份生成 1（`buildDocId` 未校验整体长度）。

## 5. 下一步（按设计分阶段）

1. D 实时写入（`LiveWriter` 合并/屏障、active → sealed 协议、运行态与控制 Doc 轮转）。
2. E 同步 provider（帧握手、订阅、额度与公平、ACK、差分与重连）。
3. F 客户端（DocHub apply 调度、成套 generation 替换、投影适配）——需同时决定帧协议的浏览器安全子集出口。
4. 存储接线：先经用户批准设计 §9.1 的表结构，再实现 DB adapter 并接入现有 DocManager/persist 路径。
5. 验收：设计 §15 的 T01–T24 oracle 与固定性能 profile。当前**没有任何**性能数据，容量数值只是待验证的验收配置。
