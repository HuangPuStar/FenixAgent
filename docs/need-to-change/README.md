# FenixAgent 架构对抗审计：整改总账

> 审计基线：2026-08-10 当前工作区（包含尚未提交的在途改动）  
> 审计方式：领域上下文与 ADR 对照、静态依赖扫描、数据流追踪、并发/故障反例、契约交叉核验  
> 文档性质：整改决策输入，不代表问题已经修复，也不以当前实现便利作为目标架构边界

## 总结判决

当前项目已经具备平台所需的大部分能力，但控制面、执行面、通信面和租户边界尚未形成彼此独立的深模块。最危险的问题不是“大文件很多”，而是多个浅 Module 共同持有同一种关键资源：宿主进程、原始 relay、ACP session、Y.Doc、租户上下文和外部副作用。它们的 interface 没有封装 implementation 的复杂度，调用方因此直接承担路由、关联、重试、关闭、补偿和隔离规则。

红队给出的停止线如下：

1. 在隔离执行面前，不应把 Shell/Python Workflow 能力开放给普通租户成员。
2. 在实例级 Relay Broker 落地前，不应声称同一 Agent instance 可以安全支持多个 Chat、Workflow 或 external relay 消费者。
3. 在数据库约束和 fail-closed 租户上下文落地前，不应把“所有查询都记得带 organizationId”当作多租户完整性保证。
4. 在统一出网策略和可信渲染策略落地前，不应允许租户输入直接决定目标 URL 或主动 HTML 内容。
5. 在 Knowledge runtime 删除 `isGlobal=true` / `|| true` 的访问短路前，不应把组织过滤后的 CRUD 等同于完整知识库隔离。
6. 在 release gate、迁移失败语义和 readiness 落地前，不能把“容器启动且 `/health` 返回 ok”解释为可发布、可接流量。

## 风险登记册

