# 当前功能模块全量清单（面向 AppBuilder 拆分）

> 盘点基线：当前工作区代码与文档，2026-09-03。
>
> 本文按未来可**独立安装、替换或启停**的交付单元划分，而不是按现有目录、数据表或 HTTP 路由划分。一个模块可以同时暴露控制台、外部 API、WebSocket 和内部服务；没有路由的运行时、编排、存储和安全能力同样纳入清单。

## 模块关系图

可在 draw.io / diagrams.net 打开 [MODULE_ARCHITECTURE.drawio](MODULE_ARCHITECTURE.drawio)。该文件含两个页面：

1. 「全局模块关系」展示 AppBuilder 对各类模块的装配关系和主依赖方向。
2. 「Agent 运行主链路」展示配置、实例编排、引擎插件、ACP、Chat 与工作流如何复用同一运行链路。

## 分类与角色说明

| 分类 | 定义 | AppBuilder 默认角色 |
| --- | --- | --- |
| 核心运行模块 | 支撑 Agent 从配置到进程、协议与交互运行的主链路 | 核心包；运行 Agent 时必选 |
| 资源配置模块 | 可被 Agent、工作流或其他模块引用的可配置资源 | 可选功能包；各资源提供插件化扩展点 |
| 自动化与编排模块 | 将 Agent、工具和外部动作组织为可触发、可恢复的自动化流程 | 可选功能包；工作流节点、触发器为插件点 |
| 会话协作模块 | 管理 Agent 对话、会话状态和实时协作数据，而不是承载所有前端页面 | 可选功能包；YJS 持久化/传输为插件点 |
| 站点、视图与发布模块 | 将 Agent 生成或管理的内容构建、部署和公开交付 | 可选功能包；部署目标与展示形态为插件点 |
| 控制台壳与模块扩展 | 提供统一应用壳、品牌、导航与模块 UI 扩展槽；不包含业务页面本身 | AppBuilder 前端壳；导航/UI 贡献为插件点 |
| 身份、组织与授权模块 | 身份认证、多租户边界、访问控制和资源共享 | 平台核心包；策略提供器可替换 |
| 运行资源与连接模块 | 提供 Agent 的执行位置、环境、文件、沙盒和远程连接 | 平台核心包；Provider/运行时适配器为插件点 |
| 平台运维与治理模块 | 启动装配、可观测性、系统管理、数据演进与通用协议治理 | 平台核心包；观测与部署适配器可选 |

**角色约定：**「核心包」指 AppBuilder 的最小运行闭包；「可选功能包」可整体不安装；「插件点」指同一模块内应允许多个实现注册，而不是把每一种实现拆成业务模块。

**适配器归属：**控制台页面、外部 API、WebSocket 和内部服务都是同一个功能模块的适配器，不构成功能模块分类。比如 Skill 模块同时拥有 Skill 配置页面、`/web` 与 `/api` 路由、下载端点和运行时安装服务；Agent/Admin 面板只负责装配各模块贡献的页面，不应成为独立的「前端模块」。

## 一、核心运行模块

