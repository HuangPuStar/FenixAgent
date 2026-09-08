# CE / EE 最小工程架构 Demo

本 demo 只实现“权限 + AgentConfig + run”，但把目标架构的主要边界都做成可阅读的伪代码。CE、EE 是未来两个独立仓库；真实 EE 将 CE 放在 `vendor/fenix-ce` Git submodule 中，并仅通过 `@fenix-ce/*` 包公开入口引用它。

```text
demo/
├── ce/
│   ├── apps/
│   │   ├── server/                       # env、observability、按配置装配 /app route
│   │   └── web/                          # 前端壳；按配置装配已编译的 web contribution
│   ├── packages/
│   │   ├── platform/
│   │   │   ├── platform-sdk/             # ResourceScope、授权/资源/repository 契约
│   │   │   ├── community-access-control/ # CE 身份与授权实现
│   │   │   └── observability/            # Logger、AuditRecorder 端口
│   │   ├── agent/
│   │   │   ├── agent-runtime/            # 引擎静态实现
│   │   │   └── agent-instance/           # 无授权的实例运行管理
│   │   └── resources/
│   │       └── agent-config/
│   │           ├── src/                  # domain/services/repositories/routes
│   │           ├── db/                   # schema 与数据迁移
│   │           └── web/                  # 空页面 contribution
│   ├── db/migrations/                    # CE 统一 DDL 链
│   ├── deploy/                           # assembly profile、env 模板与发布说明
│   ├── scripts/                          # CE DDL/data migration runner 示例
│   └── docs/
└── ee/
    ├── apps/{server,web}/                # EE 按配置静态装配；web 替换空页面
    ├── packages/
    │   ├── platform/enterprise-access-control/
    │   └── resources/enterprise-agent-config/
    │       ├── src/                      # draft/publish 扩展
    │       ├── db/                       # EE 自己的发布表
    │       └── web/                      # EE 发布页面 contribution
    ├── db/migrations/                    # EE 统一 DDL 链
    ├── deploy/
    ├── scripts/
    └── docs/operations/submodule-upgrade.md
```

## 最小业务链路

```text
POST /app/agent-configs/:id/run
  → AgentConfigRunFacade（资源层）
  → AgentConfigFacade.resolveForRun()
      → AccessControlModule：use 授权 + ResourceQueryConstraint
      → EE 额外检查是否已发布
  → AgentInstanceManager（runtime）
  → AgentRuntimeModule
```

runtime 没有 actor、权限、发布状态或 AgentConfig 表依赖。它只接收通用的 `{ agentId, engine }`；资源层将 `agentConfigId` 映射为该参数。

## 资源表拆分

`agent-config` 的内存 repository 故意使用三类存储，模拟目标 DB 模型：

```text
resources                    # ID、type、ownershipScope
agent_config_properties      # name、engine 等领域属性
resource_access_grants       # 显式共享/授权（本 demo 仅声明 schema）
```

资源 CRUD 只用稳定 `resourceId`。`name` 是可变展示属性/搜索条件，不是 route、权限或更新删除的标识。

## CE/EE 三种复用

| 方式 | Demo |
| --- | --- |
| 原样复用 | EE 使用 CE `AgentInstanceManager`、`AgentRuntimeModule` |
| 复用并扩展领域 | EE `EnterpriseAgentConfigFacade` 新增 draft/publish，并覆盖 `resolveForRun()` |
| 整体替换 | EE `EnterpriseAccessControl` 替换 CE 组织角色授权，并产生不同资源查询约束 |

EE 还展示了前端静态替换：`apps/web` 选择 CE 或 EE 资源模块的 `./web` 子路径；没有运行时前端插件。

## 配置驱动的静态装配

`ce/deploy/assembly/ce.json` 与 `ee/deploy/assembly/ee.json` 是装配 profile。它们选择当前镜像已经内置的授权实现、runtime、资源模块与 web contribution；server 和 web 都读取对应 profile，但分别只使用自己所需区段。当前 demo 不装配存储实现；未来出现第二个真实存储实现时，再根据当时的需求设计选择槽位。

```text
assembly JSON/YAML 的模块 ID
  ├─ webShell → 当前版本 apps/web 自己的最终应用壳
  → packages 中的 fenix.module.ts
  → 构建期扫描并生成静态 registry
  → app 从生成 registry 校验、创建与装配
```

配置不能包含 import 路径、URL、npm 包名或可执行代码，因而不能动态下载或加载组件。新增模块提供自己的 `fenix.module.ts` 后，执行 `bun run generate:module-registry` 即可进入静态 registry；app 不需要新增手写注册逻辑。已有模块的合法组合、启停或替换则只改 profile。

生成器只扫描 CE workspace；EE 生成器扫描 EE workspace 和固定版本的 CE submodule。两者最终都生成静态 `import`，因此 server/web 进程启动后不会扫描目录、下载包或热加载模块。

## 跨包引用规则

跨 package 必须使用 package name 和公开 export，例如 `@fenix-ce/agent-instance`、`@fenix-ce/agent-config/web`、`@fenix-ee/agent-config`；禁止跨包相对路径导入 `packages/**/src/**`。相对导入只允许留在同一个 package 内部。

每个 package 的 `package.json` 显式声明 `exports` 与 workspace dependency。demo 的 `tsconfig paths` 仅用于在并排 CE/EE 目录中模拟真实的 CE submodule workspace；真实 EE 将通过 `vendor/fenix-ce` 与包管理器 workspace 解析同一批 package name。

### Web Shell 的版本级替换

`apps/web` 不只是模块页面的装配入口，也拥有本版本的最终应用壳。CE 的 `apps/web/src/shell/community-app-shell.ts` 演示社区首页、布局和导航；EE 的 `apps/web/src/shell/enterprise-app-shell.ts` 演示完整企业壳。二者通过 profile 中的 `webShell` 显式选择。

资源模块的 `packages/resources/<module>/web` 只贡献领域页面、导航项、路由元数据和局部 UI，不能覆盖或反向依赖 Shell。Shell 差异很大时，EE 直接实现自己的完整壳；不需要 fork CE 资源页，也不应把 Shell 放进资源 package。

## env、日志、迁移与部署

- `platform-sdk/server-env`：bootstrap 一次性汇总 profile 启用模块的 env 声明；业务模块不读 `process.env`。
- `platform/observability`：模块依赖日志/审计端口，app 注入 stdout 或生产实现。
- 表定义与数据迁移归 `resources/<module>/db/`；每个仓库的 DDL migration 统一放 `db/migrations/`。
- EE 发布顺序：校验 assembly profile → CE migration journal → EE migration journal → 模块数据迁移 → server/web readiness。
- `ee/docs/operations/submodule-upgrade.md` 展示 CE 固定提交升级步骤。

这是架构伪代码，不包含真实 React、Elysia、Drizzle、Docker 或数据库连接；这些文件仅展示职责和依赖方向。
