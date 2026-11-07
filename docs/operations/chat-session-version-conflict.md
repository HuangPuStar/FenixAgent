# 聊天重连后持续版本冲突的诊断与修复

## 核查结论

基线为 main `7fda46aed`，仍能复现持续 `ACTION.VERSION_CONFLICT`，但原报告的 D1/D2/D3 不能解释当前 main：

1. `useAcpSessionBootstrap` 已在 load/resume 成功写入 socket 后才标记进入。
2. 能力位属于 `handleSelectSession` 的依赖，该回调又是恢复 effect 的依赖；能力迟到会重试。
3. 会话列表变化会触发恢复；真实 `readSessions` 派生还会补齐当前会话，不能用手造的“不一致列表”证明线上根因。

## 可稳定复现的剩余根因

1. 前端发送 load/resume，服务端成功确认会话；committed Ack 在断线边界丢失。
2. 前端按动作内容缓存完整 commandId，断线后仍保留该恢复命令 ID。
3. 旧频道被释放，新连接的绑定未确认。自动恢复复用旧 ID，命令协调器命中旧结果，仅返回 duplicate，不调用 `SessionRestoration.prepareLoad`。
4. 前端认为恢复命令已写入 socket，标记已进入；服务端新绑定却仍未确认，之后每条新 prompt 都触发 `VERSION_CONFLICT`。

该路径不需要 epoch 变化。若期间服务重启或旧结果被回收，旧 ID 也可能先得到 `OUTCOME_UNKNOWN`，同样无法确认新绑定。现有生产日志没有完整命令与回执关联，不能断言该路径就是报告中那一次故障的唯一原因。

## 修复方案与边界

将 load/resume 的缓存身份限定于当前动作连接，断线时只释放这两类恢复命令的身份。重连后生成新的恢复意图，服务端执行原有绑定确认流程。

恢复同一会话时，运行身份、连续性、用户、实例和内存投影均匹配才允许复用确认凭据；否则仍请求 Agent 并等待回执。在途旧执行器仍受命令队列 predecessor 屏障约束。重复的 load/resume 是对新连接的状态协调，不创建会话或提交用户输入。

未知 prompt、create、权限响应等副作用动作继续保留原完整 ID；不能清空全部命令缓存，也不放宽服务端会话守卫，不在错误处理里自动重发用户消息。

## 回归与发布

回归使用真实前端 runtime、传输自动重连和 SessionChannel：覆盖 load/resume 已提交但 Ack 丢失、同 epoch 重连、服务重启换 epoch、恢复后 prompt 成功、同运行凭据复用不重复 Agent 加载，以及未知 prompt 身份保留。另覆盖在途加载尚未退场时的新恢复排队。

无数据库或外部 API 变更；前后端照常部署，回滚代码即可。观察重连后的恢复命令与 `VERSION_CONFLICT` 频率；真实过期目标或并发切换仍应被守卫拒绝。
