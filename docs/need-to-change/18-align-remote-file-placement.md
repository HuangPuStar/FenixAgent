# 18. 文件 API 必须消费运行时 Binding，禁止远程失败静默落本地

| 属性 | 结论 |
| --- | --- |
| 优先级 | P1 |
| 置信度 | 高 |
| 影响 | 远程/本地文件分裂、用户错位、对错误 workspace 操作 |

## 对抗判决

remote-file-service 把 `null` 同时当作“本地执行”和“选择了 sandbox 但没有 machine”。后者因此静默走本地 FS。它还总按 environment owner 查询 sandbox，而实例启动按当前用户准备运行环境；组织环境下 B 的 Agent 和文件 API可能指向不同用户/不同机器。

## 已核验证据

- `src/services/remote-file-service.ts:21-28`：sandboxSelected 但 machineId 缺失返回 null。
- `src/services/remote-file-service.ts:80-88`：null 被解释为使用本地文件系统。
- `src/services/remote-file-service.ts:61-77`：sandbox 查询使用 env.userId。
- `src/repositories/environment-orchestration.ts:61-92` 与 `src/services/orchestration-bootstrap.ts:62-85,116-142`：运行实例按当前调用用户准备 sandbox。
- 项目规则明确：配置远程 machine 但 file-ws 未连接时必须报错，不能回退本地。

## 架构诊断

File service 重新推导运行位置，而不是消费 Orchestration 已决定的事实。`null` 这个浅 interface 隐藏了 Local、RemoteConnected、RemoteUnavailable 三种业务状态，调用方无法 fail closed。

## 目标不变量

- 文件操作接收 [3](./3-enforce-tenant-execution-binding.md) 的不可变 Binding，不重新计算 user/machine/workspace。
- 运行位置使用显式判别状态：Local、Remote、Unavailable；Unavailable 永不进入 Local adapter。
- 所有路径继续执行词法校验、realpath/symlink 越界检查和 workspace root 绑定。
- file-ws 断线使该 Binding 的文件能力明确降级/不可用，并与实例状态一致。
- retry/opId 只处理可判定的网络结果，不跨 machine 或 Local/Remote 重放。

## 验收

- 同组织 A/B 运行、远程断线、machine 重绑定、symlink 逃逸和慢操作均有对抗测试。
- 文件 API 与 Agent `pwd`/实际 workspace 的 bindingId 一致；不一致立即拒绝。
- 指标包含 placement mismatch、remote unavailable、fallback attempt（应为 0）、op retry/dedup。

## 回滚

出现远程故障时回滚为“文件能力不可用/重连”，不能恢复本地 fallback，因为后者会写入不同数据面。