| 模块 | 功能点（完整业务能力） | 当前主要实现位置 | 主要依赖／被依赖方 | AppBuilder 建议角色 |
| --- | --- | --- | --- | --- |
| Agent 运行与单轮调用 | 根据 Agent 配置创建独立运行实例；发送 prompt；接收流式更新、工具调用、权限请求与完成状态；支持 OpenAI 兼容 chat 调用；映射统一错误与用量信息；销毁单轮实例 | `src/services/agent-chat-service.ts`、`src/routes/api/openai-chat.ts`、`src/services/openai-response-mapper.ts` | 依赖实例编排、ACP Relay、Agent 配置、模型与环境；被 Chat、工作流和外部 API 使用 | 核心包 `agent-runtime` |
| Agent 实例生命周期与编排 | 创建、查询、启动、停止、重启、删除和回收实例；实例注册与状态对账；并发配额；空闲与活动超时回收；会话与实例关联；构建 LaunchSpec；故障补偿 | `src/services/instance*.ts`、`src/services/orchestration-instance.ts`、`src/services/agent-concurrency.ts`、`src/services/acp-idle-monitor.ts`、`packages/orchestration/` | 依赖 Agent 配置、环境、机器、沙盒、引擎插件；被运行、Chat、工作流、实例 API 使用 | 核心包 `agent-orchestration` |
| Agent 引擎插件与运行时适配 | 定义 EnginePlugin／EngineRuntime 契约；准备工作区；安装 Skill；生成 MCP 与运行时配置；启动/停止引擎和 Relay；当前实现 Claude Code、OpenCode、CCB | `packages/plugin-sdk/`、`packages/plugin-claude-code/`、`packages/plugin-opencode/`、`packages/plugin-ccb/` | 被实例编排调用；消费 Skill、MCP、模型、环境 | 插件 SDK `agent-engine-sdk` + 引擎插件 |
| ACP 协议、桥接与 Relay | ACP JSON-RPC 编解码；stdio 到 WebSocket 桥接；客户端连接与重连；session/new、load、prompt、控制指令转发；本地与远程 Relay；外部 Relay 兼容；连接释放 | `packages/acp-link/`、`src/routes/acp/`、`src/transport/acp-ws-handler.ts`、`src/transport/agent-relay.ts`、`src/transport/relay/`、`packages/remote-runtime/` | 连接 Agent 引擎、机器节点、Chat、工作流、文件通道 | 核心包 `acp-transport`；远程连接为适配器插件 |
| Agent 会话控制与权限交互 | 中断当前 turn；发送 session 事件/控制命令；处理 Agent 的 ask/allow/deny 权限请求、交互式问题、模型/模式/命令切换与 session 管理 | `src/routes/web/control.ts`、`packages/acp-link/src/types.ts`、`packages/chat-channel/src/channel/` | 依赖 ACP、Chat 状态、资源权限 | 核心包 `agent-session-control`（可并入 `agent-runtime`） |

## 二、资源配置模块

