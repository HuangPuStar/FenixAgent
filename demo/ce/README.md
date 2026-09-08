# Fenix CE（Demo）

开源版仓库示例。它只包含通用平台契约、基础资源模块和可静态替换的运行时能力，不包含商业发布、企业身份模型或客户定制代码。

每个可装配包在根目录提供 `fenix.module.ts`。`bun run generate:module-registry` 在构建期扫描这些 manifest，生成 `apps/generated/module-registry.ts`；app 从生成物取模块，不维护手写包注册表。

CE 的 `platform-sdk/assembly` 提供 CE、EE 共用的 `AssemblyProfile` 解析契约；CE 只加载自己的 profile，EE 从 submodule 复用同一契约后加载自己的 profile，不复制解析逻辑。

CE app 与 package 的跨边界导入统一使用 `@fenix-ce/*` 公开入口；不通过相对路径穿透其他 package 的 `src/`。

`deploy/assembly/ce.json` 选择当前镜像已构建的授权、runtime、资源、版本级 `webShell` 与 web 模块。`apps/server` 统一加载 env、注入观测能力并按该配置装配 `/app` route；`apps/web` 使用自己的 CE Shell，并从同一配置读取 web 区段装配资源模块的 `./web` 页面 contribution。配置只能选择生成 registry 中的模块 ID，不能加载任意路径或远程代码。

资源模块各自维护 schema、数据迁移和 web 页面，CE 根 `db/migrations` 维护统一 DDL 链。

真实 EE 仓库以 Git submodule 引用本仓库的确定提交，再以包公开入口复用能力。
