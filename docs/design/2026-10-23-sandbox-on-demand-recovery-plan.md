# 沙盒按需恢复实现计划

> **面向 AI 代理的工作者：** 使用 executing-plans 内联执行；按下列复选框记录进度。

**目标：** 用户再次进入失联沙盒时，在主服务恢复沙盒并启动原 Instance，避免永久阻塞于 `unknown`。

**架构：** Instance service 在 ensure 前读取受限的断连恢复上下文，调用 Sandbox 的公开恢复入口。Sandbox 合并同一资源的恢复，复用 Provider 与数据库行锁；确定旧实体终止后收敛 Runtime，连接真正就绪后重新进行生命周期仲裁。

**技术栈：** Bun、TypeScript、Drizzle、PostgreSQL、现有 ACP Machine 注册协议。

**规格：** [按需恢复设计](./2026-10-23-sandbox-on-demand-recovery.md)。用户于 2026-10-23 确认继续实施。

## 执行约束

- 当前分支 `fix/chat-new-session-target`，开始前仅设计文档未提交；本次内联执行，不改分支、不创建 commit。
- 只处理按需恢复，不增加断连状态投影、定时器、数据库结构或前端重连机制。
- 基线：coordinator、机器恢复、sandbox manager recovery、execution handler 共 39 项通过。
- 每个任务先运行失败测试，再实现并重跑；所有 `test` 补中文行为注释，不使用 `mock.module()`。
- 文件上限 500 行；manager 和 coordinator 接近上限，新增沙盒恢复编排放在 execution handler 邻近的小文件。

## 任务 1：断连恢复上下文与 Instance 服务闭环

文件：`packages/agent-runtime/src/server/services/agent-instance-runtime-coordinator.ts`、`agent-instance-service.ts`；测试新增 `packages/agent-runtime/src/server/__tests__/agent-instance-sandbox-recovery.test.ts`。

- [x] 编写失败测试：真实 coordinator 启动、断连，注入恢复回调发出确定终止通知，第二次 `service.ensureInstanceRuntime(instance)` 应再次启动同一 ID。

```ts
await service.ensureInstanceRuntime(instance);
coordinator.handleRuntimeDisconnect(instance.id, coordinator.snapshot(instance.id).runtimeGeneration, machineId);
await service.ensureInstanceRuntime(instance);
expect(starts).toBe(2);
expect(coordinator.snapshot(instance.id).state).toBe("running");
```

- [x] 运行 `bun test packages/agent-runtime/src/server/__tests__/agent-instance-sandbox-recovery.test.ts`，预期现有实现因 `unknown` 失败。
- [x] Coordinator 提供异步只读恢复上下文：等待在飞操作收尾，排除停止、删除、shutdown 和非断连来源 unknown；上下文包含 Machine ID 和验证当前恢复意图的谓词。
- [x] Instance service 增加可注入的恢复函数，生产绑定 Sandbox 公开入口；恢复结束仍调用原 `ensureRuntime`，不自行写停止或运行状态。
- [x] 覆盖正常 ensure 不调用恢复、停止/删除优先、另一 Machine 与非断连 unknown 不放行、等待者取消、旧上下文失效。

## 任务 2：严格 ACP 就绪判定

文件：`packages/agent-runtime/src/server/transport/acp-ws-handler.ts`、`packages/resources/machine/src/server/host-port.ts`、`services/machine-runtime.ts`、Machine 公开出口和 `apps/server/src/bootstrap/host-wiring.ts`；对应 Machine 和宿主接线测试。

- [x] 先测试 socket 存在但未 clean-slate / transport 激活时不可就绪，完整激活后才就绪，断连后再次不可就绪。
- [x] 运行相关新增测试，预期缺少严格就绪能力失败。
- [x] 在连接 owner 提供布尔就绪能力，经现有 MachineHostPort 注入，Machine 对外提供 `isMachineRuntimeReady(machineId)`；不改变数据库 `isMachineOnline()`。
- [x] Sandbox 的复用与等待都改用严格能力，注入式用例继续使用自己的状态读取器。
- [x] 重跑 Machine、ACP 注册/clean-slate、宿主接线及 sandbox 连接等待测试。

