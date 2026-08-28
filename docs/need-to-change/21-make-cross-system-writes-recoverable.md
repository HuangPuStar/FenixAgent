# 21. 跨系统写入必须可幂等、可补偿、可对账

| 属性 | 结论 |
| --- | --- |
| 优先级 | P1 |
| 置信度 | 高 |
| 影响 | 远端孤儿资源、RCS 幽灵记录、token 丢失、人工修库 |

## 对抗判决

Agent Sites 的创建、删除和 token 轮换由 route 顺序调用远端 API 与本地 DB，没有 operation identity、事务外补偿或 reconciliation。任何一步失败都会留下合法但互相矛盾的两套状态；重试还可能扩大副作用。

## 已核验证据

- `src/routes/web/agent-sites.ts:190-216`：先创建 remote app、再签 token、最后插 DB；后两步失败会留下远端 app/token。
- `src/routes/web/agent-sites.ts:276-290`：先删远端、再删 DB；DB 失败留下指向不存在资源的本地记录。
- `src/routes/web/agent-sites.ts:311-331`：先吊销旧 token、再申请并持久化新 token；中间失败可失去访问。
- 这些编排位于 HTTP route，重试、补偿和终态未形成 Application Module。

## 架构诊断

跨系统操作无法靠数据库 transaction 原子化，需要显式 saga/operation state。当前 interface 只有“调用并返回”，把部分成功这一核心 implementation 隐藏在 route 的 try/catch 外；删除 route 会同时删除业务恢复语义，说明 adapter 不浅。

## 目标不变量

- 每次跨系统 mutation 先创建租户作用域 operation identity，记录目标、步骤和幂等 key。
- 每一步有明确前置、成功证据、可安全重试规则和补偿；未知结果进入 reconcile，而不是猜成功/失败。
- 创建使用远端 idempotency key；删除使用 tombstone + 可重试收敛；token 轮换先安全持久化新凭据，再切换/撤销旧凭据。
- HTTP response 区分 accepted/in-progress/succeeded/failed-needs-attention，并允许查询 operation。
- 定期 reconciliation 比较本地/远端，修复或报警；不能把 token/敏感远端响应写日志。

## 分阶段整改

1. 先为 create 写 durable operation 和远端 idempotency，补每一步故障注入。
2. 迁移 delete、rotate，定义补偿与人工处置状态。
3. 抽离 route 中编排并建立 reconciliation worker/运维视图。
4. 搜索知识库、Skill import、provider 等其他跨系统写，按同一词汇迁移。

## 验收与观测

- 在每个网络/DB 边界注入 timeout、响应丢失、重复响应、进程崩溃，最终状态可自动收敛或明确告警。
- 同 operation 重试不创建第二个远端资源。
- 指标包含 operation age、retry、compensation、reconcile drift 和 manual-intervention backlog。

## 回滚

新旧路径不能双写。按操作类型切流，旧在途操作先 drain/reconcile；回滚只改变新操作接入，不删除 operation ledger。