| 模块 | 功能点（完整业务能力） | 当前主要实现位置 | 主要依赖／被依赖方 | AppBuilder 建议角色 |
| --- | --- | --- | --- | --- |
| Agent 配置与模板 | Agent 配置的创建、查询、修改、删除、复制和跨组织共享；选择模型、Provider、引擎、环境、Skill、MCP、知识库、记忆和站点；Agent 模板解析与管理；系统提示词；从自然语言生成配置 | `src/services/config/agent-config.ts`、`src/services/agent-templates.ts`、`src/services/agent-system-prompt.ts`、`src/services/agent-generation.ts`、`src/routes/web/config/agents.ts`、`src/routes/api/agents.ts` | 聚合全部 Agent 资源；被实例编排与交互模块消费 | 可选功能包 `agent-catalog` |
| Skill 资源 | Skill 的上传、导入、下载、查询、修改、删除、启停、归档与解压；文件系统落盘；下载令牌签发；内置 Skill 同步；绑定到 Agent 并在引擎工作区安装 | `src/services/skill.ts`、`src/services/skill-fs.ts`、`src/services/skill-download-token.ts`、`src/routes/web/config/skills.ts`、`src/routes/api/skills.ts`、`src/routes/skills.ts` | 被 Agent 配置和引擎插件消费；依赖组织、文件存储 | 可选功能包 `skills` |
| MCP 服务与工具 | MCP Server 的 CRUD、连通性检查、工具发现与缓存；stdio/streamable HTTP 等配置；MCP 与 Agent 的绑定；对外知识库 MCP 端点 | `src/services/config/mcp-server.ts`、`src/services/config/agent-config-mcp.ts`、`src/services/mcp-inspector.ts`、`src/routes/web/config/mcp.ts`、`src/routes/api/mcp.ts`、`src/routes/mcp/knowledge.ts` | 被 Agent 引擎、工作流和知识库使用；依赖密钥解析 | 可选功能包 `mcp`；Server 类型为插件点 |
| 模型与 Provider 配置 | Provider、模型的 CRUD、可用性查询、模型能力配置、模型与 Agent 的绑定、跨组织共享；运行期模型选择 | `src/services/config/provider.ts`、`src/services/config/model.ts`、`src/routes/web/config/providers.ts`、`src/routes/web/config/models.ts`、`src/routes/api/models.ts` | 被 Agent 配置、模型网关、引擎插件使用 | 可选功能包 `model-catalog`；Provider 适配器为插件点 |
| 模型网关与额度 | 管理网关 Provider 投影、网关凭证加密存储、运行时凭证解析、用户主体同步、预算、用量查询与重置、网关健康状态 | `src/services/model-gateway/`、`src/routes/web/model-gateway.ts`、`src/routes/api/system-model-gateway.ts`、`packages/model-gateway-sdk/`、`packages/model-gateway-litellm/` | 依赖认证、模型/Provider、加密；被 Agent 运行使用 | 可选功能包 `model-gateway`；网关适配器为插件点 |
| 知识库与 RAG | 知识库 CRUD；文件/文本资源上传、解析、更新、删除；索引状态查询；Agent 与知识库绑定；运行时检索；RagFlow Provider、密钥和健康检查；经 MCP 暴露检索能力 | `src/services/knowledge-*.ts`、`src/services/agent-knowledge.ts`、`src/services/knowledge-provider/`、`src/routes/web/knowledge-bases.ts`、`src/routes/api/knowledge-bases.ts`、`src/routes/mcp/knowledge.ts` | 依赖组织、文件、MCP；被 Agent 和工作流使用 | 可选功能包 `knowledge`；RAG Provider 为插件点 |
| Agent 记忆 | Agent 记忆配置及其与 Agent 的绑定；记忆相关控制台页面与 Hindsight 查询入口 | `src/repositories/agent-memory-config.ts`、`src/services/agent-memory.ts`、`web/src/pages/hindsight/`、`src/routes/web/hindsight.ts` | 依赖 Agent 配置和组织；被 Agent 运行消费 | 可选功能包 `agent-memory`；记忆后端为插件点 |
| 环境配置 | 环境的创建、查询、修改、删除、启动和停止；绑定 Agent 配置与机器；ACP 环境参数；启动锁；环境状态管理 | `src/services/environment*.ts`、`src/repositories/environment*.ts`、`src/routes/web/environments.ts` | 依赖组织、机器、工作区、实例编排；被运行时使用 | 核心资源包 `environments` |
| 沙盒资源池与沙盒实例 | 沙盒 Provider 注册；资源池、实例的 CRUD；默认池初始化；分配、复用、删除和重建；重启恢复；集群／服务器／隧道管理 API | `src/services/sandbox/`、`src/repositories/sandbox-*.ts`、`src/routes/api/sandbox*.ts`、`packages/sandbox-provider/`、`packages/opensandbox-cluster/` | 依赖环境、工作区、机器与实例编排 | 可选基础包 `sandbox`；Provider、集群实现为插件点 |
| IM 通道与路由 | IM 通道配置查询；通道路由；创建、删除、启停和更新绑定；按通道把消息路由到 Agent | `src/services/channel-provider.ts`、`src/services/channel-binding.ts`、`src/repositories/channel-binding.ts`、`src/routes/web/channels.ts` | 依赖 Agent 配置、组织和电话号处理 | 可选功能包 `channels`；每个 IM Provider 为插件点 |

## 三、自动化与编排模块

