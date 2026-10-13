# CE / EE 工程目录结构与归属说明

> 本文仅描述目标**物理目录**及文件 owner；现有接口、权限、数据和业务行为的架构约束由[目标架构与开发规范](./ce-ee-engineering-standards.md)定义。

## 1. 仓库与目录归属

两个仓库采用相同的目标骨架。以下只描述目录和归属，不规定从当前仓库迁到这些目录的任务、顺序或实现动作。

```text
fenix/ 或 fenix-ee/
├── apps/
│   ├── server/                         # HTTP、WebSocket、启动装配、进程生命周期
│   └── web/                            # 控制台壳、TanStack Router 最终装配
├── packages/
│   ├── platform/                       # 平台契约，以及成套替换的身份、租户和授权实现
│   │   ├── platform-sdk/               # Context、授权端口、资源端口、模块描述符、应用基础设施契约；无 DB/Web
│   │   ├── identity/                   # 用户、组织、成员、认证/API Key；包含 DB、route 与 Web
│   │   └── access-control/             # 默认授权实现；依赖同版本 identity 的公开入口
│   ├── agent-runtime/                  # @fenix/agent-runtime：统一组合原 src 中的 Agent 运行编排
│   ├── <other 1>/                      # 独立 SDK、插件等包，如 acp-link、core、plugins；服务模块直接包引用，只要求包间依赖无环
│   ├── <other 2>/
│   ├── <other n>/
│   ├── resources/                      # 完整资源领域模块（后端、DB、web contribution）
│   │   ├── agent-config/               # 默认实现；EE 仓库以同路径扩展发布/审批
│   │   └── <resource>/
├── db/
│   └── data-migration-runner.ts         # 仅负责汇总、排序、记录和执行模块迁移
├── drizzle/                             # 本仓库生成的不可变 DDL 链与 meta（Drizzle Kit 默认输出目录）
├── deploy/
│   ├── assembly/                        # 选择已构建模块组合的 JSON/YAML profile
│   ├── compose/                         # Compose 基础编排与 profile/overlay
│   ├── images/                          # Dockerfile、镜像构建上下文
│   ├── env/                             # 无密钥的环境变量模板与字段说明
│   └── manifests/                       # Helm/Kustomize 等未来部署适配器（按需创建）
├── scripts/                             # 开发、校验、构建、迁移、发布的薄命令入口
├── docs/
│   ├── arch/                            # 当前真实架构与模块边界
│   ├── adr/                             # 不轻易改变的架构决定
│   ├── developer/                       # 开发、测试、模块创建规范
│   ├── operations/                      # 部署、升级、迁移、备份、排障
│   └── design/                          # 待评审设计，不是真相来源
└── upstream/fenix/                      # 仅 EE：Git submodule
```

`upstream/fenix/` 及 EE 的替换实现只表示商业仓库的目标归属；未来 `deploy/manifests/` 等未使用目录也不因图示而创建。

### 1.1 目录责任

- `apps/server` 持有服务入口、现有 HTTP/WebSocket 接入、启动组装与进程生命周期；`apps/web` 持有控制台入口、壳与路由适配。`apps/generated` 是生成代码的归属，`deploy/assembly` 是现有装配配置的归属；不因目录图创建新的装配机制。
- `packages/platform/platform-sdk` 只归属无具体业务实现的平台稳定契约和应用基础设施访问入口，不包含 DB、route 或 Web，也不依赖任何具体平台或资源模块。应用基础设施只定义受限的注册与读取规则，不创建或拥有具体基础设施。
- `packages/` 中除 `platform/`、`agent-runtime/`、`resources/` 外的包均为独立 SDK 或插件包。服务模块直接通过包引用使用其能力；这些包不适用资源包内部目录或服务模块依赖规则，只要求包间依赖无环。
- `packages/platform/identity` 与 `packages/platform/access-control` 是同一版本成套替换的有状态平台模块。Identity 拥有用户、组织、成员、认证/API Key 及相应 DB、route、Web；AccessControl 可依赖 Identity 的公开入口，但不得导入其 repository、schema 或内部路径。`packages/resources/identity-admin` 已随 CE 阶段 2 任务 1.2 按职责拆分并删除，未保留兼容包或 re-export shim。
- `packages/resources/<resource>` 是该业务已有后端、DB 与前端文件的物理归属；不能仅凭业务引用关系把其他资源的源码复制到本包。
- `packages/agent-runtime` 归属原 `src` 的 Environment、Instance、生命周期与 relay/session 运行组合；已经独立的四个基础运行包仍归各自原包，不复制。
- 四个基础运行包保持独立 workspace、依赖和测试边界。在线链路的高耦合由 `@fenix/agent-runtime` 组合，不等于将基础能力合并成一个物理 package。
- `packages/agent-runtime` 持有运行组合；LaunchSpec 中的业务资源解析归所属资源，Workflow 仍归自身业务 owner。Machine 与 Sandbox 保持独立资源包及各自 DB/Web owner，但作为 Runtime 的固定基础资源，允许 `agent-runtime → sandbox → machine` 及 `agent-runtime → machine` 的公开入口依赖；Machine/Sandbox 不得反向依赖 Runtime。
- `packages/resources/<resource>/web` 是该业务页面、API client、i18n 和专有前端组件的物理归属；共同的全局壳与通用组件归 `apps/web`。
- `db/` 和 `deploy/` 是仓库级交付物，不属于任意业务模块；模块通过显式贡献接入它们。

### 1.2 资源包内部目录示例

下面的子目录只定义文件的物理归属。未有真实文件的子目录无需创建；是否引入新的 Facade、DTO、capability 或 migration manifest，不能由目录图自行推导。`web/` 不因此更改现有页面或 API。

`packages/platform/identity` 虽不属于普通资源，但同样是有状态模块，因此也按实际需要拥有 `src/`、`db/`、`web/`、manifest、测试和 README；其物理位置仍在 `packages/platform/identity`，不能为了复用下列示例将它放回 `packages/resources`。

```text
packages/resources/<resource>/
├── src/
│   ├── domain/          # 已有领域规则；没有则不创建
│   ├── services/        # 本资源既有业务 service
│   ├── repositories/    # 本资源既有持久化代码
│   ├── adapters/        # 已有外部适配能力；按需
│   ├── routes/          # 本资源既有协议路由实现
│   ├── schemas/         # 本资源既有请求/响应校验
│   ├── module.ts        # 已有描述符；没有则不因搬迁创建
│   └── index.ts         # 本资源实际使用的包出口
├── db/                  # 本资源已有 schema 声明
├── web/                 # 本资源已有页面、API client、i18n、组件
│   └── index.ts
├── package.json         # 实际使用的 workspace 出口和依赖
├── fenix.module.ts      # 已有 manifest；没有则不因目录图创建
└── README.md            # 包职责说明
```