## 任务 3：单轮沙盒恢复与并发合并

文件：`packages/resources/sandbox/src/server/services/sandbox-execution-handler.ts`、邻近 `sandbox-runtime-recovery.ts`、`sandbox-manager.ts`、`sandbox-remote-reconciler.ts`、必要的 repository 原语与公开出口；测试新增 `packages/resources/sandbox/src/__tests__/sandbox-on-demand-recovery.test.ts`。

- [x] 编写以下失败行为：同一 Machine 的并发进入只恢复一次；停止资源 resume；假健康等待超时后只重建一次；Provider 超时不销毁；其他用户不可触发恢复。

```ts
await Promise.all([handler.recoverDisconnectedMachine(input), handler.recoverDisconnectedMachine(input)]);
expect(providerDestroyCount).toBe(1);
expect(providerCreateCount).toBe(1);
```

- [x] 运行新增测试确认失败。
- [x] 新入口按 Machine 查询自己的沙盒记录并校验属主；普通 Machine 返回未处理，不创建新业务记录。
- [x] 按沙盒 ID 合并恢复 Promise；普通 prepare 与断连恢复共用等待流程，单请求取消只结束自身等待。
- [x] 原资源恢复和重建各最多一次；Provider 请求错误保留原始错误，只有连接超时和明确资源终态进入重建。
- [x] 在锁内复查外部资源 ID、状态和连接；超时请求不得销毁后来创建的资源，ACP 等待必须在事务外。
- [x] 销毁成功/明确不存在后先调用既有 Machine 释放入口，再创建；创建失败仍保留已确认终止事实。修正失败写入随事务回滚的问题，保留原始异常。
- [x] 对有限的新增 Manager 委托控制行数，将整轮恢复放在小文件内；不增加通用框架。
- [x] 覆盖手动停止/删除期间旧意图作废、旧事件迟到、失败 Promise 释放、跨请求资源版本变化，以及创建失败后的再进入。

## 任务 4：完整链路与文档门禁

文件：任务 1/3 的测试、`docs/arch/19-sandbox.md`、`docs/arch/22-agent-instance-management.md` 和本计划。

- [x] 真实 Instance service + coordinator + Sandbox handler + 内存 Provider/仓储组合验证「断连后再进入」；确认 Instance ID 不变，配额与旧 runtime 收敛。
- [x] 验证普通 Machine、正常启动、Chat/API/Workflow 共用 ensure 的回归，保持入口选择与权限规则。
- [x] 同步架构文档的稳定恢复契约、按需触发边界及无后台对账的限制。
- [x] 运行局部相关测试、`bun run fastcheck`、`bun run precheck`、`bun run docs:build`；逐项记录退出码和阻塞原因。
- [x] 对最终 diff 做独立代码审查，处理正确性问题；不提交、不合并、不部署。

## 审查重点

1. 恢复发生在 ensure 操作占槽之前，不能与 clean-slate 延迟确认互相等待。
2. 旧 Provider 资源终止事实与新资源创建成功必须区分；不能清理新连接或释放新代次配额。
3. 断连只表示未知，不能因 Provider 网络错误复位 runtime 或重复运行 Agent。
4. 跨请求共享恢复的取消、失败与清理必须对称；旧超时不能覆写新资源。
5. 停止、删除、重启、服务关闭与跨用户隔离保持现有约束。

## 执行记录

- 2026-10-23：规格获批；39 项相关基线测试通过。未创建 Git commit。

- 2026-10-23：断连恢复、取消与真实服务组合新增 23 项回归通过；相关基线与沙盒资源回归通过；`fastcheck` 全绿（49.9s），文档构建通过（15.2s），最终独立审查无发现。`precheck` 最终通过：12,975 pass / 2 skip / 0 fail（223s），无 commit。