| 编号 | 优先级 | 整改主题 | 首要故障 | 前置关系 |
| --- | --- | --- | --- | --- |
| [1](./1-isolate-workflow-execution-plane.md) | P0 | 隔离 Workflow 执行面 | 租户代码在控制面宿主执行并继承全部环境变量 | 无 |
| [2](./2-introduce-instance-relay-broker.md) | P0 | 实例级 Relay Broker | 多个逻辑消费者共享原始 relay、RPC ID 和关闭权 | 无 |
| [3](./3-enforce-tenant-execution-binding.md) | P0 | 不可变执行绑定 | 组织环境复用实例时可能在首个用户 workspace 执行 | 2 |
| [4](./4-centralize-outbound-request-policy.md) | P0 | 统一出网策略 | Workflow/Task 可访问任意 URL，形成 SSRF 与数据外送面 | 1 |
| [5](./5-contain-proxy-credentials.md) | P0 | 代理凭据隔离 | RCS Cookie/Authorization/组织头被透传到下游 | 4 |
| [6](./6-secure-untrusted-content-rendering.md) | P0 | 未可信内容渲染 | 文档 HTML 以脚本 + same-origin 或未清洗方式进入 DOM | 无 |
| [7](./7-enforce-tenant-integrity-in-database.md) | P0 | 数据库租户不变量 | 关联表可组合不同组织记录，用户偏好以组织为主键互相覆盖 | 无 |
| [8](./8-make-tenant-context-fail-closed.md) | P0 | 租户上下文 fail-closed | 显式错误组织被静默回退，角色缓存允许撤权延迟 | 7 |
| [9](./9-remove-legacy-workflow-storage-fallback.md) | P0 | 删除无租户历史回退 | 任意组织可发现并认领全局旧 Workflow 目录 | 7、8 |
| [10](./10-authenticate-local-acp-relay.md) | P0 | 本地 ACP relay 认证 | loopback WS token 为空，同主机进程可控制 Agent | 无 |
| [11](./11-demultiplex-external-and-remote-relay.md) | P0 | 外部/远程 relay 分流 | 同实例内容广播给多个客户端，remote session last-writer-wins | 2、10 |
| [12](./12-correlate-acp-sessions-and-rpc.md) | P0 | ACP session/RPC 关联 | 未绑定 Chat 接收他人 update，response 绑定错误 session | 2 |
| [13](./13-gate-yjs-on-durable-readiness.md) | P1 | Y.Doc 恢复屏障 | Redis 快照未加载就 ready，产生空快照和旧消息复活 | 2、12 |
| [14](./14-make-yjs-sync-lossless-under-backpressure.md) | P1 | YJS 无损同步 | 64KB 背压直接丢初始快照却仍宣告 ready | 13 |
| [15](./15-preserve-command-idempotency-across-reconnects.md) | P1 | Chat 命令幂等 | 断开即删除 commandId 状态，重连重试重复副作用 | 12、13 |
| [16](./16-bound-runtime-resources.md) | P1 | 运行时资源上限 | 任意 sessionId 留下无 TTL Y.Doc、Redis 连接和缓冲 | 2、13 |
| [17](./17-propagate-workflow-cancellation-and-finalization.md) | P1 | Workflow 取消与收尾 | 节点超时后 Agent 继续运行，recover/rerun 泄漏实例 | 2、20 |
| [18](./18-align-remote-file-placement.md) | P1 | 文件与运行位置一致性 | 远程不可用被解释为本地，文件操作与 Agent workspace 分裂 | 3 |
| [19](./19-finish-claude-code-runtime.md) | P0 | Claude runtime 生产就绪 | 生产注册的占位 runtime 回显消息并报告 running | 2、10 |
| [20](./20-make-workflow-runs-idempotent-and-durable.md) | P1 | Workflow run 生命周期 | 客户端重试可重复执行，随机 HMAC 使重启后审批失效 | 1、17 |
| [21](./21-make-cross-system-writes-recoverable.md) | P1 | 跨系统写补偿 | Agent Sites 远端与本地 DB 部分成功后无法收敛 | 7 |
| [22](./22-deepen-backend-application-modules.md) | P1 | 后端应用层深模块 | route/service/repository 依赖反向且业务编排散落 | 7、8 |
| [23](./23-deepen-knowledge-lifecycle-module.md) | P0/P1 | Knowledge 访问与生命周期 | 常量短路组织过滤；1,000+ 行 route/provider 混合多种职责 | 7、21、22 |
| [24](./24-make-api-contracts-single-source.md) | P1 | API 契约单一真相 | agentId 在前端/handler 存在却被 Zod schema 静默剥离 | 22 |
| [25](./25-repair-frontend-request-seam.md) | P1 | 前端请求深模块 | headers 被覆盖、承诺的重试不存在、错误被当成功 | 24 |
| [26](./26-make-frontend-tenant-switch-atomic.md) | P1 | 前端租户原子切换 | UI 显示组织与请求实际组织可不同，且全局 fetch 泄露头 | 8、25 |
| [27](./27-scope-frontend-async-work.md) | P1 | 异步作用域与状态机 | A 知识库轮询覆盖 B 页面并组合 B kbId + A resourceId | 25、26 |
| [28](./28-fix-shared-accessibility-primitives.md) | P1 | 可访问性基础组件 | `role=treeitem` 可聚焦但不可键盘操作 | 无 |
| [29](./29-enforce-frontend-performance-budgets.md) | P2 | 前端性能预算 | 固定轮询 N+1、双请求、大 chunk 与生产 sourcemap | 25、27 |
| [30](./30-break-workspace-dependency-cycles.md) | P1 | Workspace 包图 | runtime 依赖放 devDependency，插件与 acp-link 形成环 | 2 |
| [31](./31-gate-release-and-migration.md) | P0 | 发布与迁移门禁 | main/tag 未经 CI 直接发镜像，迁移可吞掉真实失败 | 无 |
| [32](./32-add-readiness-observability-and-log-privacy.md) | P0 | Readiness/可观测/日志隐私 | `/health` 永真、同步落盘、用户内容持久化且无脱敏 | 2、13 |
| [33](./33-harden-production-artifact-and-deployment.md) | P1 | 生产制品与部署 | 缺 dist 时服务源码、root 运行、默认 URL/CORS 契约错误 | 31、32 |
| [34](./34-turn-architecture-rules-into-fitness-functions.md) | P1 | 架构适应度函数 | 500 行、层级、包依赖、契约规则只有文字没有门禁 | 22、24、30、31 |
| [35](./35-make-architecture-docs-versioned-truth.md) | P2 | 文档真相与决策生命周期 | 目标态、现状、在途改动混写，文档命令和包数已漂移 | 34 |
| [36](./36-make-agent-configuration-an-atomic-aggregate.md) | P1 | Agent 配置事务聚合 | 多表顺序替换部分失败，并发保存得到混合版本 | 7、22 |
| [37](./37-coordinate-scheduler-with-distributed-leases.md) | P1 | 分布式调度租约 | 每个副本加载全部 cron，本地 Set 无法防多副本重复 | 20、31 |
| [38](./38-make-tenant-provisioning-recoverable.md) | P1 | 租户创建状态机 | 注册成功但个人组织/member 可能只完成一半 | 7、8、22 |
| [39](./39-fix-workflow-event-cursor-ordering.md) | P1 | Workflow event cursor | cursor 谓词与排序不一致，恢复漏同时间戳事件 | 20 |
| [40](./40-define-task-log-retention-and-integrity.md) | P2 | Task 日志生命周期 | 删除 task 留下无 FK、无租户快照的孤儿日志 | 7、37 |
| [41](./41-enforce-i18n-as-a-view-contract.md) | P2 | i18n View 契约 | 核心流程硬编码、locale 固定、namespace 全量首屏加载 | 25、34 |
| [42](./42-make-process-shutdown-a-drain-protocol.md) | P1 | 进程 Drain Protocol | running task/Y.Doc/file batch 未 flush 就关 DB/退出 | 13、17、32、37 |
| [43](./43-unify-error-contracts-at-protocol-boundaries.md) | P1 | 错误契约 | route 吞未知异常，状态/shape/脱敏与全局边界漂移 | 22、25、32 |