| 模块 | 功能点（完整业务能力） | 当前主要实现位置 | 主要依赖／被依赖方 | AppBuilder 建议角色 |
| --- | --- | --- | --- | --- |
| 工作流定义与版本 | YAML 工作流创建、读取、更新、删除、复制、校验、导入导出；版本管理、发布与回滚；工作流看板与用户配置 | `src/services/workflow/resolve-yaml.ts`、`src/repositories/workflow-def.ts`、`src/routes/web/workflow-defs.ts`、`packages/workflow-engine/` | 被执行、触发器和控制台使用；引用 Agent、MCP、模型与环境 | 可选功能包 `workflow-definition` |
| 工作流执行、运行记录与恢复 | DAG 解析、调度、并行、重试、取消、审批、快照恢复；运行创建、查询、终止；节点输出、事件流（SSE）、持久化与实例租约；Agent Chat transport | `src/services/workflow/`、`src/routes/web/workflow-engine.ts`、`src/routes/web/workflow-runs.ts`、`src/routes/web/workflow-sse.ts`、`packages/workflow-engine/` | 依赖 Agent 运行、实例、数据库、事件流 | 可选功能包 `workflow-runtime` |
| 工作流节点与自定义工具 | 内置 Agent/API/Shell/Python/循环/子工作流/审批等节点执行器；扫描注册自定义工具；Slurm/SSH 作业传输；自定义节点元数据查询 | `packages/workflow-engine/src/executor/`、`packages/workflow-engine/src/plugins/`、`src/services/workflow/custom-tools.ts`、`src/routes/web/workflow-custom-tools.ts` | 被工作流运行时加载；可调用 Agent、远程资源 | 工作流插件 SDK + 节点插件 |
| 定时任务 | 定时任务 CRUD、启停、手动触发、下次执行计算；HTTP 与 Agent 执行器；执行日志与失败记录；调度服务启动/停止 | `src/services/scheduler/`、`src/services/task-v2.ts`、`src/repositories/task-v2.ts`、`src/routes/web/tasks-v2.ts` | 依赖 Agent 运行、HTTP、组织与日志 | 可选功能包 `scheduler`；执行器为插件点 |
| 工作流触发器与 Webhook | 工作流触发器 CRUD；生成与校验公共 Hash；接收外部 Webhook 并启动相应工作流 | `src/services/workflow-trigger.ts`、`src/repositories/workflow-trigger.ts`、`src/routes/hooks.ts`、`src/routes/web/workflow-defs.ts` | 依赖工作流运行、认证与限流 | 可选功能包 `workflow-triggers`；触发器类型为插件点 |
| Peri 任务详情 | 聚合和持久化 Agent 运行过程中的 Peri 任务详情；详情查询与 Chat 投影衔接 | `src/services/peri-task-detail-*.ts`、`src/routes/web/peri-task-details.ts`、`packages/chat-channel/` | 依赖 ACP、Chat 和实例 | 可并入 `agent-session-control` 的可选子模块 |

## 四、会话协作模块

| 模块 | 功能点（完整业务能力） | 当前主要实现位置 | 主要依赖／被依赖方 | AppBuilder 建议角色 |
| --- | --- | --- | --- | --- |
| 实时 Chat 与会话状态 | Chat WebSocket；Y.Doc 的 Chat/Session 双文档；消息写入与流式投影；会话创建、加载、恢复、重命名、删除；断线重连、多标签页共享、背压控制、快照持久化；错误诊断关联 | `packages/chat-channel/`、`src/services/chat-channel-bootstrap.ts`、`src/services/doc-manager-instance.ts`、`web/src/pages/agent-panel/Chat*.tsx`、`web/src/yjs/` | 依赖 ACP、实例、组织、Redis；其控制台与公开 Agent 页面均为本模块适配器 | 可选功能包 `chat`；YJS 持久化/传输为插件点 |

## 五、站点、视图与发布模块

