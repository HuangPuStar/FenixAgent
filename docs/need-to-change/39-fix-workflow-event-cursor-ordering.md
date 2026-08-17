# 39. Workflow event cursor 必须与总排序完全一致

| 属性 | 结论 |
| --- | --- |
| 优先级 | P1 |
| 置信度 | 高 |
| 影响 | 恢复漏事件、run 状态错误、无法重放真实历史 |

## 对抗判决

PostgreSQL adapter 正式排序使用 `(createdAt, eventId)`，但 `afterEventId` 查询只取 anchor 的 createdAt 并使用 `createdAt > anchor`。同一时间戳内排在 anchor 后的事件全部丢失。Snapshot recovery 依赖该 cursor，因此恢复结果可能缺少已持久化事件。

## 已核验证据

- `src/services/workflow/pg-storage-adapter.ts:50-66`：cursor predicate 只有 `createdAt > anchorCreatedAt`。
- 同文件 `:80-86`：结果总排序为 `createdAt, eventId`。
- `packages/workflow-engine/src/recovery/snapshot-recovery.ts:106`：恢复调用该 after cursor。
- 内存 adapter 按数组位置行为正确；现有测试主要覆盖内存路径，未覆盖 PG 同时间戳。

## 架构诊断

Cursor 是排序 interface 的序列化形式，必须包含完整 total order。当前只保存/还原半个 key，数据库实现与领域契约不等价。

## 目标不变量

- 事件有不可歧义的总顺序；cursor 包含完整 `(createdAt,eventId)` 或更合适的单调 sequence。
- 查询谓词与 order by 完全一致：时间更大，或同时间且 eventId 更大。
- `(organizationId,runId,createdAt,eventId)` 有匹配索引；事件 identity 有唯一约束。
- cursor versioned/opaque，调用方不能自行拆字段；跨页/恢复无重复、无遗漏。

## 分阶段整改

1. 写 PostgreSQL integration test：同 createdAt 插多事件，从中间继续。
2. 修复复合 cursor/predicate/index，并验证旧 snapshot 恢复。
3. 评估使用 run-local monotonic sequence，若迁移则用双读验证后删除旧 cursor。

## 验收

- 相同时间戳、乱序插入、分页边界、并发 writer 和 snapshot recovery 均无漏/重。
- 重放后的领域状态与完整事件集直接计算结果一致。
- 指标记录 cursor anchor missing/invalid 与 recovery event count mismatch。

## 回滚

若更改 cursor 格式，先支持读取旧 cursor 并发出新格式；这是外部/持久化契约时需版本窗口，不能直接猜字段。
