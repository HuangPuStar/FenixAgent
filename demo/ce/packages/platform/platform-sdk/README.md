# @fenix-ce/platform-sdk

跨领域的平台契约包，不包含具体业务实现。

包含：认证主体、`ResourceScope`、`ResourceAccess`、`ResourceScopeStore`、`AccessControlModule`、`ResourceQueryConstraint`、泛型 `AuthorizedResourceFacade`、资源 repository 端口、资源模块声明，以及 `ModuleManifest` / `createModuleRegistry` 装配契约。构建脚本据此收集各包的 `fenix.module.ts`，产出静态 registry；SDK 不负责扫描文件。

`./assembly` 是 CE、EE 共用的公开子路径，导出 `AssemblyProfile` 与 `parseAssemblyProfile()`。它只校验 profile 的通用结构；具体模块 ID、依赖和版本规则由各自 app 使用生成 registry 校验。

模块通过 `ModuleManifest.envDefinitions` 声明部署配置；`./server-env` 提供 server host 配置与统一读取器。bootstrap 汇总已启用模块的声明并注入结果，模块不读取 `process.env`。

允许依赖：无业务包依赖。

禁止放入：CE 组织角色实现、EE 工作空间规则、Drizzle 查询、AgentConfig 或其他资源 DTO。具体身份授权实现属于 CE/EE 自己的 platform 包，资源 DTO 与领域规则属于对应 resources 包。