| 模块 | 功能点（完整业务能力） | 当前主要实现位置 | 主要依赖／被依赖方 | AppBuilder 建议角色 |
| --- | --- | --- | --- | --- |
| Agent Site 建站与发布 | Site App 创建、读取、更新、删除、构建、部署、版本/资源管理；可见性控制；兼容与反向代理；Agent 自动生成站点配置 | `src/services/agent-sites.ts`、`src/repositories/agent-site-app.ts`、`src/routes/web/agent-sites.ts`、`src/routes/agent-sites-proxy.ts`、`web/src/routes/agent/_panel/sites.tsx` | 依赖 Agent 配置、环境、文件、授权；Site 管理页是本模块控制台适配器 | 可选功能包 `agent-sites`；部署目标为插件点 |
| 产品视图与公开交付 | Product View 的创建、查询、更新、删除和公开访问；将 Agent 产物组织为独立查看页 | `src/services/prod-view.ts`、`src/repositories/prod-view.ts`、`src/routes/web/config/prod-views.ts`、`src/routes/web/prod-views.ts`、`web/src/pages/prod-view/` | 依赖组织、Agent 产物和授权；公开查看页是本模块交付适配器 | 可选功能包 `product-views` |

## 六、控制台壳与模块扩展

| 模块 | 功能点（完整业务能力） | 当前主要实现位置 | 主要依赖／被依赖方 | AppBuilder 建议角色 |
| --- | --- | --- | --- | --- |
| 控制台壳、品牌与导航扩展 | 控制台品牌信息、侧边栏配置树、内置菜单、页面布局与可扩展导航；装配各功能模块提供的路由和页面贡献，但不拥有其业务数据、服务或页面领域逻辑 | `src/services/branding.ts`、`src/services/sidebar-config.ts`、`src/routes/web/branding.ts`、`src/routes/web/sidebar-config.ts`、`web/src/pages/agent-panel/AgentAppShell.tsx`、`web/src/pages/agent-panel/AgentPanelLayout.tsx` | 依赖认证、组织和已安装模块的导航/UI 贡献；被所有控制台适配器使用 | AppBuilder 前端壳 `console-shell`；导航/UI contribution 为插件点 |

## 七、身份、组织与授权模块

| 模块 | 功能点（完整业务能力） | 当前主要实现位置 | 主要依赖／被依赖方 | AppBuilder 建议角色 |
| --- | --- | --- | --- | --- |
| 用户身份与会话认证 | 用户、账号、Session、验证码；登录/登出；Cookie Session；API Key、环境 Secret 与系统 API Key 认证调度；可信来源；令牌签发与加密 | `src/auth/`、`src/plugins/auth.ts`、`src/plugins/system-api-auth.ts`、`src/services/session.ts`、`src/repositories/user.ts`、`src/repositories/token.ts` | 被全部用户入口、WebSocket 与外部 API 使用 | 平台核心包 `identity`；认证提供器为插件点 |
| 组织、成员与邀请 | 组织 CRUD；成员加入/移除/角色变更；邀请创建与接受；活动组织解析；组织上下文失效保护；组织人员树 | `src/services/web-organization-service.ts`、`src/services/org-context.ts`、`src/repositories/organization*.ts`、`src/routes/web/organizations.ts`、`src/routes/api/system-people-tree.ts` | 被所有租户资源使用 | 平台核心包 `tenancy` |
| API Key 管理 | 控制台 API Key 的创建、查询、更新、删除、状态控制；组织元数据恢复与成员关系再校验 | `src/routes/web/api-keys.ts`、`src/db/schema.ts` 的 `apikey`、`src/plugins/auth.ts` | 依赖身份、组织；被外部 API 调用方使用 | 可选功能包 `api-keys`（依赖 `identity`） |
| 资源可见性、共享与权限 | 组织内/跨组织资源可见性；资源读取权限规则；Agent Site 可见性；分享链接、分享事件快照；运行时资源授权检查 | `src/services/resource-permission.ts`、`src/repositories/resource-permission.ts`、`src/repositories/share-link.ts`、`src/db/schema.ts` 的 `resourcePermission`、`shareLink` | 依赖组织与身份；被资源配置、站点、视图使用 | 平台核心包 `authorization`；策略为插件点 |
| Agent 工具权限策略 | Agent 配置中的 ask/allow/deny；规则型工具的全局三态与 glob 映射；开关型工具权限；将用户决策回写运行时 | Agent 配置 schema、`packages/acp-link/src/types.ts`、Chat Channel permission projection | 依赖 Agent 配置、会话控制与授权 | 可并入 `agent-catalog`，运行时契约由 `agent-runtime` 提供 |

