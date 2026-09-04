# 应用装配与进程生命周期

> 当前实现基线：2026-09-04

## 职责分层

```text
src/index.ts
  → 校验并应用环境配置
  → 创建社区默认应用
  → start/listen
  → 安装 SIGINT/SIGTERM

src/application/
  → 社区 base app
  → community default Profile
  → community ServerModules

@fenix/server-runtime
  → ApplicationBuilder
  → ApplicationRuntime
  → ServerModule 生命周期契约
```

`@fenix/server-runtime` 只依赖 Elysia，不读取环境变量、工作目录或 Fenix 业务模块。社区认证、配置、数据库和 routes 只存在于 `src/application/` 的默认装配中。

## 社区默认 Profile

```ts
builder.use(legacyCommunityModule);
```

| Module | Routes | 启动资源 |
| --- | --- | --- |
| `legacy-community` | 完整既有 `/web`、`/api`、ACP、MCP、skills、Agent Sites 与 Workflow proxy | DB、Core Runtime、Scheduler、Sandbox、Model Gateway、Hermes 和巡检任务 |

`legacy-community` 是现有社区应用接入 Runtime 的过渡性整体边界，不表示这些能力属于同一领域。`src/routes/web/index.ts` 继续保持完整聚合，Agent Sites compat route 继续位于整个业务 route tree 的最后。生产业务模块的细粒度提取按独立领域分析持续推进，不属于 App Builder 首期成果。

## 构造与启动

`ApplicationBuilder.create()` 接收纯 `createBaseApp()`，随后通过 fluent `.use(module)` 累积 Module。`.use()` 只记录延迟 routes factory，`build()` 才构造 Elysia 实例并返回 `ApplicationRuntime`。

构造阶段不得：

- 连接 DB 或外部服务；
- 创建 timer、socket 或子进程；
- listen；
- 注册 process signal。

`ApplicationRuntime.start()` 按 Profile 顺序调用 Module `start()`。成功 Module 若留下进程级易失资源，必须返回一个覆盖其全部资源的 disposer；所有 Module 成功后才调用 Elysia `listen()`。

## 启动失败

```text
Module A 成功并返回 disposer
→ Module B 失败
→ Module C 不启动
→ best-effort 调用 A disposer
→ 保留 B 原始错误
→ 社区入口非零退出
```

Runtime 不回滚数据迁移、system admin、默认 Pool 等持久化事实，也不管理失败 Module 的部分启动状态。持久化步骤必须幂等；失败后由下一次进程启动继续收敛。

## 正常停止

```text
app.stop()
→ abort lifecycle signal
→ 按 Module 逆序执行 disposer
→ 每个 Module 内部按依赖顺序释放资源
```

重复或并发 `stop()` 共享同一 Promise，disposer 只执行一次。单个 disposer 失败不能阻断其余 Module 释放；最终错误保留失败 Module 名称。

`legacy-community` disposer 当前负责：

1. 停止 Hermes；
2. 停止 ACP idle、machine 和 file-ws sweeps；
3. 停止 Scheduler 创建未来任务；
4. 关闭 relay、ACP 和 file-ws connections；
5. 停止 Agent instances；
6. 关闭 Cache/Redis；
7. 关闭 PostgreSQL Pool。

完整的在途任务取消、Y.Doc/file batch flush、deadline 和 readiness 不属于当前 Runtime 保证，继续按 drain/readiness 专项设计推进。

## 类型边界

Builder 保留具体 Elysia app，并在每次 `.use(module)` 后惰性累积 Module 的 Eden `~Routes`；非空 base prefix 通过 Elysia 的 `CreateEden` 映射到最终 route tree。默认 `App` 从社区 Profile 的实际 builder 链推导，自定义 Profile 只拥有实际挂载 routes 的类型。

`legacy-community` 使用一个有序 route tuple 同时定义运行时注册顺序和静态 route tree。运行时循环该 tuple 并逐个调用 `.use(instance)`，不调用 Elysia 的 `.use(tuple)` overload；静态类型从同一 tuple 的 `~Routes` 推导并规范化，以避免 TypeScript 再次递归展开完整社区路由树。

`packages/server-runtime/src/examples/profile-composition.ts` 以 `public-example` 和 `internal-example` 展示两个不同 Profile，并由 package 测试验证不同 route 类型与生命周期。它是可执行源码示例，不是第二个社区进程入口。

## 安全边界

- Module 列表是受信源码配置，不由请求、租户配置或浏览器控制。
- 社区 base app 继续提供 better-auth 和现有全局错误/日志边界。
- 禁止同名 Module 和隐式 route override。
- Server Runtime 不提供 service registry；Module 依赖通过工厂参数显式注入。
- Module 内部仍必须执行原有认证、授权和多租户隔离。

## 已知限制

- 真实社区服务包含进程级 singleton，只支持一进程一个默认 Runtime。
- 默认社区 Profile 目前只有一个过渡性生产 Module，尚不能按 Channels、Agent Sites 等业务能力细粒度裁剪。
- 自定义 Profile 需要重新编译和重启。
- 前端尚不会根据后端 Profile 自动调整导航与路由。

长期 edition/submodule 背景与演进门槛见 `docs/design/2026-09-04-app-builder-design.md`。
