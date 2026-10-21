# Agent 执行准入与入站消息预算

## 执行来源和资源所有权

1. `creationSource` 只表达持久实例创建来源；每次 `openAgentSession` 和 Workflow 节点分别申请执行租约。
2. `RCS_AGENT_MAX_CONCURRENCY`、`RCS_USER_AGENT_MAX_CONCURRENCY` 约束运行实体容量，由现有 spawn reservation 原子准入。
3. `RCS_SCHEDULED_AGENT_MAX_CONCURRENCY` 约束本控制面进程中的 scheduled 活跃执行数量。复用同一个实例的两个任务分别计数，交互请求不占 scheduled 配额。
4. 执行租约在连接之前申请，解析实例后绑定；只有明确的执行终态、未发送 prompt 的退出，或者 Coordinator 确认 runtime 停止后释放。取消仅发出请求而未确认时保留额度，避免控制面结束等待后继续超发。
5. API / Workflow 程序化实例在运行投影中声明可空闲回收。回收前检查所有来源的活跃执行租约；交互请求与后台任务交替复用时不会互相误杀。没有程序化执行策略的交互 Chat 保持显式生命周期。
6. 公共管理面区分 `stopInstance`（用户停止）与 `reclaimInstance(id, organizationId, runtimeGeneration, reason?)`（自动回收）。Workflow 首次创建者在 ensure 成功后记录该运行代次；收尾一次性消费票据，无票据、运行换代、Workflow 使用租约或任何来源的执行占用均不得回收。跳过后交由空闲策略处理，不把旧票据改绑到新实体。
7. 默认 `idle` 回收保护全部活跃执行；`activity-timeout` 仅在真实活动硬期限已过且全部占用均为已确认运行的 scheduled 执行时允许终止挂死实例。交互、system 和等待 ensure 的新执行仍受保护。资格投影与 sweep 共用同一规则，Coordinator 实际开始停止前复核运行代次、投影身份、活动时间与执行准入；停止失败继续保留配额，确认停止后才释放。自动回收不建立或清除手动停止意图。真正用户停止后的 ensure 仍被拒绝，必须显式 restart。
8. 配额和运行投影均为进程内状态。多控制面拥有同一实例需要独立的分布式所有权设计。

## 入站预算

`InboundMessageQueue` 在持有第一条消息时同步登记数量与 UTF-8 字节预算，覆盖 `/acp/yjs` 的异步处理队列以及外部 relay 建连期间的缓存。

| 范围 | 普通消息数量 | 普通消息字节 |
| --- | ---: | ---: |
| 单连接 | 64 | 16 MiB |
| 同组织同用户所有连接 | 256 | 32 MiB |
| 整个控制面服务 | 2048 | 128 MiB |

1. 认证前连接也共享受控预算；认证后将已持有的预算转移到真实用户。单帧仍受原有 10 MiB 限制。
2. 取消/停止控制帧独立保留 2 条、64 KiB 容量，且完成授权和握手后可绕过慢普通消息。保留容量同时受到用户、服务聚合限制。
3. 超限记录连接标识并以 `1008 inbound queue limit` 关闭，未执行项立即释放。关闭不会继续调度缓存中的副作用；在途处理结算后释放其预算。
4. `snapshot()` 返回本队列持有的数量和字节（包括在途），便于诊断。只观察下游 CommandCoordinator 队列不能证明前置缓存有界。
5. Chat-channel 自身的未就绪文本缓存另有条数和字节限制，二进制同步保留既有预算。

## 任务终态

定时任务消费公共 `classifyAgentTurnEvent` 和可取消事件迭代器。仅明确成功终态写入 `success`；RPC error、取消、断连、未知终态和未确认 EOF 均失败。deadline 从会话连接前计时，摘要只保留最多 2000 字符，避免缓存整个事件流。