## 八、运行资源与连接模块

| 模块 | 功能点（完整业务能力） | 当前主要实现位置 | 主要依赖／被依赖方 | AppBuilder 建议角色 |
| --- | --- | --- | --- | --- |
| Machine／Agent Node 注册与管理 | Machine 注册、认证、心跳、上线/离线状态、断链清理；节点查询与选择；本地节点服务；Agent Node WebSocket 桥接 | `src/services/registry.ts`、`src/services/registry-heartbeat.ts`、`src/services/local-node-service.ts`、`src/repositories/machine-repository.ts`、`src/routes/web/registry.ts`、`src/transport/agent-node-bridge.ts` | 依赖身份、环境和实例编排；承载远程 Agent | 核心资源包 `agent-nodes`；节点运行时为插件点 |
| 工作区解析与文件服务 | 按组织/用户/环境解析工作区；文件读写、目录与压缩包操作、上传下载；词法与 realpath 越界防护；本地/远程后端选择；文件变更事件、队列、限流、重试；file-ws 连接和僵尸巡检 | `src/services/workspace-*.ts`、`src/services/agent-file-service.ts`、`src/services/remote-file-service.ts`、`src/services/file-*.ts`、`src/routes/web/fs.ts`、`src/routes/web/file-events.ts`、`src/transport/file-ws-*.ts` | 依赖环境、机器、组织；被引擎、站点、知识库、用户使用 | 核心资源包 `workspace-files`；文件后端为插件点 |
| 远程 Runtime 与机器端 CLI | 远程 WebSocket transport；机器侧运行时；ACP Runtime CLI 启动 bridge 并向主服务注册；运行时 relay handle | `packages/remote-runtime/`、`packages/acp-runtime-cli/`、`packages/acp-link/` | 依赖 Machine 注册、ACP 与编排 | `agent-nodes` 的远程运行时插件 |
| 沙盒集群控制面 | OpenSandbox 集群的服务器目标、分配、代理、隧道/FRP、连接监控、卷重写和分布式调度锁 | `packages/opensandbox-cluster/`、`src/routes/api/sandbox-cluster.ts`、`src/routes/api/sandbox-server.ts` | 被沙盒资源池 Provider 使用 | `sandbox` 的可替换集群 Provider |
| 外部服务连接与凭证解析 | RagFlow、Hermes、模型网关等外部服务客户端初始化；Provider 环境密钥引用解析；安全凭证解密 | `src/services/hermes-client.ts`、`src/services/ragflow-key.ts`、`src/services/model-gateway/runtime-credential-resolver.ts`、`src/auth/encryption.ts` | 被知识库、通道、模型网关与引擎使用 | 平台服务 `external-connectors`；每种连接器为插件点 |

## 九、平台运维与治理模块

