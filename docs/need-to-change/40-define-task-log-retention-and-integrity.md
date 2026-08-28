# 40. Task execution log 必须明确是级联数据还是审计记录

| 属性 | 结论 |
| --- | --- |
| 优先级 | P2 |
| 置信度 | 高 |
| 影响 | 孤儿日志无限增长、查询退化、审计归属不清 |

## 对抗判决

`task_execution_log.taskId` 没有 FK/索引；删除任务只删 task 并 unschedule，日志仅在显式清空接口删除。结果是任务消失后日志永久孤立，既不能作为完整审计记录（缺少租户/任务快照），也不是随任务生命周期管理的普通子资源。

## 已核验证据

- `src/db/schema.ts:325-339`：taskId 无 FK，无 `(taskId,createdAt)` 索引。
- `src/services/task-v2.ts:239-248`：删除 task 不处理 execution logs。
- `src/repositories/task.ts:73-75`：日志删除只由显式 clear 使用。
- 未发现 retention job 或归档策略。

## 领域决策（二选一）

1. 非审计运行明细：taskId FK `ON DELETE CASCADE`，定义短 retention 和容量预算。
2. 审计记录：保留 organization/user/task identity 与任务名称/类型/触发配置摘要，task 删除后仍可按租户检索；建立不可变性、访问控制、retention/legal policy。

两种语义不能通过“无 FK 的孤儿行”同时获得。

## 目标不变量

- 每条 log 有明确 tenant scope 和生命周期 owner。
- 查询索引与主要访问模式一致，分页 cursor 稳定。
- error/result summary 有大小与脱敏策略，不保存 token、完整 prompt/响应。
- retention/删除可观测、分批、有背压，不长事务锁全表。

## 验收

- 删除 task 后日志行为符合选定语义；跨组织无法观察。
- 百万级数据 EXPLAIN/性能测试满足预算；retention 可重复且不漏/重删。
- 指标包含 log growth、oldest age、retention lag/failure 和 query latency。
