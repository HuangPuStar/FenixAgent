# Fenix EE（Demo）

商业版仓库示例。真实仓库将 CE 固定为 Git submodule，并通过 CE 包的公开入口复用运行时和资源基础能力。

本 demo 的扩展方式：

- 用 `EnterpriseAccessControl` 整体替换 CE 身份授权模型；
- 用 `EnterpriseAgentConfigFacade` 复用 CE AgentConfig CRUD，并增加发布流程；
- 原样复用 CE runtime；当前不创建 EE runtime 副本；
- 用 `deploy/assembly/ee.json` 选择已构建的授权、runtime、资源、企业 `webShell` 与 web 模块；
- 在 `apps/web` 使用 EE 自己的完整 Shell，并按配置选择 EE 资源模块的 `./web` 页面 contribution；
- 维护独立 EE DDL migration 链，发布时在 CE 链之后执行。

模块由 manifest 声明、配置选择：EE 从 CE submodule 的 `platform-sdk/assembly` 复用 `AssemblyProfile` parser，自己只加载 `ee.json` 并针对生成 registry 校验企业模块规则。`bun run generate:module-registry` 在构建期扫描 EE packages 与固定 CE submodule 的 `fenix.module.ts`，生成静态 registry；profile 不能填写任意路径、URL 或包名，也不会动态加载代码。合法的既有模块组合只需改 `deploy/assembly/ee.json`；新模块提供 manifest 后不需修改 app 注册逻辑，但仍必须通过迁移/依赖校验。完整目录与扩展方式总表见上级 [`demo/README.md`](../README.md)。

EE 对 CE 的所有跨仓库引用都使用 `@fenix-ce/*` 的公开 export；不使用指向 CE submodule 内部 `src/` 的相对路径。demo 的 `tsconfig paths` 只模拟真实 workspace 的包解析。
