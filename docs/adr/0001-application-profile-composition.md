# 使用代码级 Profile 组装服务端应用

> 状态：提议中；日期：2026-09-04；接受条件：详细设计通过评审、实现与本文一致且通过 Linux CI

## 与详细设计的关系

本 ADR 只记录需要长期遵守的架构选择、理由和后果。完整接口、生命周期时序、兼容矩阵、验证方法和后续路线由 `docs/design/2026-09-04-app-builder-design.md` 维护；设计仍在评审或实现尚未验证时，本 ADR 保持“提议中”，不能用 ADR 的存在表示方案已经接受。

实现完成后的真实结构由 `docs/arch/24-application-bootstrap.md` 描述。详细设计回答“准备怎样实现”，ADR 回答“为何长期采用这些约束”，当前态架构文档回答“代码现在如何运行”。

## 背景

FenixAgent 的服务入口原本同时拥有配置、初始化、全部 Elysia routes、listen、signal 和资源释放。模块顺序依赖代码位置，新增长期资源必须手工同步 shutdown，应用也无法在不启动真实服务的情况下完整构造。

未来可能存在社区版之外的定制装配，但当前需求首先是改善社区应用自身的可测试性、资源所有权和入口维护成本。

## 决策

- 使用 `@fenix/server-runtime` 提供与 Fenix 业务无关的 `ApplicationBuilder` 和 `ApplicationRuntime`。
- 服务端组合单元命名为 `ServerModule`，通过 `createRoutes()` 构造可被 Elysia `.use(instance)` 合并的 routes，并通过 `start()` 返回成功启动后的 `ModuleDisposer`。
- `ApplicationProfile` 是静态 TypeScript fluent 配置，通过 `.use(module)` 显式声明 route 和启动顺序。
- Runtime 在首个启动错误处停止，不启动后续 Module；仅 best-effort 释放此前成功 Module，不回滚持久化事实或失败 Module 的部分状态。
- 正常停止先调用 Elysia `app.stop()`，再逆序调用成功 Module 的 disposer。
- edition-specific 依赖通过 Module factory 的类型化参数和闭包注入，不提供能力 token registry、通用 DI 容器或 Service Locator。
- App Builder 只组合已经确定的边界，不负责发现、评价或强制业务模块边界。
- 首期默认社区 Profile 通过一个明确的过渡性 Module 接入现有完整 route 聚合和启动链，不为证明 Builder 而拆分 Channels、Agent Sites 或其他生产能力。
- 组合、省略、类型累积和生命周期所有权由 package 内的可执行源码示例及其测试验证；生产模块化按真实领域职责、依赖和消费者需求独立推进。
- 默认社区 Profile 始终包含全部社区能力，不增加环境变量模块开关。

## 为什么使用 fluent `.use(module)`

Profile 的运行时装配按顺序逐个调用 `.use(instance)`；静态类型则惰性累积 Module 的 Eden route tree，并使用 Elysia 的前缀类型变换，避免在每一步重复展开完整应用类型。

真实默认 route tree 若通过 Elysia 的 `.use(instances)` tuple overload 一次性展开，会触发 TypeScript 深度上限。因此 Profile 使用静态 fluent 链；大型过渡 Module 可从同一有序 route tuple 推导静态 route tree，并在运行时逐项挂载，但不把该 tuple 传给 `.use()`。Profile 不是运行期数组，也不支持热切换。

## 为什么不使用 Elysia plugin 命名

当前契约返回的是 Elysia 实例，对应 `.use(instance)` overload，而不是 plugin function。`ServerModule.createRoutes()` 更准确地表达其职责，也与仓库已有 route factory 命名一致。

## 与业务模块化的关系

App Builder 解决“装配单元如何组合和管理生命周期”，业务模块化解决“哪些 routes、用例、数据与资源应共同演进”。两者相关但不强绑定：Builder 为未来边界提供挂载点，却不能把容易移动的 route 变成合理领域边界。

因此，首期接受默认 Profile 粒度较粗。后续持续改进应先分析候选能力的职责、调用依赖、认证授权、数据边界、后台资源和独立省略或替换需求，再以垂直切片提取真实 Module；不得把移除若干能力后的剩余集合命名为 `platform` 或 `core` 并视为已确认边界。这一演进由独立设计和 PR 推进，不属于接受 App Builder 决策的前置条件。

## 后果

正向后果：

- 应用构造与进程启动分离；
- route 顺序和生命周期顺序在 Profile 中可见；
- 已成功分配的进程资源有统一释放出口；
- 默认 `App` 类型保持完整；
- Module 可以按源码配置整体增减。

限制与成本：

- 当前真实 Fenix 服务仍依赖多个进程级 singleton，不支持同进程多 Runtime；
- 失败 Module 的部分状态不由 Runtime 清理，社区入口会快速非零退出；
- 数据迁移等持久化步骤依赖幂等和下次启动收敛；
- 自定义 Profile 需要重新编译和重启进程；
- 首期默认社区 Profile 只有一个粗粒度生产 Module，尚不支持按业务能力细粒度裁剪；
- 完整 drain、readiness 和前端 capability 仍需独立设计。

## 被拒绝的方案

- **运行期插件发现或热插拔**：需要路由排空、状态迁移和安全加载，超出真实需求。
- **环境变量模块列表**：把错误延迟到部署期，并削弱 route 类型。
- **能力 provider registry**：不能消除大模块内部耦合，容易演变成 Service Locator。
- **同名或 route 覆盖**：行为依赖注册顺序，可能绕过认证与权限边界。
- **为验证机制先拆 Channels 与 Agent Sites**：迁移难度低和示例互补性只能证明技术可行，不能证明领域内聚；还会制造一个按排除法形成的剩余模块。
- **一次性 tuple 合并**：真实默认路由树触发 TypeScript 深度上限。

## 相关文档

- `docs/design/2026-09-04-app-builder-design.md`
- `docs/arch/24-application-bootstrap.md`
- `docs/need-to-change/22-deepen-backend-application-modules.md`
- `docs/need-to-change/42-make-process-shutdown-a-drain-protocol.md`
