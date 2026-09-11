# Platform SDK

跨领域稳定契约包，不包含 CE/EE 具体实现或业务模块。

## 静态装配

- `AssemblyProfile` / `parseAssemblyProfile()` 只接受 access-control、runtime、Web Shell、resource 和 Web contribution 的稳定 ID。schema 为 strict，路径、URL、npm 包名、表达式及其他加载字段均不允许。
- `ModuleManifest` 描述模块类别、装配依赖、独占 capability、env 声明、工厂和贡献。`dependsOn` 只表达装配关系，不能替代 package dependency。
- `createModuleRegistry()` 只消费构建期已经静态 import 的 manifest，负责校验 ID、类别、依赖、capability 和 Web contribution，不扫描或下载模块。
- `bootstrapModules()` 固定执行 registry 校验、env 汇总、preflight、依赖序创建和贡献挂载。模块和宿主在获得资源后立即登记 cleanup；装配失败和返回结果的幂等 `dispose()` 都会按逆序释放。具体 env loader、数据库检查和 Elysia 挂载由宿主注入。

新增可装配 package 时，在包根创建 `fenix.module.ts` 并公开 `./module` export，然后运行：

```bash
bun run generate:module-registry
```

生成的 `apps/generated/module-registry.ts` 必须随 manifest 一起提交，禁止手改。`bun run precheck` 会执行生成器 `--check`，产物缺失或陈旧时失败。

当前 FND-03 只建立装配基础设施。CE access-control 的工厂由 PLT-01 实现，runtime/resource manifest 分别由后续 Agent 和资源任务加入；缺少基础模块工厂时 registry 会拒绝启动。旧服务入口在对应垂直切片完成前不切换到新 bootstrap。