## 推荐推进波次

### Wave 0：立即降低暴露面

- 暂停普通成员创建/执行 Shell、Python Workflow；对现有功能增加运维级 feature flag。
- 暂停同一 instance 的多消费者复用，或强制一条逻辑会话一个实例。
- 禁用未清洗 HTML/Docx 主动渲染和 `allow-scripts allow-same-origin`。
- 禁止任意 URL 出网，至少先阻断 loopback、link-local、RFC1918、metadata 和跨协议重定向。

### Wave 1：建立四个权威 seam

- Instance Relay Broker：唯一拥有物理连接、RPC ID、订阅和 close 权。
- Tenant Execution Binding：唯一决定 org/user/env/machine/workspace。
- Tenant Context + Scoped Persistence：请求入口解析，数据库约束兜底。
- Outbound Request Policy：所有代理、Workflow、Task 和 provider 出网统一经过。

### Wave 2：恢复与故障语义

- Y.Doc ready/flush、无损初始同步、命令幂等和资源租约。
- Workflow run 的 operation identity、取消、finalizer 和重启恢复。
- 外部副作用 saga、迁移锁与严格失败、readiness/drain。

### Wave 3：提升局部性与持续约束

- 深化 Backend/Knowledge/Frontend Request Module，删除调用方重复判断。
- 建立契约生成、包独立构建、依赖环、文件行数、bundle budget 和文档校验门禁。
- 把 ADR 中的目标态与实际 rollout 状态分开维护。

## 审计口径与误报控制

- “P0”表示存在跨租户、控制面执行、凭据/内容暴露或发布完整性失守的可达故障链，不等价于已在公网被利用。
- 当前工作区包含在途改动；本文描述的是审计时可见代码，不替代按 commit 的历史归因。
- 多组织问题按“同一合法用户在多个组织间发生 wrong-tenant 操作”表述；未发现证据时不夸大为绕过服务端授权。
- 本地 `web/dist` 体积只作为当前工作区构建证据，不冒充已发布镜像的遥测数据。
- Drizzle migrator 是否在当前版本提供足够的跨副本锁需要单独实验；本文只确认 compose 会并发触发迁移且 runner 会吞 `already exists`。

## 完成定义

单篇文档只有在以下条件全部满足后才能从总账移除：

1. 目标不变量已落到一个有明确所有权的 Module interface，而非散落的调用约定。
2. 至少有一个正常路径、一个对抗反例、一个取消/超时或部分失败测试。
3. 有可观测信号、灰度/回滚办法和历史实现删除条件。
4. 相关 ADR、开发规范、环境变量和部署清单同步更新。
5. `bun run precheck`、受影响的前端生产构建、迁移演练或文档构建按变更类型通过。
