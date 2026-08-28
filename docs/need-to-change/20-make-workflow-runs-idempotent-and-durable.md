# 20. Workflow Run 需要 operation identity、稳定密钥和可恢复终态

| 属性 | 结论 |
| --- | --- |
| 优先级 | P1 |
| 置信度 | 高 |
| 影响 | 客户端重试重复副作用、审批重启失效、run 状态与实际执行分叉 |

## 对抗判决

外部 execute API 没有 idempotency key；客户端 timeout/retry 可启动多个相同运行。同步超时契约允许 workflow 继续运行，但调用方缺少稳定 operation 语义。每组织 WorkflowEngine 未配置密钥时使用随机 UUID 作为 HMAC secret，进程重启后旧审批 token 全部失效；engine map 又按组织常驻内存。

## 已核验证据

- `src/routes/api/workflows.ts:27-82`：execute 请求没有幂等 header/body identity。
- `src/services/workflow/workflow-execute.ts`：同步超时可在后台继续，需以 runId 查询，但重复提交无 dedup。
- `src/services/workflow/index.ts:31,76-100`：按组织缓存 engine；HMAC secret 缺失时 `crypto.randomUUID()`。
- `packages/workflow-engine/src/engine/workflow-engine.ts:376`：审批验证依赖该 secret。
- `src/routes/web/workflow-runs.ts:97-163`：route 自行挂 background result/finalization，生命周期规则未完全封装。

## 架构诊断

runId 是执行结果 ID，不等于调用 operation identity。请求接入、调度、审批、安全密钥、状态持久化和 cleanup 分散，调用方无法区分“未接受”“已接受但响应丢失”“仍运行”“终态已持久化”。

## 目标不变量

- 所有有副作用的执行入口接受租户作用域 idempotency key；相同 key+payload 返回同一 operation/run。
- 接受运行与持久化 identity 在同一事务/可靠入队边界完成；响应丢失后可查询。
- Workflow secret 是必填、可轮换的稳定密钥引用；token 带 key version，不在重启时随机变化。
- Run state machine 明确 accepted/running/cancelling/succeeded/failed/timed-out-but-running 等状态和合法转换。
- engine/runtime cache 有租约与逐出；run correctness 不依赖某个内存 engine 存活。

## 分阶段整改

1. 给外部 API 增加 operation identity 和查询端点，保持旧调用方兼容窗口但记录重复风险。
2. 将 accept/dedup/run 创建收敛到 Workflow Application Module。
3. 强制部署稳定 HMAC secret，设计 versioned rotation。
4. 把 background finalization 迁入 durable worker/state transition，删除 route 内重复收尾。

## 验收与观测

- 响应在任意时点丢失并重试，执行只发生一次。
- 服务重启后可继续查询 run、验证轮换期审批并恢复 finalizer。
- 指标包含 dedup hit/conflict、stuck state、transition reject、approval key version、engine cache 高水位。

## 依赖

执行隔离见 [1](./1-isolate-workflow-execution-plane.md)，远端取消/finalizer 见 [17](./17-propagate-workflow-cancellation-and-finalization.md)。
