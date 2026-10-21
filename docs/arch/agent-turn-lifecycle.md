# Agent 执行、relay 与取消

## 所有权

1. Core runtime 持有物理 relay；首次建连共享在途操作。连接提交核对 runtime 对象、generation、epoch 和 running 状态。stop 会唤醒在途连接等待并关闭已到达及迟到句柄。
2. `connectRelay` 每次返回独立消费租约。租约 `close` 只注销该消费者的监听器，物理 relay 仅由 runtime 生命周期关闭。HTTP、Workflow、定时任务均不拥有持久 runtime。
3. 物理 relay 的 RPC 命名空间覆盖其整个寿命，消费者编号仅在本租约内有效。物理 relay 只注册一个监听器，响应先认领再向该租约本地监听器分发，不依赖适配器逐监听器创建的消息对象身份。每个消费回调独立隔离异常并记录低敏诊断，不能阻断同租约其他监听器或其他租约的状态分发。出站请求映射为单调 wire ID；结果和错误只还原给登记该请求的租约。消费归零及重连不重置物理编号；释放租约会废弃旧在途结果。Agent 发起的权限请求及消费侧权限响应保持原始 ID，不能按请求方向改写。带 session ID 的通知按租约登记的会话过滤，load 请求登记包含尚未确认的加载目标；无会话 ID 的全局通知保持广播。
4. `AgentSession` 持有消费租约；`PromptTurn` 持有独立请求 ID 与确认的 ACP session ID，按两种 JSON-RPC 包装格式过滤消息。环境刷新串行约束工作区写入，并在提交配置前复核运行身份；刷新不写生命周期状态。

## 会话与终态

`session/new` 必须收到匹配请求 ID 且含非空 session ID 的成功回执。`session/load` 的成功回执可省略重复 ID，此时沿用原请求 ID；显式返回其他 session ID 则失败。监听能力缺失、超时、RPC 错误和断连均显式失败，不能生成随机 session ID。

同一 instance 的同一 ACP session 只允许一个握手或 turn 持有独占租约，重复请求返回 409。ACP 取消仅按 session ID 寻址，因此取消未确认、断连或未知终态都继续持有该租约；匹配的确认终态或 Coordinator 确认 runtime 停止才释放。租约按 token 释放，旧代迟到终态不能释放新代租约。

`classifyAgentTurnEvent` 是 API、Workflow、定时任务共同的终态分类入口。只有明确的 ACP 正常 stopReason（end_turn、max_tokens、max_turn_requests、refusal）证明成功。RPC error、传输 error、取消、断连、未知 stopReason 和无确认终态的 EOF 均不得转换为成功。

## 取消与期限

HTTP 期限从打开会话前开始，覆盖 runtime readiness、连接、握手和事件消费。Workflow 节点信号传入 connect、握手与 execute。已取消操作不得发送 prompt；活动 turn 取消通过带独立 RPC ID 的 `session/cancel` 请求通知 Agent，不关闭其他消费者通道。取消请求 ID 与 prompt ID 分离；取消 ack 只表示交付，不能释放执行准入或终结 turn。远程 Dispatcher 同时接受标准无 ID 取消通知，调用 SDK cancel 后不回显、不生成成功终态。重复取消在同一活动 prompt 内只交付一次，SDK 失败进入诊断并以取消请求自身的 ID 回报；PromptTurn 记录取消拒绝后继续等待 prompt 终态。

`iterateWithSignal` 取消的是等待 `next()` 本身，静默连接也能按期限结束。错误输出由各入口按协议转换并脱敏，不能补发成功 end_turn。

取消通知只代表已请求取消。若 prompt 已发送但尚无确认终态，消费退出后保留按 session ID / prompt RPC ID 过滤的终态监听，停止积累输出，执行配额继续占用。后续匹配的 RPC 确认终态释放配额和消费租约；传输 error 或 relay_closed 仅表示消费失败，配额仍等待带运行身份的 Coordinator 停止确认。未发送 prompt 的握手失败或消费退出可立即归还准入。

## 配额与回收

每次 HTTP、Workflow 或定时执行分别申请执行准入，即使复用同一个持久实例也分别计数。scheduled 上限计数执行任务；实例总量和用户实例上限继续计数 runtime 容量。持久创建来源为 api/workflow 的实例在实际启动完成时设置空闲回收资格，等待者已取消也不影响该设置；无活动执行时可回收。执行配额按每次任务来源计数。

## 验证与限制

回归覆盖并发首次建连、单租约释放、在途建连停止、旧刷新与换代交错、握手异常及迟到回执、静默 deadline、执行前及执行中取消、失败与 EOF 分类；真实 Gateway 在物理 relay 未重建、消费者归零和局部编号重用时拒绝旧无 sessionId RPC 结果；真实 PromptTurn 经 Core 租约和 Dispatcher 验证取消、deadline、取消 ack、重复请求与 SDK 失败。取消确认取决于 Agent 的 ACP 实现；未确认终止时保守保留执行准入，不宣称远端执行已停止。
