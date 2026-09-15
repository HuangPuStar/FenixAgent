# CE / EE 工程目录结构与归属说明

> 本文仅描述目标**物理目录**及文件 owner；现有接口、权限、数据和业务行为是否适配新规范由相应执行阶段决定。阶段 1 只需依据本目录图和当前代码确认归属。

## 1. 仓库与目录归属

两个仓库采用相同的目标骨架。以下只描述目录和归属，不规定从当前仓库迁到这些目录的任务、顺序或实现动作。

```text
fenix/ 或 fenix-ee/
├── apps/
│   ├── server/                         # HTTP、WebSocket、启动装配、进程生命周期
│   └── web/                            # 控制台壳、TanStack Router 最终装配
├── packages/
│   ├── platform/                       # 无业务领域依赖的平台契约与基础实现
│   │   ├── platform-sdk/               # Context、授权端口、资源端口、模块描述符
│   │   └── access-control/             # 默认实现；EE 仓库以同路径提供替换实现
│   ├── agent-runtime/                  # @fenix/agent-runtime：统一组合原 src 中的 Agent 运行编排
│   ├── core/                           # @fenix/core：进程与实例执行内核
│   ├── orchestration/                  # @fenix/orchestration：节点与实例编排基础能力
│   ├── chat-channel/                   # @fenix/chat-channel：Chat/YJS 协议、状态与传输
│   ├── remote-runtime/                 # @fenix/remote-runtime：远端运行与 relay transport
│   ├── resources/                      # 完整资源领域模块（后端、DB、web contribution）
│   │   ├── agent-config/               # 默认实现；EE 仓库以同路径扩展发布/审批
│   │   └── <resource>/
├── db/
│   ├── migrations/                      # 当前仓库拥有的 Drizzle 生成物及 meta
│   └── data-migration-runner.ts         # 仅负责汇总、排序、记录和执行模块迁移
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

`upstream/fenix/` 及 EE 的替换实现只表示商业仓库的目标归属，不属于 CE 阶段 1 的搬迁范围；未来 `deploy/manifests/` 等未使用目录也不因图示而创建。

### 1.1 目录责任

- `apps/server` 持有服务入口、现有 HTTP/WebSocket 接入、启动组装与进程生命周期；`apps/web` 持有控制台入口、壳与路由适配。`apps/generated` 是生成代码的归属，`deploy/assembly` 是现有装配配置的归属；不因目录图创建新的装配机制。
- `packages/platform` 归属无业务领域依赖的平台公共能力；业务鉴权逻辑是否适配新平台不由目录归属决定。
- `packages/resources/<resource>` 是该业务已有后端、DB 与前端文件的物理归属；不能仅凭业务引用关系把其他资源的源码复制到本包。
- `packages/agent-runtime` 归属原 `src` 的 Environment、Instance、生命周期与 relay/session 运行组合；已经独立的四个基础运行包仍归各自原包，不复制。
- 四个基础运行包保持独立 workspace、依赖和测试边界。在线链路的高耦合由 `@fenix/agent-runtime` 组合，不等于将基础能力合并成一个物理 package。
- `packages/agent-runtime` 持有运行组合；LaunchSpec 中的业务资源解析归所属资源，Machine 和 Workflow 的原有实现分别归其自身业务 owner。目录归属不要求移动时重写既有业务行为。
- `packages/resources/<resource>/web` 是该业务页面、API client、i18n 和专有前端组件的物理归属；共同的全局壳与通用组件归 `apps/web`。
- `db/` 和 `deploy/` 是仓库级交付物，不属于任意业务模块；模块通过显式贡献接入它们。

### 1.2 资源包内部目录示例

下面的子目录只定义文件的物理归属。阶段 1 只承接现有文件，未有真实文件的子目录无需创建；是否引入新的 Facade、DTO、capability 或 migration manifest，不能由目录图自行推导。`web/` 不因此更改现有页面或 API。

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
