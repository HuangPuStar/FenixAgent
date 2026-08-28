# 42. 进程退出必须是有顺序、有 deadline 的 Drain Protocol

| 属性 | 结论 |
| --- | --- |
| 优先级 | P1 |
| 置信度 | 高 |
| 影响 | 运行中任务写入已关闭 DB、Y.Doc/文件事件丢失、timer/子进程泄漏、滚动发布截断工作 |

## 对抗判决

SIGTERM 路径停止 scheduler 后很快停止实例、关闭缓存/PG 并 `process.exit`。Scheduler stop 只取消未来 job，不取消/等待当前 executor；machine sweep 没调用已有 stop；file event limiter 的 flush 也未进入 shutdown；Chat Redis persist 没 flush。资源 owner 分散，退出顺序无法证明。

## 已核验证据

- `src/services/scheduler/index.ts:45-56`：stop 清未来 job/Set，不 await running executor。
- `src/index.ts:261-280`：gracefulShutdown 顺序未停止接入/等待业务 drain，最终 process.exit。
- `src/services/registry-heartbeat.ts:93-97` 提供 `stopMachineSweep()`，shutdown 未调用。
- `src/services/file-event-limiter.ts:109-123` 提供 flush interface，shutdown 未调用。
- `packages/chat-channel/src/persist/redis.ts:359-365`：destroy 不等 persistInFlight；主 shutdown 未 closeAll。
- [17](./17-propagate-workflow-cancellation-and-finalization.md) 证明 Workflow/Agent turn 也缺远端取消收敛。

## 架构诊断

每个 subsystem 创建自己的 timer、listener、queue、connection 和 child process，却没有统一 Lifecycle registration interface。shutdown 只能记住一份手写调用清单，新增资源时必然漏掉。

## 目标不变量

- 收到信号后先切 readiness false、停止接受新 HTTP/WS/Job/command。
- 向所有 active operation 传播 AbortSignal/draining deadline；按协议 cancel 并等待有界收敛。
- 按依赖逆序 flush：业务队列/事件/Y.Doc → relay/child process → cache/Redis → DB → logger。
- 每个 Module 注册幂等 disposer，声明 phase、deadline 和关键性；二次信号可缩短 deadline但不产生竞态。
- 超时强退留下 dirty-shutdown 指标/恢复标记，下一次启动执行 reconciliation。

## 分阶段整改

1. 写挂起 scheduler/Chat persist/file batch/Agent turn 的 SIGTERM integration test。
2. 引入 Lifecycle coordinator，先注册现有 stop/flush hooks。
3. 补缺失 cancel/flush，切 readiness 与 load balancer drain。
4. 静态/测试检查创建 interval/listener/worker 的 Module 必须提供 disposer。

## 验收与观测

- 滚动发布期间新请求不进 draining 副本，在预算内完成或得到可恢复终态。
- 关闭 DB 后没有业务写；所有 timer/listener/subscriber/child process 归零。
- 指标包含 drain phase latency、active operations、forced cancel、dirty shutdown 和 recovery backlog。

## 回滚

先以较长 deadline 启用并观察；可调整时间预算，但不能恢复立即 `process.exit` 作为正常滚动发布语义。