| 模块 | 功能点（完整业务能力） | 当前主要实现位置 | 主要依赖／被依赖方 | AppBuilder 建议角色 |
| --- | --- | --- | --- | --- |
| 应用启动、模块装配与内置资源 | 环境变量校验与加载；数据库初始化；核心运行时、调度器、沙盒、模型网关初始化；内置资源同步；关闭时回收实例、WS、缓存与定时器；构造 Elysia 应用 | `src/index.ts`、`src/config.ts`、`src/env.ts`、`src/services/core-bootstrap.ts`、`src/services/orchestration-bootstrap.ts`、`src/services/sync-builtin.ts` | 装配全部模块 | AppBuilder 核心 `app-builder` |
| 插件注册表与 Core Runtime | Core Node 注册；引擎插件注册；Runtime Instance Store；按插件创建/刷新/停止运行时实例；插件公共契约 | `packages/core/`、`packages/plugin-sdk/`、`src/services/core-bootstrap.ts` | 被 AppBuilder、编排和引擎插件使用 | AppBuilder 核心 `plugin-runtime` |
| 数据持久化、迁移与缓存 | PostgreSQL/Drizzle Schema；数据库连接；Drizzle 迁移；应用数据迁移记录与执行；Redis/Keyv 缓存生命周期；YJS 快照持久化 | `src/db/`、`src/db/schema.ts`、`drizzle/`、`src/services/data-migrate.ts`、`src/services/cache.ts`、`packages/chat-channel/src/persist/` | 被全部有状态模块使用 | 平台核心包 `persistence`；DB/缓存实现为适配器插件 |
| 事件、实时传输与背压治理 | EventBus；WebSocket 类型与连接管理；Relay 外部连接；SSE 工作流事件；文件与 Chat 的限流、背压、重试、释放 | `src/transport/event-bus.ts`、`src/transport/ws-types.ts`、`src/transport/relay/`、`src/services/event-service.ts`、`src/routes/web/workflow-sse.ts` | 被 Chat、Agent、文件、工作流与机器节点使用 | 平台核心包 `realtime-transport`；传输实现可替换 |
| 日志、错误处理与请求治理 | 结构化日志、console 拦截、请求 ID、请求/响应日志；错误分类、脱敏、统一响应；CORS、静态资源、请求大小和路径规范化 | `packages/logger/`、`src/plugins/logger.ts`、`src/plugins/error-handler.ts`、`src/plugins/cors.ts`、`src/plugins/static.ts`、`src/errors/` | 覆盖全部 HTTP/WS 模块 | 平台核心包 `platform-kernel` |
| 可观测性与系统诊断 | 系统日志查询与清理；Observer 采集/关系图；ACP 链接观察；构建和健康信息；Chat Error ID 与诊断关联 | `src/services/system-log-service.ts`、`src/services/observer/`、`src/services/build-info.ts`、`src/routes/api/system-logs.ts`、`src/routes/api/system-observer.ts`、`docs/arch/23-chat-error-diagnostics.md` | 观察 Agent、连接、平台运行状态 | 可选基础包 `observability`；观测 Provider 为插件点 |
| 系统管理与全局控制面 | 系统管理员引导；系统级资源/配置查询与删除；系统 API；平台人员树；系统控制台权限边界 | `src/services/system-admin.ts`、`src/services/system-api.ts`、`src/services/system-people-tree-service.ts`、`src/routes/api/system.ts`、`src/routes/api/system-people-tree.ts` | 依赖身份、组织、日志和各受管资源 | 可选基础包 `system-admin` |
| OpenAPI 与外部契约 | `/api/*` 外部 API 的 OpenAPI 文档生成；`/web/*` 控制台契约；稳定 API 的 schema/响应映射；健康检查 | `src/openapi.ts`、`src/routes/api/`、`src/schemas/api-*.ts`、`src/schemas/*.ts` | 覆盖所有对外模块 | AppBuilder 适配层 `api-contracts`；路由贡献为插件点 |
| 配置、审计辅助与兼容数据迁移 | 用户配置/自动化状态；内置资源同步；历史数据修复；版本/构建元数据；辅助运行状态 | `src/services/config/user-config.ts`、`src/services/automationState.ts`、`src/services/data-migrates/`、`src/services/build-info.ts` | 被工作流、控制台和启动装配使用 | 按所属模块内聚；不应单独成为业务插件 |

## 现有 workspace 包与未来归属

