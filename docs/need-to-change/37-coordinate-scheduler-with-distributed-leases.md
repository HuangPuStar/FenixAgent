# 37. Scheduler 多副本必须使用分布式 claim 与稳定 invocation key

| 属性 | 结论 |
| --- | --- |
| 优先级 | P1（多副本部署即 P0 业务风险） |
| 置信度 | 高 |
| 影响 | 每个副本重复执行 cron、外部副作用/Agent 成本倍增、重启窗口重复 |

## 对抗判决

每个 RCS 进程启动时加载全部 enabled task；`activeJobs` 和 `runningTasks` 都是本地 Map/Set，防重只覆盖单进程。执行日志没有稳定 invocation key 或唯一约束。扩容两个副本等价于把每个 cron 执行两次。

## 已核验证据

- `src/services/scheduler/index.ts:14-17`：调度和 running 集合仅内存。
- 同文件 `:29-43`：每个进程加载全部 enabled task。
- 同文件 `:106-127`：防重只检查本进程 Set。
- `src/db/schema.ts:325-339`：执行日志无 invocation identity/唯一幂等约束。
- 当前测试覆盖单进程 stale job 清理，未发现 DB lease、advisory lock、队列 claim 或多实例测试。

## 架构诊断

Scheduler 同时是时间计划器和分布式执行 coordinator，但 interface 没表达 ownership/lease。内存 Set 只能优化本进程，不能成为业务幂等边界。

## 目标不变量

- 每个计划触发由 `(taskId, scheduledAt, scheduleRevision)` 生成稳定 invocation key。
- 数据库 claim/advisory lock 或队列单消费者保证同一 invocation 只有一个 owner；日志/operation 表有唯一约束兜底。
- lease 有 expiry、heartbeat、attempt 和 takeover；进程崩溃后可安全接管。
- executor 接收 invocation key，并向 HTTP/Agent/Workflow 下游传播各自幂等 key。
- schedule 更新/禁用与已生成 invocation 的语义明确，时区/DST 有测试。

## 分阶段整改

1. 先给 invocation/log 增加稳定 key 和唯一约束，阻止最坏重复。
2. 用两个 scheduler 实例对同一 DB 建 claim/lease contract test。
3. 迁移 cron 注册为“发现 due invocation”，执行由 durable worker claim。
4. 删除本地 Set 作为正确性保证；可保留为性能优化但不影响结果。

## 验收与观测

- 两副本同时启动/触发只产生一次业务执行和一条逻辑 invocation。
- owner 在执行中崩溃后按策略重试/接管，不出现永久 running 或并行重复。
- 指标包含 due lag、claim conflict、lease age/takeover、duplicate prevented、executor outcome。

## 回滚

可先开启单 active scheduler deployment 作为临时止血；这必须是显式拓扑约束和 readiness 检查，不应成为永久隐含假设。
