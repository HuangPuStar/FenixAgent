# 10. 本地 ACP WebSocket 必须有真实认证和进程所有权

| 属性 | 结论 |
| --- | --- |
| 优先级 | P0 |
| 置信度 | 高 |
| 影响 | 同主机进程控制 Agent、访问 workspace/工具、劫持会话 |

## 对抗判决

本地 acp-link WebSocket 没有 token 配置和 upgrade 校验；opencode/ccb process manager 返回空 token，客户端实际连接 `?token=`。绑定 loopback 只能限制远程网络，不能认证同一容器/主机上的进程。

## 已核验证据

- `packages/acp-link/src/server.ts:59-79`：ServerConfig 没有 relay credential。
- `packages/acp-link/src/server.ts:1455-1472`：WebSocket open 不校验 token。
- `packages/plugin-opencode/src/process/acp-link-process-manager.ts:45-70`：启动结果 token 为空。
- `packages/plugin-ccb/src/process/acp-link-process-manager.ts:57-81`：同样为空。
- `packages/plugin-opencode/src/relay/relay-handle.ts:60-68`：连接 URL 明确携带空 token。
- `Dockerfile:52-90`：运行容器内有多个 CLI/插件/用户工作负载，loopback 并非单进程边界。

## 架构诊断

ProcessManager 同时负责启动、发现端口和提供 token，但 token interface 是占位值，server 又没有对应 verifier。生命周期的两端没有共享同一个安全不变量。

## 目标不变量

- 每次进程启动生成高熵、短生命周期、实例绑定的 relay credential；只通过受控启动通道交付。
- upgrade/open 前进行常量时间校验；缺失、错误、过期或实例不匹配立即关闭，不进入 handler。
- token 不进入 argv、URL 日志、stdout 业务日志或持久化配置；必要时使用 header/首帧握手并限制重放。
- ProcessManager 拥有子进程和 credential；Relay Broker 拥有连接；业务消费者都不能 kill/close 底层资源。
- 启动失败、端口占用、进程退出、credential 轮换和 shutdown 有明确终态。

## 验收

- 无 token、空 token、另一实例 token、重放旧 token均拒绝。
- 日志和进程列表扫描找不到 credential；错误响应不泄露期望值。
- 合法连接断开不自动等价于杀 Agent，实例生命周期按 [2](./2-introduce-instance-relay-broker.md) 统一决策。
- 建立失败/拒绝/轮换指标和异常连接速率告警。

## 非目标

这不是要把本地 relay 暴露公网；即使永远 loopback，最小权限和同主机攻击面仍要求认证。
