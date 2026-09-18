# Platform SDK

跨领域稳定契约包，不包含 CE/EE 具体实现或业务模块。

## 静态装配

- `AssemblyProfile` / `parseAssemblyProfile()` 只接受 identity、access-control、Agent Runtime、Web Shell、resource 和 Web contribution 的稳定 ID。schema 为 strict，路径、URL、npm 包名、表达式及其他加载字段均不允许。
- `ModuleKind` 为 `access-control` | `agent-runtime` | `identity` | `resource` | `web-shell`。`web-shell` 的 manifest 位于应用根目录（`apps/web/fenix.module.ts`）且必须是纯元数据——只允许 `import type`，不得有值导入与 `export ... from`，否则服务端 registry 的静态导入图会被拖进浏览器代码。
- `resolveProfile()` 校验 `webShell` 指向已注册的 `web-shell` 模块，但不把它放进 `modules` / `instances`：Shell 由 `apps/web` 自行消费，server 不实例化它。`identity` 在 `packages/platform/identity` 落地前可选。
- `ModuleManifest` 描述模块类别、装配依赖、独占 capability、env 声明、工厂和贡献。`dependsOn` 只表达装配关系，不能替代 package dependency；生成器会断言每个 `dependsOn` ID 所属包出现在本包 `package.json` 的 `dependencies` 中。
- `createModuleRegistry()` 只消费构建期已经静态 import 的 manifest，负责校验 ID、类别、依赖、capability 和 Web contribution，不扫描或下载模块。
- `bootstrapModules()` 固定执行 registry 校验、env 汇总、preflight、依赖序创建和贡献挂载。模块和宿主在获得资源后立即登记 cleanup；装配失败和返回结果的幂等 `dispose()` 都会按逆序释放。具体 env loader、数据库检查和 Elysia 挂载由宿主注入。

新增可装配 package 时，在包根创建 `fenix.module.ts` 并公开 `./module` export，然后运行：

```bash
bun run generate:module-registry
```

生成的 `apps/generated/module-registry.ts` 必须随 manifest 一起提交，禁止手改。`bun run precheck` 会执行生成器 `--check`，产物缺失或陈旧时失败。

## `@fenix/platform-sdk/server`

应用基础设施的受限读取入口。宿主在启动时调用 `initializeApplicationInfrastructure({ database, moduleConfigs })`，包侧只经 `getDatabase()` / `getModuleConfig(moduleId)` 读取，不持 `apps/server` 内部路径。

- 重复 `initializeApplicationInfrastructure` 直接抛错：进程内不允许两个 DB client 静默共存。
- 未初始化、或读取未声明的 moduleId 时抛错，不做隐式默认值回退。
- 不 import drizzle、不读 `process.env`、不建连接池、无领域逻辑。
- `resetApplicationInfrastructure()` 与 `overrideModuleConfig()` 仅用于测试；override 只改内存中的配置，不写回 `process.env`。

## 授权查询契约

`AccessControlModule.createListConstraint()` 返回 `Promise<ResourceQueryConstraint>`。异步是权威设计（见 `ce-access-control-design.md`）的要求：约束可能需要进行 DB 查询才能确定，调用方必须先 `await` 再构造查询入参。实现方不得为省一次 `await` 退回同步签名。

## 当前状态

静态装配基础设施已可用，模块清单仍在补齐：`deploy/assembly/ce.json` 目前能解析，但 identity 模块、web contribution 消费（1.6）与 preflight 的真实实现（1.7）尚未交付。在目标组合完整并通过 bootstrap smoke test 前，应用继续使用现有服务入口，`packages/platform/platform-sdk/src/server.ts` 也尚未被 `apps/server` 消费。