| 当前包 | 当前职责 | 建议归属 |
| --- | --- | --- |
| `@fenix/core` | Core Runtime、节点/引擎注册表、实例存储 | `plugin-runtime` 核心 |
| `@fenix/plugin-sdk` | 引擎插件与 LaunchSpec 公共契约 | `agent-engine-sdk` |
| `@fenix/orchestration` | AgentController、AgentNode、Instance、LaunchSpec 编排域 | `agent-orchestration` |
| `acp-link` | ACP bridge、客户端、协议和 instance manager | `acp-transport` |
| `@fenix/chat-channel` | YJS Chat 状态、协议、控制面与持久化 | `chat` |
| `@fenix/workflow-engine` | DAG 工作流引擎、执行器、插件与恢复 | `workflow-runtime` |
| `@fenix/sandbox-provider` | 沙盒 Provider 抽象与集群客户端 | `sandbox` Provider SDK |
| `@fenix/opensandbox-cluster` | OpenSandbox 集群控制面 | `sandbox` 集群 Provider |
| `@fenix/remote-runtime` | 远程 Relay runtime | `agent-nodes` 远程运行时插件 |
| `@fenix-agent/acp-runtime-cli` | 远端 ACP bridge 注册 CLI | `agent-nodes` 部署产物 |
| `@fenix/claude-code` | Claude Code 引擎实现 | Agent 引擎插件 |
| `@fenix/opencode` | OpenCode 引擎实现 | Agent 引擎插件 |
| `@fenix/ccb` | CCB 引擎实现 | Agent 引擎插件 |
| `@fenix/model-gateway-sdk` | 模型网关公共契约 | `model-gateway` SDK |
| `@fenix/model-gateway-litellm` | LiteLLM 网关适配器 | `model-gateway` 插件 |
| `@fenix/logger` | 结构化日志 | `platform-kernel` |

## 拆分时必须保持的跨模块边界

| 边界 | 不可拆散的事实 | 建议契约 |
| --- | --- | --- |
| Agent 配置 → 运行时 | 配置只描述资源引用；运行时必须在启动边界解析、校验并生成独立 LaunchSpec | `AgentLaunchSpec` 与资源 resolver 接口 |
| 实例编排 → 引擎 | 编排拥有实例生命周期与并发/回收；引擎只负责准备环境、启动、停止和连接 Relay | `EnginePlugin`／`EngineRuntime` |
| ACP → Chat | ACP 是 Agent 协议权威来源；Chat 负责状态投影和 Y.Doc，不得复制 JSON-RPC 栈 | Relay 消息与 Chat Channel action/event 协议 |
| 环境/机器/沙盒 → 文件 | 工作区路径由认证后的环境解析；远程机器不可用时不得回落本地文件系统 | `resolveWorkspacePath` 与 FileBackend 接口 |
| 组织/授权 → 所有资源 | 每个资源操作必须带活动组织上下文，并在服务边界执行成员/可见性校验 | Organization context 与 ResourcePermission policy |
| 工作流 → Agent | 工作流复用实例编排与 Agent Chat transport，不得另建 Agent session 协议 | `ensureRunning`、`connectAgentRelay`、`PromptTurn` |
| AppBuilder → 模块 | AppBuilder 只装配模块提供的路由、生命周期钩子、迁移、前端导航与能力声明；不持有业务规则 | `ModuleManifest`、生命周期 hook、route/navigation contribution（待设计） |

## 盘点覆盖说明

- 已纳入无独立路由但会影响系统行为的模块：实例编排、引擎插件、ACP Relay、Chat/YJS、环境、Machine/Agent Node、沙盒、工作区与文件、数据迁移、缓存、事件传输、启动装配、日志与错误治理。
- 已将同一领域的多入口合并为一个模块，例如 Skill 的控制台 API、外部 API、下载路由、文件归档与引擎安装；避免把同一能力按路由重复拆包。
- `src/utils/`、`src/types/`、`src/test-utils/`、前端基础组件、OpenAPI schema 等属于各模块的共享实现或开发支撑，不单列为可安装业务模块；其运行时责任已在对应模块的「当前主要实现位置」中归属。
- 表中「建议角色」是目标拆分建议，不代表当前已经存在相应包或插件清单；具体的模块 Manifest、依赖图、安装顺序和迁移方案应在下一阶段单独设计。
