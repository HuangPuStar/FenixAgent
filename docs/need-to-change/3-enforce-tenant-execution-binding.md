# 3. 用不可变 Execution Binding 统一租户、实例和 workspace

| 属性 | 结论 |
| --- | --- |
| 优先级 | P0 |
| 置信度 | 高 |
| 影响 | 用户 B 的 Agent 在用户 A workspace 执行、文件/运行位置分裂 |

## 对抗判决

项目权威路径规定 workspace 为 `{organizationId}/{userId}/{environmentId}`，但实例复用键只有 environment/instanceNumber。组织环境由用户 A 首次启动后，用户 B 会复用同一运行实例；远程 runtime 把 workspace 固定在启动时，后续请求中为 B 计算出的 cwd 又被 Dispatcher 忽略。于是身份解析、实例调度和文件定位对“这次执行属于谁”给出不同答案。

## 已核验证据

- `src/services/instance.ts:381-447`：复用运行实例时未把 userId 纳入身份。
- `packages/chat-channel/src/channel/gateway.ts:113-115`：Chat 按当前用户计算 workspace。
- `packages/acp-link/src/client/instance-manager.ts:87-113,177-181`：远程实例启动时固化 workspace。
- `packages/acp-link/src/acp-dispatcher.ts:90-97,399-486`：Dispatcher 固定构造时 workspace，忽略请求 cwd。
- `src/routes/acp/index.ts:267-272` 与 `src/services/chat-channel-bootstrap.ts:101-115`：组织成员可进入组织环境。
- `src/services/remote-file-service.ts:61-88`：文件服务又独立推导 machine/user，并允许 null 落到本地。

## 架构诊断

organization、user、environment、machine、workspace 不是五个可独立重算的字段，而是一次执行的不可分割身份。目前它们跨 route、Chat、orchestration、runtime 和 file service 重复推导，形成多个可漂移 seam。

## 目标不变量

- 实例创建前产生不可变 Execution Binding，至少固定组织、用户/共享主体、环境、实例、machine 和 workspace。
- 复用只能发生在 Binding 等价时；若产品要组织共享 workspace，应显式建模共享主体并修改领域规则，不能借由遗漏 userId 实现。
- ACP session/new/load/prompt、Workflow、Chat 和 File API 都引用同一 Binding，不再各自算 cwd/machine。
- runtime 必须验证收到的逻辑 channel 与 Binding 一致；任何不一致 fail closed。

## 分阶段整改

1. 先写同组织 A/B 反例测试，记录实际 cwd 与文件根。
2. 把 Binding 作为实例创建结果持久化/可观测，并在复用前比较。
3. 文件服务改为消费 Binding；远程不可用返回显式错误，不回退本地。
4. 删除 Dispatcher 的全局 workspace/session 隐式状态和散落的 `resolveWorkspacePath` 调用。

## 验收与观测

- A/B 进入同一组织环境时，要么得到各自实例和 workspace，要么明确进入产品定义的共享主体；不可时序决定。
- 日志包含 bindingId 与各资源 ID，不输出真实敏感路径；发现不一致立即拒绝并计数。
- 迁移前对存量 running instance 做 drain，不热改其 Binding。

## 非目标

本整改不替产品决定“环境应当用户私有还是组织共享”；它要求这个决定进入领域模型、复用键、授权和存储，而不是由首个启动者偶然决定。
