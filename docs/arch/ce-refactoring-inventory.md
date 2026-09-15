# CE AgentConfig 重构现状清单与首个闭环冻结契约

> 事实基线：`7ed74cac8684bac6466cbfc17bb6746839f3f497`。第 1 至 13 节记录该 revision 的生产源码与既有测试所呈现的事实；第 14 节保留 ARC-03 的目标契约，供逐包适配分析参考。阶段 1 以实际运行代码和既有测试为权威，不得依第 14 节改接口、权限、数据或前端流程。发布规则改为先完成可上线的物理分包，再由用户决定逐包适配顺序，详见 ADR-0001。
>
> 相对初始盘点提交 `ba8ab4d1737634b62042290c1735be8744d947bb`，该基线没有改变 `src/`、`web/` 中的 AgentConfig 生产行为；期间完成的 FND-00/FND-01 仅新增或调整设计文档、workspace manifest、app 空入口、TypeScript 配置与 CI 覆盖。逻辑 owner 和直接交接边界按该 revision 的最新设计重核。

## 1. 范围、证据与术语

证据优先级：可执行测试与生产源码 > `src/db/schema.ts` > 当前架构清单 `FUNCTIONAL_MODULE_INVENTORY.md` > 目标目录归属文档 `docs/design/ce-ee-refactoring/ce-ee-engineering-directory-structure.md`。迁移任务在对应阶段 plan 中，目标规范另见 `docs/design/ce-ee-refactoring/ce-ee-engineering-standards.md`；这些文档都不能反向解释当前业务行为。

本文中的 `platform`、`agent`、`resources/agent-config`、`apps/server`、`apps/web` 是批准的**逻辑 owner 标签**，不是第 1 至 13 节事实基线中的当前仓库路径。基础平台签名与拒绝语义由 ARC-02 冻结；AgentConfig、Agent runtime/instance 和强依赖资源的公开接口与目标路径由第 14 节冻结。本文引用的其余反引号路径均在事实基线存在。

第 1 至 13 节盘点的非目标：不修改生产行为、schema/migration、workspace/package、前端；不决定角色写权限与平台拒绝语义，不展开实例/session/relay/cancel/timeout 生命周期。上述待决项中属于 ARC-03 的部分已在第 14 节关闭；runtime 生命周期仍以 `docs/arch/agent-runtime-extraction-map.md` 为权威来源。

| 术语/标识 | 当前含义 | 证据与迁移注意 |
| --- | --- | --- |
| AgentConfig ID | `agent_config.id`，UUID PK；外部 CRUD、绑定、Environment、任务和运行入口使用 | `src/db/schema.ts`、`src/routes/api/agents.ts`；应沿用，不无故重编号 |
| name | `(organization_id,name)` 唯一的可变展示/历史操作键 | Web CRUD、Meta Agent、默认项仍使用；不是稳定资源 ID |
| resourceKey | `${sourceOrganizationId}/${agentConfigId}`，共享详情/写断言可接受 | `src/services/config/agent-config.ts`；外部资源只读 |
| Environment ID | `environment.id`，`env_*` 字符串；Chat 路由中的 `agentId` 实际为它 | `src/services/environment-web.ts`、`web/src/routes/agent/_panel/chat.$agentId.tsx`；不可机械改成配置 ID |
| Instance/会话 ID | Instance 是运行产物；ACP/YJS 标识不属于 AgentConfig 资源标识 | 仅在本清单记录配置到 LaunchSpec 的交接，生命周期另行盘点 |

## 2. 当前数据面

### 2.1 主记录与聚合内关系

| 表/字段 | 关系、删除语义与数据 | 当前读写方 | 逻辑 owner / 后续 task | 风险 |
| --- | --- | --- | --- | --- |
| `agent_config` | UUID PK；`user_id` FK cascade；`organization_id`；组织内 name 唯一；`model_id` FK set-null；`machine_id` FK set-null；`agent_node`/`extra` JSON；`model` 已标废弃 | `src/services/config/agent-config.ts`、`src/repositories/agent-config.ts`、`src/services/launch-spec-builder.ts` | `resources/agent-config`; DAT-01/RES-01 | 属性、归属和授权仍耦合；name CRUD；JSON 引用缺少 FK |
| `agent_config_skill` | `(agent_config_id,skill_id)` 唯一；两端 FK cascade | `src/services/config/agent-config-skill.ts` | `resources/agent-config`（绑定边界）；REF-02/DAT-01 | 全量替换为先删后插，非事务、并发丢更新 |
| `agent_config_mcp` | `(agent_config_id,mcp_server_id)` 唯一；两端 FK cascade | `src/services/config/agent-config-mcp.ts` | `resources/agent-config`（绑定边界）；REF-03/DAT-01 | 同上 |
| `agent_config_site_app` | `(agent_config_id,site_app_id)` 唯一；两端 FK cascade；也有幂等单项增删 | `src/services/config/agent-config-site-app.ts` | `resources/agent-config`（绑定边界）；ENV-01/DAT-01 | route 做组织校验，底层原子操作不鉴权 |
| `agent_knowledge_binding` | 配置与知识库双 FK cascade；唯一对；priority/enabled/config | `src/services/agent-knowledge.ts`、`src/repositories/knowledge-base.ts` | `resources/agent-config`（绑定边界）；REF-04/DAT-01 | 与主写、其他 bindings 无聚合事务 |
| `agent_memory_config` | 配置 FK cascade，一对一，enabled | `src/repositories/agent-memory-config.ts`、`src/services/agent-memory.ts` | `resources/agent-config`（配置边界）；REF-04/DAT-01 | 创建/更新中的独立写可留下部分状态 |
| `resource_permission` | 多态 `(resource_type,resource_id)` 文本引用；当前 action 只有 read；all/org principal | `src/services/resource-permission.ts`、`src/repositories/resource-permission.ts` | `platform`; PLT-01/DAT-01 | 无 AgentConfig FK，删除可遗留 grant |

### 2.2 入站引用与隐式引用

| 来源 | 当前引用语义 | FK/删除 | 逻辑 owner / 调用方与处置 task |
| --- | --- | --- | --- |
| `environment.agent_config_id` | 配置 ID；同组织/用户/配置仅一个非空 Environment | FK set-null；AgentConfig service 实际先删关联 Environment | `agent`（Environment/Instance）+ `resources/agent-config`（删除编排）；`src/services/environment-web.ts`、`src/services/api-instance.ts`; ENV-01 |
| `scheduled_task_v2.agent_id` | 名称虽为 agentId，实际是 AgentConfig UUID | FK set-null | `apps/server`（自动化调用方）；`src/services/task-v2.ts`、`src/services/scheduler/agent-executor.ts`; RES-01 后重接 |
| `model_gateway_credential.agent_config_id` | 组织+用户+配置的运行凭证映射 | **无 FK** | `resources/agent-config`（引用契约）；`src/services/model-gateway/credential-service.ts`、`src/services/model-gateway/runtime.ts`; REF-01 |
| `agent_site_app.created_by_agent_config_id` | 创建者配置 ID | FK set-null | `apps/server`（Site 调用方）+ `resources/agent-config`（引用契约）；`src/routes/web/agent-sites.ts`; ENV-01 |
| `prod_view.agent_id` | AgentConfig UUID | FK cascade | `apps/server`（ProdView 调用方）；`src/services/prod-view.ts`、`src/repositories/prod-view.ts`; ENV-01/WEB-REF-01 |
| `user_config.*` | 已废弃的用户偏好 | 历史表 | 不迁入新 package、不修改 schema 或逻辑；清理旧配置接口时连同表与无调用方前端代码一并删除 |
| `resource_permission.resource_id` | AgentConfig UUID 的文本多态引用 | 无 FK | `platform`; PLT-01/DAT-01 迁移 grant 与 orphan 校验 |
| `agent_config.agent_node` | machine 或 sandboxPool ID 的 JSON 判别联合；另有历史 `machine_id` FK | JSON 无 FK | `resources/agent-config`（持久化引用）+ `agent`（运行解析）；`src/services/config/agent-config.ts`、`src/services/environment-web.ts`; ENV-01 |
| Machine 注册匹配 | `machine.agent_name` 驱动配置 machine 绑定，形成 name 耦合 | 无 AgentConfig FK | `agent`; `src/services/registry.ts`; ENV-01 |
| Legacy channel | `channel_binding.agent_id` 实际承载 Environment ID，不是配置 ID | varchar，无 FK | `apps/server`（协议调用方）；`src/services/channel-binding.ts`、`src/repositories/channel-binding.ts`; 保留协议并重接 |
| Workflow 定义/transport | transport 参数名 `agentId`，宿主实现按 Environment name 查找和复用实例 | JSON/接口，无配置 FK | `apps/server`（自动化调用方）+ `agent`（实例端口）；`src/services/workflow/agent-chat-transport.ts`、`packages/workflow-engine/src/transport/transport.ts`; 保留并重接 |

固定基线扫描未发现另一张直接 FK 到 AgentConfig 的现行表。动态 JSON、导入数据和外部消费者无法靠 FK 枚举；各引用迁移 task 在切换前必须对自身历史数据和 payload 做可审计扫描，DAT-01 不集中改写这些引用。

## 3. 当前后端数据流与职责

### 3.1 CRUD、run 与 delete

```text
Web /web/config/agents (name/resourceKey, envelope)
  -> src/routes/web/config/agents.ts (鉴权、校验、直接资源展示查询、bindings 编排)
  -> src/services/config/agent-config.ts + agent-config-{skill,mcp,site-app}.ts
  -> src/db/schema.ts / resource_permission / knowledge / memory

External /api/agents (ID, direct DTO)
  -> src/routes/api/agents.ts
  -> 同一旧 service；PUT/DELETE 先 ID scoped lookup，再转换为 name 调旧写方法
```

当前没有统一 run action：

| 入口 | 配置到 runtime 的交接 | 实例策略/权限边界 | 测试 |
| --- | --- | --- | --- |
| `POST /api/agents/:agentId/instances/connect` | `src/routes/api/instances.ts` -> `src/services/api-instance.ts` -> Environment -> controller | 先按请求 AuthContext 检查可读；当前用户独立 Environment；可复用运行实例 | `src/__tests__/api-instance-routes.test.ts` 覆盖共享配置成功和错误映射；`src/__tests__/api-instance-service.test.ts` 仅覆盖启动来源透传 |
| `POST /api/agents/:agentId/v1/chat/completions` | `src/routes/api/openai-chat.ts` -> `src/services/agent-chat-service.ts` -> Environment -> controller | 每次独立实例，结束 dispose；运行构建处再次检查可读 | `src/__tests__/openai-chat-routes.test.ts`、`src/__tests__/openai-chat-service.test.ts`、`src/__tests__/agent-chat-service-boundaries.test.ts` |
| Web Environment/Instance | `src/routes/web/environments.ts` -> `src/services/environment-web.ts`; Chat 再经共享 runtime | 创建/更新 Environment 时检查配置可读；交互路径按 Environment/用户隔离 | `src/__tests__/environment-web-create.test.ts`、`src/__tests__/environment-web-list.test.ts` |
| runtime recheck | `src/services/orchestration-instance.ts` -> `src/services/launch-spec-builder.ts` -> Core | controller 分配后、Core launch 前基于 Environment 组织再次读检查；失败进入统一回滚 | `src/__tests__/orchestration-instance-rollback.test.ts` 覆盖 launch/register 失败回滚，但不直接覆盖撤权复检 |

LaunchSpec 当前直接解析：model/provider 与网关凭证、Skill 源目录/归档/下载 URL、MCP 配置、knowledge MCP、memory/Hindsight、prompt、Environment secret、Machine/Sandbox 节点和进程 env。`src/services/launch-spec-builder.ts` 明示默认上游已鉴权，资源校验与持久化读取仍混在 builder；AGT-02 应只消费 REF-01~04/ENV-01 的公开结果。

删除流：`src/services/config/agent-config.ts` 先查可写 -> 事务外收集关联 Environment 并调用 `src/services/orchestration-instance.ts` 停实例 -> DB 事务删除 Environment 与 AgentConfig。单实例 stop 失败会记录后继续；收集级失败阻断删除；DB 失败时实例可能已停但数据仍在。FK cascade 清 bindings/knowledge/memory/prod view，set-null 清部分引用；permission 和 gateway credential 无 FK，存在 orphan 风险。

### 3.2 完整后端调用方分组

| 调用方组 | 当前文件 | ID/行为 | 逻辑 owner / 处置 |
| --- | --- | --- | --- |
| CRUD/模板/默认 | `src/routes/web/config/agents.ts`、`src/routes/api/agents.ts`、`src/services/meta-agent.ts` | Web/name、API/ID->name、Meta/name upsert | `resources/agent-config`; RES-01；旧资源路径 must-delete，Meta 重接 ID facade |
| Environment/Instance | `src/routes/web/environments.ts`、`src/services/environment-web.ts`、`src/routes/api/instances.ts`、`src/services/api-instance.ts` | 配置 ID -> 用户 Environment -> Instance | `agent` + `resources/agent-config`; ENV-01/RES-01；保留并重接 |
| HTTP 单轮/调度 | `src/routes/api/openai-chat.ts`、`src/services/agent-chat-service.ts`、`src/services/scheduler/agent-executor.ts`、`src/routes/web/tasks-v2.ts` | 配置 ID -> 独立 session | `apps/server`（协议/调度）+ `agent`（执行）；外部契约待决定，调度保留并重接 |
| Workflow/Chat | `src/services/workflow/agent-chat-transport.ts`、`src/services/chat-channel-bootstrap.ts`、`packages/chat-channel/src/channel/gateway.ts` | 经 Environment 复用实例；Chat 的 agentId 是 Environment ID | `apps/server`（装配）+ `agent`（实例端口）；保留并重接，不得复制协议栈 |
| Runtime/build | `src/services/orchestration-instance.ts`、`src/services/launch-spec-builder.ts`、`src/repositories/agent-config.ts` | 配置/绑定/依赖 -> LaunchSpec | `agent`（runtime）+ `resources/agent-config`（已授权配置）；AGT-01/02 + REF/ENV；旧 builder/repo 最终删除或重接 |
| Site/ProdView | `src/routes/web/agent-sites.ts`、`src/services/agent-sites.ts`、`src/services/prod-view.ts`、`src/routes/web/config/prod-views.ts` | 配置 ID 做绑定、创建者和展示入口 | `apps/server`（调用方）+ `resources/agent-config`（引用契约）；ENV-01/WEB-REF-01；保留领域并重接 |
| Model gateway | `src/services/model-gateway/credential-service.ts`、`src/services/model-gateway/runtime.ts`、`src/routes/api/system-model-gateway.ts` | 配置 ID 是凭证 subject/展示维度 | `apps/server`（运行适配）+ `resources/agent-config`（引用契约）；REF-01；保留并重接，清 orphan |
| File/ACP/Machine | `src/services/remote-file-service.ts`、`src/transport/acp-ws-handler.ts`、`src/services/registry.ts` | Environment -> 配置 node；machine 注册按 name 绑定 | `agent`; ENV-01/AGT-02；协议保留并重接 |
| Observer | `src/services/observer/observer-service.ts`、`src/repositories/agent-config.ts` | 配置 ID -> 展示名/host machine | `apps/server`（装配）+ 独立 Observer 服务；INT-01；保留观测并重接 |
| Knowledge/MCP/memory | `src/services/agent-knowledge.ts`、`src/services/knowledge-runtime.ts`、`src/routes/mcp/knowledge.ts`、`src/services/agent-memory.ts` | 配置绑定和运行解析 | `resources/agent-config`（绑定/调用边界）；REF-03/04；资源归各自 owner，AgentConfig 只用公开 service |

## 4. 认证、授权与租户边界

| 边界 | 当前事实 | 风险/待冻结项 |
| --- | --- | --- |
| 认证顺序 | `src/plugins/auth.ts` 先 session cookie；失败后同一 token 入口先 Environment secret、再 better-auth API key | Environment secret 可形成 member/owner 推导；ARC-02 冻结主体来源与优先级 |
| API key | 从 key metadata 恢复 org/role，并重新查成员；异常或非成员保守拒绝 | role 来自 metadata；需 EE-C 确认替换边界 |
| active org | `src/services/org-context.ts`：header -> query -> cookie；指定 org 无成员时可能 fallback 首个组织，并有 60s user cache | fallback/caching 是租户混淆风险；ARC-02 决定是否 fail-closed |
| 未认证 | 所有上述 route 使用 `sessionAuth`; 当前返回 401 `{error:{type:"unauthorized",message:"Not authenticated"}}`，handler/service 不执行 | route 声明多要求 `error.code`，实际 body 使用 `type`；目标 envelope 待定 |
| list/read | 本组织行 + `resource_permission` 显式 external read；service 再装饰 ownership/writable | 没有独立 `use` action；外部 rows 的 ID 获取后在 service 过滤，不是统一查询约束 |
| write | `assertInternalWritable` 只比较 owner organization；role、creator 不参与；外部共享只读 | PLT-01/ARC-02 决定角色/动作，repository 必须消费声明式 scope |
| run | connect 在 Environment/runtime 副作用前检查；orchestration 在 Core launch 前二次检查 | 当前以 read 充当 use；TOCTOU 仅靠二次检查缓解，目标由 ARC-02/RES-01 冻结 |
| 越权隐藏 | unreadable get/run 通常 404；Web external update/delete 403；`/api` update/delete 因组织 scoped lookup 为 404 | 是否统一 403/404 是契约决定，不在 ARC-01 修复 |

**EE-C 边界确认（2026-09-08）：** 身份认证、主体/租户上下文与授权实现属于可整体替换的 `platform`；资源模块仅通过冻结契约获取 context/query constraint/authorize，并保留业务状态与 `use` 编排；runtime 只接收已授权启动参数，不读取 actor、role、organization 或资源表。上表的认证次序、active-org fallback 和平台拒绝语义由 ARC-02 冻结；AgentConfig 的 read/write/use、403/404、DTO 与 route 契约由 ARC-03 冻结。现有 `/api/*` 只登记为待决外部契约或保留并重接，不在 ARC-01 承诺删除。

## 5. 当前公开行为与错误形状

| 接口 | 标识/成功形状 | 当前主要失败 |
| --- | --- | --- |
| `GET /web/config/agents` | 无 name：`{success:true,data:{default_agent,agents}}`；有 name/resourceKey：详情 envelope | 401 auth shape；详情不可读/不存在 404 `NOT_FOUND` |
| `POST /web/config/agents` | `{name,data}`；成功 envelope；service 实际 conflict-upsert | 400 validation，409 duplicate，绑定失败可能主记录已写 |
| `PUT /web/config/agents?name=...` | name/resourceKey + `{data}`；字段白名单；同步 bindings | 400 missing/invalid，403 external，404 missing |
| `DELETE /web/config/agents?name=...` | success envelope with null | 403 built-in/external，404 missing；stop/DB 部分失败见风险表 |
| `GET /web/config/agents/templates`、`POST /web/config/agents/default` | 模板；默认值保存 **name** | 401；default missing 404 |
| `GET /api/agents` | 直接 `{items,total,page,pageSize}`；先取全量可读项再内存分页 | 401 auth shape；无统一 Web envelope |
| `GET /api/agents/:id` | 直接详情，允许 external read | 401；不可读/不存在 404 |
| `POST /api/agents` | 直接 body/详情；同步 knowledge/Skill/MCP | 400、409、500 reload；无聚合事务 |
| `PUT/DELETE /api/agents/:id` | 路径 ID，但内部按 name 更新/删除 | 跨组织/不存在 404；built-in delete 403 |
| `POST /api/agents/:id/instances/connect` | `{agentConfigId,environmentId,instanceId,relay:{wsUrl}}` | 404 unreadable；409 concurrency；422 build；503 node/sandbox；500 脱敏兜底 |
| `POST /api/agents/:id/v1/chat/completions` | OpenAI-compatible stream/non-stream；仅最后 user message；可带 ACP session header | OpenAI error shape；404 config；409/429 quota；503 node；504 timeout；SSE 后置错误为脱敏 chunk |

### 5.1 经测试 fixture 脱敏重建的样例

以下不是 live 日志或客户数据，不含 token、Cookie、Environment secret、模型/MCP 凭证：

```json
{"success":true,"data":{"default_agent":null,"agents":[]}}
{"error":{"type":"unauthorized","message":"Not authenticated"}}
{"agentConfigId":"agc_demo","environmentId":"env_demo","instanceId":"inst_demo","relay":{"wsUrl":"/acp/relay/env_demo?instanceId=inst_demo"}}
{"error":{"code":"NOT_FOUND","message":"Agent not found"}}
```

## 6. 前端调用方与体验

| 分组 | 当前文件 | 行为/边界 | 逻辑 owner / 处置 |
| --- | --- | --- | --- |
| API client | `web/src/api/agents.ts` | 全走 `/web/config/agents`；get/set/delete 用 name；存在 `del`/`delete` 双别名 | `resources/agent-config`（Web client）；WEB-02 must-delete，不留 shim |
| 路由与管理页 | `web/src/routes/agent/_panel/agents.tsx`、`web/src/pages/agent-panel/pages/AgentManagementPage.tsx` | list + Environment join；创建/编辑/进入；部分可见文本硬编码 | `resources/agent-config`（页面）+ `apps/web`（薄 route）；WEB-02 迁移 |
| 聚合表单 | `web/src/pages/agent-panel/AgentFormDialog.tsx` | 同时加载/写 model、KB、Skill、MCP、memory、Machine、Sandbox、Site、Environment/Instance | `resources/agent-config`; WEB-02 + WEB-REF-01；拆资源 client，保留完整异步状态 |
| 首页创建 | `web/src/pages/agent-panel/pages/AgentHomePage.tsx` | templates -> create；缺 ID 时按 name reload；再建 Environment | `resources/agent-config`; WEB-02 改稳定 ID 流程 |
| Shell/树/布局 | `web/src/pages/agent-panel/AgentPanelLayout.tsx`、`web/src/pages/agent-panel/AgentSidebarTree.tsx`、`web/src/pages/agent-panel/AgentSidebarConfig.tsx` | 活动布局组合导航与 Chat；SidebarTree 以 15s 周期读取 AgentConfig/Environment，并执行进入、重启、停止和 name 删除 | `apps/web`（Shell）+ `resources/agent-config`（业务片段）；Shell 保留并改 contribution，AgentConfig 业务代码由 WEB-02 迁移 |
| 未挂载旧壳 | `web/src/pages/agent-panel/AgentAppShell.tsx`、`web/src/pages/agent-panel/AgentPanelPage.tsx`、`web/src/App.tsx` | 当前生产入口未导入；仍被部分测试或源文件保留，不能当作活动调用链证据 | `apps/web`; 新 Shell 验收后以 import/build/search 证明无调用，再删除旧壳及对应过时测试 |
| Task | `web/src/pages/agent-panel/pages/AgentTasksPage.tsx`、`web/src/pages/agent-panel/components/TaskForm.tsx`、`web/src/api/tasks-v2.ts` | list 作为 AgentConfig ID selector | `apps/web`（调用方）；调度 UI 保留并重接新 DTO |
| ProdView | `web/src/pages/agent-panel/pages/AgentProdViewsPage.tsx`、`web/src/pages/agent-panel/ProdViewsPanel.tsx`、`web/src/api/prod-views.ts` | ID selector/display lookup | `apps/web`（调用方）；ProdView 保留并重接 |
| Site/Artifacts | `web/src/pages/agent-panel/ArtifactsPanel.tsx`、`web/src/components/agent-panel/AgentSitesCard.tsx`、`web/src/api/sites.ts` | 配置 ID 绑定 Site；全局 select-site 事件 | `apps/web`（调用方）；Site 保留并重接 |
| Chat | `web/src/routes/agent/_panel/chat.$agentId.tsx`、`web/src/pages/agent-panel/ChatArea.tsx` | URL `agentId` 是 Environment ID；消费 reconnect/site 事件 | `apps/web`（调用方）；Chat/YJS 保留并重接，禁止 ID 机械替换 |
| 事件/i18n | `web/src/lib/config-events.ts`、`web/src/i18n/locales/en/agents.json`、`web/src/i18n/locales/zh/agents.json`、`web/src/i18n/locales/en/agentPanel.json`、`web/src/i18n/locales/zh/agentPanel.json`、`web/src/i18n/locales/en/components.json`、`web/src/i18n/locales/zh/components.json` | `rcs:config-change`、`agent:reconnect`、`artifacts:select-site`；key 跨 namespace | `apps/web`（共享）+ `resources/agent-config`（专属 key）；只删 AgentConfig-owned key，共享 namespace/事件调用方先重接 |

现有页面覆盖 loading/empty/toast 的部分路径，但依赖失败语义不一致（整体失败与静默空数组并存），无完整 create/edit/delete/run/unauthorized/retry 浏览器流程测试；这是 WEB-02/INT-01 验收缺口。

## 7. 原子性、并发和失败现状

| 风险点 | 当前行为 | 回滚/观测边界 |
| --- | --- | --- |
| create | 主记录是 upsert；grant、memory、knowledge、Skill/MCP/Site 分步写 | 中途失败可留部分聚合；没有统一补偿 |
| update | 主记录后分步替换 bindings；不同 route 覆盖集合不同 | 并发覆盖/部分状态；无版本/CAS |
| binding replace | Skill/MCP/Site 为 delete-then-insert | 两语句间为空；并发最后写/混写风险 |
| list | Web route 逐配置取 bindings/展示资源；展示查询异常 catch 后退为 ID | 错误被降级但无诊断；外部 API 内存分页 |
| delete | stop 在事务外；DB 事务仅 Environment+AgentConfig；逐实例 stop 失败不阻断 | 已停+DB 保留可重试；也可能有残余实例；grant/credential orphan |
| runtime access recheck | controller 分配后构建阶段二次可读检查；失败进入统一回滚，Core launch 位于检查之后 | 现有 rollback 测试不直接制造“权限被撤销”场景；稳定边界需后续 task 补证，生命周期细节归 AGT-00 |

## 8. 测试证据等级与缺口

| 等级 | 当前证据 | 能证明 | 不能证明 |
| --- | --- | --- | --- |
| L1 纯规则 | `src/__tests__/agent-config-validators.test.ts`、`src/__tests__/agent-config-build-set.test.ts`、`web/src/__tests__/agent-form-dialog-pure-logic.test.ts` | 字段校验/转换 | route、DB、用户流程 |
| L2 route + stub | `src/__tests__/round44-agent-config-routes.test.ts`、`src/__tests__/api-agents-routes.test.ts`、`src/__tests__/api-instance-routes.test.ts`、`src/__tests__/openai-chat-routes.test.ts` | 已认证 CRUD/list 形状、共享读取、主要错误映射 | AgentConfig route 未认证矩阵、真实 service/DB/runtime |
| L3 service + fake persistence/deps | `src/__tests__/config-agent-resource-access.test.ts`、`src/__tests__/agent-config-delete.test.ts`、`src/__tests__/agent-config-delete-stops-instances.test.ts`、`src/__tests__/api-instance-service.test.ts` | read scope、删除编排、interactive 来源透传 | PostgreSQL 约束/锁/事务并发，不可读 connect 的零副作用 |
| L4 runtime seam | `src/__tests__/agent-chat-service-boundaries.test.ts`、`src/__tests__/openai-chat-service.test.ts`、`src/__tests__/orchestration-instance-rollback.test.ts`、`src/__tests__/launch-spec-builder-errors.test.ts` | spawn/relay/rollback/LaunchSpec 错误边界 | 撤权复检专门场景、真实 Core/Agent/relay/YJS |
| L4 API-key regression | `src/__tests__/api-agents-apikey-regression.test.ts` | API key 正向组织上下文 | 完整主体/角色/跨组织矩阵 |
| 前端逻辑/SSR | `web/src/__tests__/agent-resource-access-flow.test.ts`、`web/src/__tests__/agent-form-dialog-options-boundaries.test.tsx`、`web/src/__tests__/agent-form-dialog-ssr.test.tsx` | helper、选项边界、初始渲染 | 浏览器 E2E 和完整异步状态 |
| L5 缺失 | 无 | 无 | 真实 PostgreSQL/迁移、真实 Engine/relay、浏览器 CRUD+run、并发写、升级/回滚 |

ARC-01 不新增或修改测试。明确缺口：Web 和外部 AgentConfig route 的未认证短路矩阵、不可读 connect 在 Environment/runtime 前零副作用、运行时撤权复检、role/write/use 矩阵、真实多租户 PostgreSQL 查询约束，以及浏览器 create/edit/delete/run/retry 流程。ARC-02/PLT-01 负责平台主体、scope 与授权契约，ARC-03 冻结 AgentConfig 协议及运行边界；实现与验证分别由 RES-01、AGT-02、WEB-02、INT-01 承接。

## 9. 可观测性与安全

`packages/logger/src/index.ts` 和 `src/plugins/logger.ts` 提供 Pino、ALS requestId/user/org、HTTP method/path/status/duration、慢请求分级和 `X-Request-Id`；`/web/config/agents` 轮询降为 debug。runtime/LaunchSpec 有 instance/config/resource 诊断日志。

当前范围不新增 AgentConfig 专属 audit recorder、CRUD/run/deny counter、latency histogram 或事务/补偿指标；出现明确的产品或运维需求时另立设计与任务。route CRUD 仍缺少统一 domain operation/resourceId 字段。`src/services/launch-spec-builder.ts` 的诊断可能包含资源 ID、Skill 路径、MCP command/URL/header/raw config；原始 Error 也可能带内部上下文。迁移时不得复制敏感值到响应、日志或样例。

INT-01 至少验证：HTTP 请求的 `requestId` 会写入结构化日志并通过 `X-Request-Id` 返回；run->instance、binding/迁移校验差异、rollback/stop 失败等诊断日志保留关联 ID；任何 token、Cookie、Environment secret、Provider/MCP secret、完整 prompt/file 内容必须脱敏。

## 10. 既有回归一次运行基线

- 行为采样 SHA：`4205a60955c41f017d19f169695d41311c1f6c62`；当前治理 revision：`7ed74cac8684bac6466cbfc17bb6746839f3f497`；Bun 1.4.2。
- 固定集合：11 个既有文件，覆盖 Web/API list/CRUD、共享读取、delete 清理、connect、OpenAI-compatible run、session 边界与 orchestration rollback。
- 命令：`LC_ALL=C /usr/bin/time -f 'elapsed_seconds=%e' bun test <上述 11 个既有测试文件>`；完整文件列表见第 8 节对应 L2-L4 条目。
- `4205a609` 行为采样结果：63 pass / 0 fail / 175 assertions；GNU wall-clock `0.83s`。此后 FND-01 未修改上述生产源码与测试，本记录用于重构前行为比较，不声明为当前 HEAD 的质量门结果。

### 10.1 已知全量门禁问题

- `bun run precheck` 在初始分支执行两次、合并 `4205a609` 后复验一次：format、import-sort、server/web TypeScript 均通过；lint 步骤退出成功但报告 4 个既有 warning；全量测试每次均为 8205 pass / 3 fail。
- 失败项分别位于 `src/__tests__/round46-knowledge-base-repository.test.ts`、`src/__tests__/round54-channels-routes.test.ts` 和 `web/src/__tests__/agent-form-dialog-ssr.test.tsx`；三个文件在本 worktree 中隔离运行分别为 34/24/3 pass、0 fail。
- 用户于 2026-09-08 确认这是全量测试共享状态或顺序污染的已知基线问题，与 ARC-01 文档清单无直接关系。本任务只保留验证证据，不修改生产代码或测试，也不将其并入 ARC-01 修复范围。

## 11. 历史责任、依赖与风险登记（旧任务依赖已撤销）

下表为 ARC-01 盘点当时的任务分配记录；已完成项继续保留，未完成项不再可领取，不能依其目标行为实施现行阶段 1。新任务以[协作计划的 PHY 闭包](../design/ce-ee-refactoring/ce-ee-refactoring-collaboration-plan.md)为准。

| Task | owner | 直接前置 | 本清单中的责任 |
| --- | --- | --- | --- |
| ARC-01 | CE task pool（本分支：liu xue yan） | 无 | 当前边界、调用方、风险、测试入口与删除条件 |
| AGT-00 | CE task pool | 无；可与 ARC-01、ARC-02 并行 | runtime 真实调用图与生命周期特征，不由本清单重复展开 |
| FND-00 | CE task pool | 无；已完成 | workspace 规则、最小 package manifest 与 README 物理骨架，不冻结公开契约 |
| FND-01 | CE task pool | FND-00；已完成 | workspace metadata、TypeScript 边界和 app 空入口，不迁移业务实现 |
| FND-02 | CE task pool | FND-01 | 包依赖边界 CI |
| FND-05 | CE task pool | FND-02 | 迁移 app 与构建/测试入口，不迁移资源领域代码 |
| ARC-02 | CE task pool + EE-C 确认 | 无；可与 ARC-01、AGT-00 并行 | 冻结 AccessControl、DB/transaction 与平台/应用基础契约 |
| FND-03 | CE task pool | FND-02、ARC-02 | manifest、registry、assembly 与 bootstrap |
| PLT-02 | CE task pool | FND-03 | PostgreSQL/Drizzle host 连接、事务与 migration runner 边界；暂不引入通用数据库抽象 |
| PLT-01 | CE task pool | ARC-02、FND-03、PLT-02 | `platform` AccessControl 与 scope，不让资源读取 member/role |
| PLT-04 | CE task pool | FND-03 | server env loader 与模块 env 注入 |
| ARC-03 | CE task pool + AgentConfig/依赖资源负责人确认 | ARC-01、ARC-02、AGT-00 | 冻结 AgentConfig、Agent、依赖资源的接口、路由与迁移范围 |
| DAT-01 | CE task pool，独占 migration journal | PLT-01、ARC-03 | AgentConfig 与既有聚合表 schema 归包；visibility expand/backfill |
| AGT-01 | CE task pool | AGT-00、FND-01、ARC-03 | 无权限 Agent runtime 与 InstanceManager |
| WEB-01 | CE task pool | FND-03、FND-05 | CE Shell、薄 route 和 Web contribution 装配，不创建资源页面 |
| REF-01 | CE task pool，独占 DB 锁 | PLT-01、DAT-01 | model/provider/credential 公开能力 |
| REF-02 | CE task pool，独占 DB 锁 | PLT-01、DAT-01 | Skill 与 archive 公开能力 |
| REF-03 | CE task pool，独占 DB 锁 | PLT-01、DAT-01 | MCP 与 launch config 公开能力 |
| REF-04 | CE task pool，独占 DB 锁 | PLT-01、DAT-01 | knowledge/memory 公开能力 |
| ENV-01 | CE task pool，独占 DB 锁 | PLT-01、DAT-01、AGT-01 | Environment/node/Site、删除清理与引用迁移 |
| AGT-02 | CE task pool | AGT-01、REF-01、REF-02、REF-03、REF-04、ENV-01 | 从公开资源结果组装完整 LaunchSpec |
| WEB-REF-01 | CE task pool | WEB-01、REF-01、REF-02、REF-03、REF-04、ENV-01 | 资源管理页、selector、route 与导航整合 |
| RES-01 | CE task pool，独占 DB 锁 | PLT-01、DAT-01、AGT-01、AGT-02、REF-01、REF-02、REF-03、REF-04、ENV-01 | AgentConfig facade/repository/`/web` route/run，唯一后端写路径 |
| WEB-02 | CE task pool | RES-01、WEB-01、WEB-REF-01 | AgentConfig 页面/client/caller 切换和旧 Web 删除 |
| INT-01 | CE task pool | FND-05、PLT-01、PLT-02、PLT-04、REF-01、REF-02、REF-03、REF-04、ENV-01、AGT-02、RES-01、WEB-02 | 空库/升级库、权限、CRUD/run、UI、日志/requestId 关联、补偿/回滚 E2E；M1 人工验收后继续阶段 4，不发布生产 |

| 风险 | 严重度 | 证据 | 必须满足的控制 |
| --- | --- | --- | --- |
| role 未参与写授权 / active-org fallback | 高 | `src/services/resource-permission.ts`、`src/services/org-context.ts` | ARC-02 + EE-C 明确语义；PLT-01 contract tests |
| 非事务聚合写/并发覆盖 | 高 | route 编排及三个 binding service | RES-01 事务边界、并发测试、失败补偿 |
| name 与混合 ID 语义 | 高 | Web CRUD/Meta、Chat Environment ID；废弃 default 偏好 | WEB/RES/ENV 对实际调用方逐项切换，禁止 alias；`user_config` 不迁移并随旧代码删除 |
| grant/credential orphan | 高 | 无 FK 文本/UUID 引用 | 数据校验、清理/约束方案、删除测试 |
| runtime 仍查资源与权限 | 高 | `src/services/orchestration-instance.ts`、`src/services/launch-spec-builder.ts` | RES-01 `resolveForRun`; AGT-02 仅收已授权快照 |
| 外部 `/api` 合同兼容 | 高 | 当前可用 CRUD/connect/OpenAI 入口 | ARC-03 第 14.5 节已冻结 M1 去留；最终退役必须独立 ADR，不擅删或形成第二写路径 |
| 日志敏感数据与关联不足 | 中高 | LaunchSpec 日志、generic HTTP logger | 复用 `@fenix/logger` 与 `requestId`；INT-01 验证脱敏和诊断关联 |
| 真实 DB/runtime/browser 证据缺失 | 中高 | 测试等级表 | DAT/AGT/WEB/INT tasks 补 E2E 与升级演练 |

## 12. 历史删除台账（阶段 1 只删除已搬移的源文件）

下表原先用于先改协议、再删旧业务入口；这些新接口与删旧协议的前置在阶段 1 **不成立**。阶段 1 所有旧功能入口包括 Environment 和旧 `/web` 全部原样搬到最终 owner，旧源码在搬移且调用方更新后删除；阶段 3 再逐包审查表中目标删改是否适用。

### 12.1 历史 Must-delete（仅供阶段 3 评估，不是阶段 1 的删除清单）

| 旧资产 | owner/task | 删除前置与证据 | 回滚边界 |
| --- | --- | --- | --- |
| `src/routes/web/config/agents.ts` | `resources/agent-config`; RES-01 | `/web/agent-configs` CRUD/run 已验收；`web/src/api/agents.ts` 与所有调用方切走；旧 route search 为零；合同/权限测试绿 | 同一最终版本中只保留新 route；删旧写入口后不双写 |
| `src/services/config/agent-config.ts`、`src/services/config/agent-config-skill.ts`、`src/services/config/agent-config-mcp.ts`、`src/services/config/agent-config-site-app.ts` | `resources/agent-config`; RES-01 + REF/ENV | 所有 route/runtime/Meta/Site callers 改公开 service；事务/权限/删除测试等价 | 以新 facade 版本回滚，不加 shim |
| `src/repositories/agent-config.ts` | `resources/agent-config`; RES-01/AGT-02/Observer owner | runtime 和 Observer 改公开 DTO/port；无内部 import；LaunchSpec/Observer tests 绿 | 保留新公开 adapter，不保留双 repo |
| `web/src/api/agents.ts` | `resources/agent-config`（Web client）；WEB-02 | 页面、Sidebar、Task、ProdView、Home 全切 `/web/agent-configs` stable ID client；request tests/build 绿 | Web/server 作为同一最终版本切换和恢复 |
| `web/src/routes/agent/_panel/agents.tsx` 中旧 adapter 与 `web/src/pages/agent-panel/pages/AgentManagementPage.tsx`、`web/src/pages/agent-panel/AgentFormDialog.tsx`、`web/src/pages/agent-panel/pages/AgentHomePage.tsx` 的 AgentConfig-owned 实现 | `apps/web`（薄 route）+ `resources/agent-config`（页面）；WEB-02 | 新 contribution 覆盖 loading/empty/error/retry/unauthorized/success；浏览器关键流绿；Shell 不再导入 | 静态 contribution 版本回滚，不并存两页面 |
| `web/src/pages/agent-panel/AgentSidebarTree.tsx` 中 AgentConfig 业务片段及 AgentConfig-owned locale keys | `apps/web`（Shell）+ `resources/agent-config`（业务片段）；WEB-02 | Shell contribution 已重接；事件和 namespace 引用 search；仅删专属 key | 保留共享 Shell/namespace，不整文件盲删 |
| `src/db/schema.ts` 中旧定义位置 | `resources/agent-config`; DAT-01（旧任务） | 阶段 1 只搬 schema 源码且 SQL 零差异；增加 visibility 属阶段 3 独立治理 | 阶段 1 原迁移链与原 schema 保持一致 |

### 12.2 Retain-and-rewire（保留领域/协议，只替换依赖）

| 资产 | 原因 | 重接条件/owner |
| --- | --- | --- |
| Environment/Instance/ACP/Core：`src/services/environment-web.ts`、`src/services/api-instance.ts`、`src/services/orchestration-instance.ts`、`src/transport/acp-ws-handler.ts` | 独立 runtime/协议职责 | `agent`; ENV-01/AGT-01/02 接 stable ID、已授权 LaunchSpec；不复制 relay |
| Chat/YJS：`src/services/chat-channel-bootstrap.ts`、`packages/chat-channel/src/channel/gateway.ts` | 会话与协作域 | `apps/server`（装配）+ `agent`（实例端口）；改 Environment/Instance/配置展示 DTO，保持 ID 隔离 |
| Workflow/Scheduler：`src/services/workflow/agent-chat-transport.ts`、`src/services/scheduler/agent-executor.ts` | 自动化调用方 | `apps/server`（编排）+ `agent`（执行端口）；迁移 payload/ref，复用同一 run facade/runtime port |
| Site/ProdView/Channel/Model gateway | 独立资源或协议调用方 | `apps/server`（装配/调用方）+ `resources/agent-config`（公开引用契约）；对应 REF/ENV owner 完整 caller search/test |
| File 与远程 workspace | 独立执行与连接能力 | `agent`; 经 Environment/Instance 公开端口重接，不并入 AgentConfig repository |
| Observer | 独立观测职责 | `apps/server`（装配）+ Observer 服务；改用公开 AgentConfig DTO/port |
| Shared Shell/events/i18n namespace | 多领域共享 | `apps/web`（共享）+ `resources/agent-config`（专属 contribution/key）；删除专属项前确认无调用，保留 reconnect/select-site 等非配置语义 |

### 12.3 原 Contract-decision-required（已由 ARC-03 第 14 节关闭）

| 资产/冲突 | 必须决定 | 未决定前规则 |
| --- | --- | --- |
| `src/routes/api/agents.ts` | 外部 CRUD 是否退役、窗口、版本/限流/兼容义务 | 阶段 1 原样保留；阶段 3 退役须独立 ADR，见 14.5 |
| `src/routes/api/instances.ts` | connect 是否并入 `/web/agent-configs/:id/run`，复用/响应 DTO | 阶段 1 原样保留；阶段 3 若改动须外部合同决策，见 14.5 |
| `src/routes/api/openai-chat.ts` | OpenAI-compatible 合同与外部消费者 | 作为长期协议入口保留，保持协议响应并统一 use 边界，见 14.5 |
| auth/error | AgentConfig 403/404 与 `use` | 平台认证语义沿用 ARC-02；资源拒绝映射按 14.4 |
| ID/schema | name/resourceKey、Environment route `agentId`、workflow/channel payload | 稳定 ID 与 Environment 边界按 14.3、14.4、14.7；逐字段迁移，不做字符串批量替换；废弃的 `user_config` 不参与迁移 |

## 13. 开始/停止与删除判定

阶段 1 各闭包开始前：核实本清单事实基线与当前源码的差异，确认原 route、schema、页面、调用方、测试和最终 owner；按当前代码建立行为对照。不能在物理移动时加入数据回填或改新权限；阶段 3 各包开始前再参考 ARC-02、ARC-03 分析真实数据与协议影响。

立即停止并升级：需要生产行为修复但 task 未授权；身份/租户/use 或外部合同仍冲突；发现未分类调用方/数据引用；需要 live 凭证/客户数据；迁移无法幂等补偿；新旧写路径将并存；真实测试暴露与冻结基线不同；日志样例可能含敏感值。

阶段 1 旧文件仅在原实现已完整搬移且旧路径 caller search 为零后删除；旧 `/web`、`/api` 的协议和业务入口不删除。阶段 3 若需删除已有接口，应先核实消费者、生产观测和对应包的可上线兼容方案；外部 `/api` 需独立协议决策。不得创建 deprecated shim、alias、双写或 name->ID 转发来掩盖重复实现。

## 14. ARC-03 首个资源闭环冻结契约

> **状态：历史 ARC-03 目标契约，review 通过（2026-09-13）。** 以下公开接口、目标路由和数据治理属于阶段 2/3 的分析材料；旧 DAT/AGT/REF/ENV/WEB/RES/INT 任务和强制顺序已撤销。阶段 1 的原接口、Environment 页面、Provider 权限和数据均按现状保留；逐包适配时必须核对生产合同及 ADR-0001，不得把冻结目标当成迁移当下的改动许可。

### 14.1 唯一运行边界与依赖方向

AgentConfig 是唯一资源与授权边界。AGT-01 只机械迁移最终属于 Environment、Instance、Runtime 生命周期与 relay/session 组合的实现，不移动资源解析、Machine 或 Workflow 逻辑，不重排现有 `Environment → Instance → controller → builder → core` 控制流，也不合并两次 LaunchSpec 构建。M1 冻结一个阶段性宿主端口：

```text
可信执行主体 + agentConfigId
  → AgentConfigRunFacade：authorize(use)
  → @fenix/agent-runtime：按现有规则查找/创建 Environment、选择持久 Instance
  → HostLaunchSpecPort.build(environmentId, execution, source)
  → controller / core / relay / ACP session（保持既有顺序与失败释放）
```

AGT-01 保留当前两次 builder：随 controller 迁移的编排域 builder 仍在原调用点使用既有注入 repository port；`HostLaunchSpecPort` 只机械包装当前宿主 `buildAgentLaunchSpecForCore/buildLaunchSpec`，仍在第二个调用点生成 core spec。REF-01 至 REF-04、ENV-01 完成后，AGT-02 才用公开 resolver 的完整 spec 替换两条旧构建路径并删除重复资源查询。长期 `AgentInstanceStarter` 只接收完整 spec，但它是 AGT-02 的切换后边界，不要求 AGT-01 新增 preparation、lease 或 abort 状态机。任何提前合并 builder、改变 Environment/Instance 创建时点、Sandbox/Machine 分配释放或启动失败顺序的工作都必须另走 AGT-00 底层逻辑变更门禁。

下列 `AgentLaunchSpec` 直接使用现有 `@fenix/plugin-sdk` 根入口公开类型；AGT-01 不重新定义或改写它。

```ts
export type AgentInstanceId = string;
/** `@fenix/platform-sdk` 导出的无授权逻辑执行主体 DTO。 */
export interface RuntimeExecutionSubject {
  readonly scopeId: string;
  readonly ownerId: string;
  readonly source: "session" | "api-key" | "scheduler" | "workflow";
}
export interface HostLaunchSpecInput {
  readonly environmentId: string;
  readonly execution: RuntimeExecutionSubject;
  readonly source: "interactive" | "scheduled" | "system";
  /** 仅透传当前受信宿主调用方已经组装的覆盖；不得接受协议层原始输入。 */
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly requestId?: string;
}
export interface HostLaunchSpecPort {
  build(input: HostLaunchSpecInput): Promise<AgentLaunchSpec>;
}
export interface RuntimeRunInput {
  readonly agentConfigId: string;
  readonly execution: RuntimeExecutionSubject;
  readonly requestedInstanceId?: AgentInstanceId;
  readonly requestId?: string;
}
export interface InteractiveRunResult {
  readonly kind: "interactive";
  readonly agentConfigId: string;
  readonly environmentId: string;
  readonly instanceUid: AgentInstanceId;
}
export interface AgentPromptTurn {
  readonly instanceId: AgentInstanceId;
  readonly sessionId: string;
  prompt(content: readonly { readonly type: "text"; readonly text: string }[]): void;
  events(): AsyncIterable<unknown>;
  dispose(): Promise<void>;
}
export interface ExternalRelayResult {
  readonly agentConfigId: string;
  readonly environmentId: string;
  readonly instanceId: AgentInstanceId;
  readonly relay: { readonly wsUrl: string };
}
export interface AgentInstanceLifecycle {
  stop(input: { readonly instanceId: AgentInstanceId; readonly mode: "strict" | "best-effort" }): Promise<void>;
}
export interface RuntimeWebSocketPeer {
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
}
export interface ChatGatewayFacade {
  handle(input: {
    readonly execution: RuntimeExecutionSubject;
    readonly environmentId: string;
    readonly instanceUid: AgentInstanceId;
    readonly rcsSessionId: string;
    readonly peer: RuntimeWebSocketPeer;
  }): Promise<{ readonly dispose: () => Promise<void> }>;
}
export interface AgentRuntimeModule {
  readonly id: "agent-runtime";
  readonly interactive: { start(input: RuntimeRunInput): Promise<InteractiveRunResult> };
  readonly sessions: {
    open(input: RuntimeRunInput & { readonly mode: "api" | "workflow"; readonly acpSessionId?: string }): Promise<AgentPromptTurn>;
  };
  readonly externalRelay: { provision(input: RuntimeRunInput): Promise<ExternalRelayResult> };
  readonly instances: AgentInstanceLifecycle;
  readonly chatGateway: ChatGatewayFacade;
  bindHostLaunchSpecPort(port: HostLaunchSpecPort): void;
  dispose(): Promise<void>;
}
```

`RuntimeExecutionSubject` 的精确归属是 `@fenix/platform-sdk` 根入口；它只有宿主已认证后产生的不透明隔离键与来源，不包含 role、permission 或资源 scope 解释。`agent-runtime`、AgentConfig 和资源 resolver 只 type-import 这一共同 DTO，禁止互相反向依赖或各自复制“可信主体”类型。宿主从 session/API Key/Scheduler/Workflow 上下文构造它；任何 Domain Service 都不得从 AgentConfig owner 或资源 owner 回退生成。

`extraEnv` 保留当前 `spawnInstanceViaController → buildAgentLaunchSpecForCore` 的透传和“调用方覆盖 platform env”优先级，尤其保护 Meta Agent 与动态 Langfuse user 维度；它只能由宿主受信编排代码构造，route/WS body 不得直接写入。`source` 保留现有 `InstanceSpawnSource` 的三个取值；API 与普通交互当前仍映射为 interactive，Workflow 映射为 scheduled，不在 AGT-01 重新分类。

`bindHostLaunchSpecPort()` 在 module factory 全部创建、route/protocol contribution 挂载前完成且只能成功一次：依赖 `agent-runtime` 的宿主编排/AgentConfig module 在其 `create(context)` 中从 `context.modules.get("agent-runtime")` 取得实例并绑定当前 host port；未绑定时任何启动 fail-fast。它不要求 `agent-runtime` 反向依赖资源，也不假设 `ModuleFactoryContext` 存在未定义字段；bootstrap cleanup 只登记幂等 `dispose()`。

M1 interactive `run` 返回 `environmentId + instanceUid`，前端继续使用现有 `/acp/yjs/:environmentId`、`createDeterministicRcsSessionId(environmentId,userId,instanceUid)`、页面路由和文件接口。YJS route 继续由宿主认证，并由机械迁入 runtime 的现有 gateway 按 Environment organization/owner、requested Instance 与 RCS locator 做纵深校验；重连、多标签页 shared relay、Doc key、初始快照、背压和 Chat cancel 行为均不改变。无 Environment 的 `wsUrl/sessionLocator`、签名 locator 或新 attachment 协议明确不属于 M1，必须在机械提取稳定后另立任务和兼容设计。

API/Workflow 每次获得独立 `AgentPromptTurn`；dispose 释放 listener/relay，Workflow 同时释放 lease，均不停止复用的持久 runtime。API/Workflow abort/timeout 仍只取消本地等待，不发送 ACP cancel。external connect 继续返回现有 relay URL；`/acp/relay` 协议 route 留在宿主执行认证和关闭码映射，runtime 只承载属于自身的 handle/relay 控制流，并按当前 Environment/owner 校验建立连接；WS close/error 的 handle dispose 只做既有生命周期重接，不改变协议。

`scopeId` 必须来自本次可信执行主体的 active organization，`ownerId` 必须是执行用户，绝不取 AgentConfig resource scope/owner。public AgentConfig 只共享配置内容，不共享 Environment、Instance、workspace、Y.Doc、session 或 credential subject。session、API Key、Scheduler、Workflow 的恢复与重校验来源沿用上一轮冻结规则；INT-01 必须覆盖两个组织的用户使用同一 public 配置时所有运行数据隔离，以及恢复错误 fail-closed。

### 14.2 稳定 package、module、capability 与 contribution ID

| 领域 | workspace package / 公开入口 | module ID / kind | capability ID | server route contribution ID | Web contribution ID |
| --- | --- | --- | --- | --- | --- |
| Agent Runtime | `@fenix/agent-runtime`：`.` | `agent-runtime` / `agent-runtime` | `agent.runtime` | `agent-runtime.protocols`（仅协议贡献） | 无 |
| AgentConfig | `@fenix/agent-config`：`.`、`./web`、`./db` | `agent-config` / `resource` | `resource.agent-config` | `agent-config.routes` | `agent-config` |
| Model（Provider 聚合根 + Model 二级资源） | `@fenix/model`：`.`、`./web`、`./db` | `model` / `resource` | `resource.provider` | `model.routes`（挂载 Provider 与 Model 两组 route） | `model` |
| Skill | `@fenix/skill`：`.`、`./web`、`./db` | `skill` / `resource` | `resource.skill` | `skill.routes` | `skill` |
| MCP Server | `@fenix/mcp`：`.`、`./web`、`./db` | `mcp` / `resource` | `resource.mcp` | `mcp.routes` | `mcp` |
| Knowledge Base | `@fenix/knowledge-base`：`.`、`./web`、`./db` | `knowledge-base` / `resource` | `resource.knowledge-base` | `knowledge-base.routes` | `knowledge-base` |
| Agent Memory | `@fenix/agent-memory`：`.`、`./db` | `agent-memory` / `resource` | `resource.agent-memory` | 无独立管理 route | 无独立页面 |
| Machine | `@fenix/machine`：`.`、`./web`、`./db` | `machine` / `resource` | `resource.machine` | `machine.routes`（含既有 `/acp/ws`） | `machine` |
| Sandbox | `@fenix/sandbox`：`.`、`./web`、`./db` | `sandbox` / `resource` | `resource.sandbox` | `sandbox.routes`（含既有 `/acp/file-ws` 的宿主接线） | `sandbox` |
| Site App | `@fenix/site-app`：`.`、`./web`、`./db` | `site-app` / `resource` | `resource.site-app` | `site-app.routes` | `site-app` |

约束：

- ID 使用上述精确字符串；不添加 `ce-`、`default-`、`service-` 或版本后缀。现有 `@fenix/sandbox-provider`、`@fenix/opensandbox-cluster` 是 Sandbox 的 provider/adapter 依赖，不替代 `@fenix/sandbox` 资源 package。
- 根入口只导出 server DTO、Facade、Domain Service、resolver port、模块工厂和错误；`./web` 只导出浏览器安全 DTO/client/component/contribution；`./db` 只导出本包拥有的 Drizzle schema，供根 Drizzle 配置和 EE 外键使用。
- `agent-runtime` manifest 不依赖 `access-control` 或资源模块。`model`、`skill`、`mcp`、`knowledge-base`、`machine`、`sandbox`、`site-app` 依赖 `access-control`；`agent-memory` 依赖 `access-control`；`agent-config` 装配依赖 `access-control`、`agent-runtime` 及上述资源 module。装配依赖不改变 TypeScript 依赖方向。
- `deploy/assembly/ce.json` 在各实现任务进入 registry 后按上述 ID 启用；不得提前用空 manifest 或占位工厂伪造可启动组合。

Provider 是 `@fenix/model` 内的聚合根，Model 是严格继承所属 Provider 权限的二级资源。只有 Provider 注册 `ResourceDefinition` 与 `ResourceScopeStore`；Model 不拥有独立的 owner、visibility 或授权约束。Model 的列表和详情查询必须在数据库中关联 Provider，并在排序、分页和计数前下推 Provider 授权条件；Model 的引用、CRUD 和运行解析分别复用所属 Provider 的 read/use/update/delete 权限。

### 14.3 公开 Service、DTO 与 resolver port

所有 `*Facade` 接受 `actorId`，并在内部通过 `AccessControlModule.createActorContext()` 获得可信 actor；HTTP route 不传 role、scope 或 ownership。所有 `*Service` 是同一进程受信任的无 actor Domain Service，route 不得直接调用。每个资源根入口至少公开以下契约：

```ts
export interface RuntimeModel { readonly provider: string; readonly protocol: "openai" | "anthropic"; readonly baseUrl: string; readonly apiKey: string; readonly model: string; readonly displayName: string | null }
export interface RuntimeSkill { readonly id: string; readonly name: string; readonly url: string }
export type RuntimeMcpServer =
  | { readonly id: string; readonly name: string; readonly type: "stdio"; readonly command: string; readonly args: readonly string[]; readonly cwd?: string; readonly env: Readonly<Record<string, string>>; readonly timeoutMs?: number }
  | { readonly id: string; readonly name: string; readonly type: "streamable-http"; readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly oauth: false | { readonly clientId?: string; readonly clientSecret?: string; readonly scope?: string; readonly redirectUri?: string }; readonly timeoutMs?: number };
export interface RuntimeKnowledge { readonly mcpServer: RuntimeMcpServer; readonly policy: AgentKnowledgePolicy }
export interface RuntimeMemory { readonly provider: "hindsight"; readonly configuration: Readonly<Record<string, string>> }
export type RuntimeNodeSelection = { readonly kind: "local" } | { readonly kind: "machine"; readonly machineId: string } | { readonly kind: "sandbox"; readonly sandboxId: string; readonly machineId: string };
export interface RuntimeSiteApp { readonly id: string; readonly remoteAppId: string | null }
```

| package | 对外 Facade / 无权限 Service | AgentConfig 写入校验 port | 运行解析 port 与返回 DTO |
| --- | --- | --- | --- |
| `@fenix/model` | `ProviderFacade`、`ProviderService`、`ModelFacade`、`ModelService` | `ProviderReferenceResolver.resolveVisible({actorId, providerIds})` → `ProviderSummary[]`；`ModelReferenceResolver.resolveUsable({actorId, modelId})` → `ModelSummary` | Provider 密钥不单独向 AgentConfig 暴露；`ModelRuntimeResolver.resolve({modelId,agentConfigId,execution})` → `RuntimeModel`，DTO 含 protocol/model/baseUrl/受控 credential，credential 不进入 Web、日志或持久快照 |
| `@fenix/skill` | `SkillFacade`、`SkillService` | `SkillReferenceResolver.resolveUsable({actorId, skillIds})` → `SkillSummary[]` | `SkillRuntimeResolver.resolve({skillIds,execution})` → `RuntimeSkill[]`；负责源目录、归档新鲜度和受控下载 URL |
| `@fenix/mcp` | `McpFacade`、`McpService` | `McpReferenceResolver.resolveUsable({actorId, mcpServerIds})` → `McpServerSummary[]` | `McpRuntimeResolver.resolve({mcpServerIds,execution})` → `RuntimeMcpServer[]`；负责 stdio/streamable-http 校验、header/OAuth secret 解析 |
| `@fenix/knowledge-base` | `KnowledgeBaseFacade`、`KnowledgeBaseService` | `KnowledgeBaseReferenceResolver.resolveUsable({actorId, bindings})` → `KnowledgeBindingSummary[]` | `KnowledgeRuntimeResolver.resolve({agentConfigId,bindings,policy,execution})` → `RuntimeKnowledge | null`；负责 knowledge MCP 解析 |
| `@fenix/agent-memory` | 无独立用户 CRUD Facade/写 Service | memory 聚合写由 `AgentConfigRepository` 在本包事务中直接维护 `agent_memory_config` | `AgentMemoryRuntimeResolver.resolve({agentConfigId,execution})` → `RuntimeMemory | null`；只读解析，不跨包写事务 |
| `@fenix/machine` | `MachineFacade`、`MachineService` | `MachineReferenceResolver.resolveUsable({actorId, machineId})` → `MachineSummary` | `MachineRuntimeResolver.resolve({machineId,execution})` → `RuntimeNodeSelection`；Machine secret 留在 route/transport adapter，保持现有失败释放顺序 |
| `@fenix/sandbox` | `SandboxFacade`、`SandboxService` | `SandboxReferenceResolver.resolveUsable({actorId, sandboxPoolId})` → `SandboxPoolSummary` | `SandboxRuntimeResolver.resolve({sandboxPoolId,execution})` → `RuntimeNodeSelection`；provider 分配细节不泄漏给 AgentConfig，保持现有失败释放顺序 |
| `@fenix/site-app` | `SiteAppFacade`、`SiteAppService` | `SiteAppReferenceResolver.resolveUsable({actorId, siteAppIds})` → `SiteAppSummary[]` | `SiteAppRuntimeResolver.resolve({siteAppIds,execution})` → `RuntimeSiteApp[]`；只返回 Chat/Artifacts 所需能力，不返回发布 secret |

共同规则：批量 resolver 保持输入顺序、拒绝重复 ID，并且全有或全无；不存在、不可见、禁用或类型非法统一返回调用方可映射的 `INVALID_REFERENCE`，不得返回部分成功。创建/更新 AgentConfig 使用带 actor 的 reference resolver；已经通过 `AgentConfig.use` 的运行使用持久绑定调用无 actor runtime resolver，符合权限设计中“授权聚合动作后复用依赖 Domain Service”的边界，但每个 runtime resolver 仍必须接收同一个 `RuntimeExecutionSubject`。持久资源自身的内部能力可按聚合授权使用；用户/组织级 credential、memory bank、Environment secret、下载 token、workspace 和观测 user 必须按本次 execution 解析，缺失时 fail-closed，禁止回退 AgentConfig/resource owner。公开 DTO 只含稳定 ID、展示字段或运行必需值，不含数据库 row、Drizzle 类型、scope SQL、文件系统实现或 provider 内部对象。

`@fenix/agent-config` 根入口冻结导出：

```ts
export type AgentConfigId = string;
export type AgentConfigNode =
  | { readonly kind: "default" }
  | { readonly kind: "machine"; readonly machineId: string }
  | { readonly kind: "sandbox"; readonly sandboxPoolId: string };

export interface ProviderSummary {
  readonly id: string;
  readonly name: string;
  readonly protocol: "openai" | "anthropic";
}
export interface ModelSummary {
  readonly id: string;
  readonly providerId: string;
  readonly model: string;
  readonly displayName: string;
  readonly modalities: { readonly input: readonly ("text" | "image")[]; readonly output: readonly ("text" | "image")[] } | null;
}
export interface SkillSummary { readonly id: string; readonly name: string; readonly description: string }
export interface McpServerSummary { readonly id: string; readonly name: string; readonly type: "stdio" | "streamable-http" }
export interface KnowledgeBaseSummary { readonly id: string; readonly name: string; readonly slug: string | null }
export interface KnowledgeBindingSummary { readonly knowledgeBaseId: string; readonly name: string; readonly slug: string | null }
export interface MachineSummary { readonly id: string; readonly name: string; readonly online: boolean }
export interface SandboxPoolSummary { readonly id: string; readonly name: string; readonly providerKey: string }
export interface SiteAppSummary { readonly id: string; readonly name: string; readonly remoteAppId: string | null }

export interface AgentKnowledgePolicy {
  readonly searchFirst: boolean;
  /** 1..20；省略输入时规范化为 5。 */
  readonly maxResults: number;
  /** 每项 trim 后 1..128 字符、最多 32 项、去重且保持首次出现顺序。 */
  readonly defaultNamespaces: readonly string[];
}

export interface AgentKnowledgeBinding {
  readonly knowledgeBaseId: string;
  readonly priority: number;
  readonly enabled: boolean;
  /** 历史 binding config 只接受同一有界 policy；空值表示使用聚合 policy。 */
  readonly config: AgentKnowledgePolicy | null;
}

export interface AgentKnowledgeConfiguration {
  readonly bindings: readonly AgentKnowledgeBinding[];
  readonly policy: AgentKnowledgePolicy;
}

export interface AgentConfigTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly skillIds: readonly string[];
}

export interface AgentConfigData {
  readonly id: AgentConfigId;
  readonly name: string;
  /** 历史数据在 DAT-01 回填完成前可为 null；新建必须提供，null 配置不可 run。 */
  readonly modelId: string | null;
  readonly prompt: string | null;
  readonly description: string | null;
  readonly extra: Readonly<Record<string, unknown>> | null;
  readonly skillIds: readonly string[];
  readonly mcpServerIds: readonly string[];
  readonly knowledge: AgentKnowledgeConfiguration;
  readonly memory: { readonly enabled: boolean };
  readonly node: AgentConfigNode;
  readonly siteAppIds: readonly string[];
  /** 保留现有内置 Agent 展示语义；迁移期仍由既有名称规则推导。 */
  readonly builtIn: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type AgentConfigRecord = ResourceRecord<AgentConfigData, ResourceScope>;

export interface CreateAgentConfigInput {
  readonly name: string;
  readonly modelId: string;
  readonly prompt?: string | null;
  readonly description?: string | null;
  readonly extra?: Readonly<Record<string, unknown>> | null;
  readonly skillIds?: readonly string[];
  readonly mcpServerIds?: readonly string[];
  readonly knowledge?: AgentKnowledgeConfiguration;
  readonly memory?: { readonly enabled: boolean };
  readonly node?: AgentConfigNode;
  readonly siteAppIds?: readonly string[];
  readonly visibility?: "private" | "public";
}

export type UpdateAgentConfigInput = Partial<CreateAgentConfigInput>;
export interface AgentConfigListQuery { readonly page: number; readonly pageSize: number; readonly search?: string }
export interface AgentConfigPage {
  readonly items: readonly AgentConfigRecord[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface AgentConfigRunSnapshot {
  readonly agentConfigId: AgentConfigId;
  readonly name: string;
  readonly modelId: string;
  readonly prompt: string | null;
  readonly extra: Readonly<Record<string, unknown>> | null;
  readonly skillIds: readonly string[];
  readonly mcpServerIds: readonly string[];
  readonly knowledge: AgentKnowledgeConfiguration;
  readonly memoryEnabled: boolean;
  readonly node: AgentConfigNode;
  readonly siteAppIds: readonly string[];
}

export interface AgentConfigFacade {
  create(input: { actorId: string; data: CreateAgentConfigInput }): Promise<AgentConfigRecord>;
  list(input: { actorId: string; query: AgentConfigListQuery }): Promise<AgentConfigPage>;
  get(input: { actorId: string; agentConfigId: AgentConfigId }): Promise<AgentConfigRecord>;
  update(input: {
    actorId: string;
    agentConfigId: AgentConfigId;
    patch: UpdateAgentConfigInput;
  }): Promise<AgentConfigRecord>;
  delete(input: {
    actorId: string;
    agentConfigId: AgentConfigId;
  }): Promise<void>;
}

export interface AgentConfigRunFacade {
  startInteractive(input: RunInput): Promise<InteractiveRunResult>;
  openApiSession(input: RunInput & { readonly acpSessionId?: string }): Promise<AgentPromptTurn>;
  openWorkflowSession(input: RunInput): Promise<AgentPromptTurn>;
  provisionExternalRelay(input: RunInput): Promise<ExternalRelayResult>;
}

export interface RunInput {
  readonly actorId: string;
  readonly agentConfigId: AgentConfigId;
  readonly requestedInstanceId?: AgentInstanceId;
  readonly requestId?: string;
}

export interface AgentConfigService {
  getById(agentConfigId: AgentConfigId): Promise<AgentConfigData | null>;
  resolveForRun(agentConfigId: AgentConfigId): Promise<AgentConfigRunSnapshot>;
}
```

可空字段明确返回 `null`，集合明确返回空数组，不以缺省表达空值。`id` 沿用现有 UUID；`name` 只用于展示、搜索和组织内唯一约束。新建必须提供有效 `modelId`；历史 null 由 REF-01/AGT-02 在模型引用迁移时核查并保持可读/可修复，run 返回 `LAUNCH_SPEC_INVALID`，不得猜测默认模型。若全部回填且升级验证通过，contract 阶段再收紧 DB not-null；否则 DB 继续 nullable，与 DTO 的历史兼容语义一致。

DAT-01 对 AgentConfig 的功能性 schema 变更仅限 `visibility`；不得新增 revision、built-in、生命周期、删除恢复或幂等状态。`builtIn` 只保留当前 UI/接口行为并继续由既有名称规则推导，不在本轮扩展数据模型。创建缺省集合为空、memory disabled、node default、visibility private；更新中集合/knowledge 表示全量替换。

Knowledge 的 create/update schema 必须是 strict object，拒绝所有未知字段。policy 输入允许三个已知字段缺省并在边界规范化为 `searchFirst=true`、`maxResults=5`、`defaultNamespaces=[]`；`maxResults` 范围 1..20，namespace 按上述长度/数量规则校验。bindings 最多 100 项，`priority` 为 0..99 的唯一整数且排序后连续，重复 knowledgeBaseId、空 ID 或未知 config 字段均返回 400。模板公开 DTO 只含 stable `skillIds`；现有 Markdown 模板中的 Skill name 由模板加载 adapter 调 `SkillReferenceResolver` 转成 ID，无法唯一解析的模板不对该 actor 返回并记录诊断，不把 name 带入新创建请求。

### 14.4 `/web/agent-configs` HTTP 契约

所有 route 使用认证模块产生的 actor，响应统一为 `{ success: true, data }` 或 `{ success: false, error: { code, message, requestId? } }`。时间为 ISO-8601 UTC 字符串；ID 均为不透明字符串，客户端不得解析前缀或 UUID。冻结路由如下：

| 方法与路径 | 输入 | 成功状态与 `data` |
| --- | --- | --- |
| `GET /web/agent-configs` | query：`page` 默认 1、`pageSize` 默认 20/最大 100、可选 `search` | 200：`{items: AgentConfigRecord[], total, page, pageSize}`；授权过滤在 DB 分页前完成 |
| `POST /web/agent-configs` | `CreateAgentConfigInput` | 201：`AgentConfigRecord` |
| `GET /web/agent-configs/:id` | stable AgentConfig ID | 200：`AgentConfigRecord` |
| `PATCH /web/agent-configs/:id` | `UpdateAgentConfigInput` | 200：更新后的 `AgentConfigRecord` |
| `DELETE /web/agent-configs/:id` | stable AgentConfig ID | 200：`{id, deleted:true}`；停止/清理保持现有语义并经新 facade 重接 |
| `POST /web/agent-configs/:id/run` | `{instanceUid?: string}` | 200：`{agentConfigId:id, environmentId, instanceUid}`；M1 过渡 DTO，字段语义与 AGT-00 第一阶段一致 |
| `GET /web/agent-configs/templates` | 无 | 200：`{items: AgentConfigTemplate[]}`；模板 ID 不是 AgentConfig ID |

M1 Web 接收 `environmentId + instanceUid`，继续按现有规则生成确定性 RCS session 并连接 `/acp/yjs/:environmentId`；不得把 Environment 当作可管理资源或新业务引用。无 Environment 的 wsUrl/sessionLocator 属于 M1 后独立任务。`run` 固定使用 interactive/user-default 选择；外部 OpenAI 与 Workflow 分别由宿主选择 api/primary、workflow/primary，客户端不能伪造 selection。

错误映射冻结如下：

| HTTP | code | 语义 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | schema、非法 ID/分页/字段组合；handler 未产生写入或 runtime 副作用 |
| 401 | `UNAUTHORIZED` | 未建立可信主体 |
| 403 | `FORBIDDEN` | actor 已可读该资源，但缺少 create/update/delete/use 动作；内置项禁止修改/删除也使用此码 |
| 404 | `NOT_FOUND` | 资源不存在，或 actor 连 read 都没有；两者使用同一外部消息避免枚举 |
| 409 | `ALREADY_EXISTS` / `INSTANCE_CONFLICT` | 名称或实例冲突 |
| 422 | `INVALID_REFERENCE` / `LAUNCH_SPEC_INVALID` | 依赖引用不可用或完整启动规格无法形成；不泄漏不可见资源详情 |
| 429 | `CAPACITY_EXCEEDED` | 全局、用户或调度并发额度不足 |
| 503 | `RUNTIME_UNAVAILABLE` | Machine、Sandbox、engine 或 relay 暂不可用 |
| 504 | `RUNTIME_TIMEOUT` | 启动或受控等待超时 |
| 500 | `INTERNAL_ERROR` | 未分类错误；响应使用通用消息，原错误只进脱敏日志 |

列表仅返回 actor 可读记录和各记录真实 `access.actions`。详情、更新、删除、run 都先以 read 约束定位：不可读一律 404；可读但动作不足才 403。跨资源引用失败统一 422，不区分“不存在”和“不可见”。请求级错误必须携带同一个 `X-Request-Id` header；响应 `error.requestId` 可选但若出现必须相同。

### 14.5 既有 `/api` 与旧 `/web` 的处置

目标 `/web` 唯一路径指“唯一第一方资源控制面”，`/web` 与 `/api` 两种薄协议 adapter 必须共享唯一业务实现；该规则不授权破坏仓库已承诺的外部 `/api/*` 合同。M1 采用以下明确规则调和两者：

| 入口 | M1 决定 | 实现与迁移规则 | 删除门禁 |
| --- | --- | --- | --- |
| `/web/config/agents` | 删除 | WEB-02 切换到 `/web/agent-configs` 后，在同一资源切片删除 route/client/name CRUD，不保留转发 | 新 Web、调用方 search、route/浏览器测试全绿 |
| `/api/agents` CRUD | 保留为兼容协议 adapter | 维持当前方法、路径、分页、直接成功 DTO 与错误 envelope；内部只调用同一 `AgentConfigFacade`，禁止旧 service/第二写路径。第一方新字段只进入 `/web`；新增公开能力必须独立设计版本化 `/api` 合同 | 独立 ADR、消费者与流量清单、公告/退役窗口、契约测试及回滚方案齐备后方可删除 |
| `/api/agents/:id/instances/connect` | M1 保留已发布外部合同 | 维持当前 `{agentConfigId,environmentId,instanceId,relay:{wsUrl}}`、`api/primary` 选择和错误形状；经 `AgentConfigRunFacade.provisionExternalRelay()` 重接。后续 `/acp/relay` route 按现有 Environment/owner 规则建立并拥有 handle，close/error 时 dispose | 独立 ADR 证明无消费者和观测窗口无流量，并同时删除 route、relay URL 字段、`/acp/relay` 残留实现与测试 |
| `/api/agents/:id/v1/chat/completions` | 长期保留的 OpenAI-compatible 协议入口 | 保持路径、request/stream/non-stream/OpenAI error shape、`X-Session-Id` 与 300 秒行为；经 `AgentConfigRunFacade.openApiSession()` 取得请求私有 turn，响应结束/断流/错误都 dispose。它不是资源 CRUD 第二路径，不改为 `/web` envelope | 只有独立开放平台 ADR、版本迁移与外部兼容计划才能变更或删除 |

除上述祖传外部合同外，不直接给 `/api/agents` 增加字段或动作；第一方新资源动作进入 `/web`，新增公开能力另行设计版本化 `/api` 合同。External adapter 位于 `apps/server` 的协议边界或专门 protocol contribution，不由资源 package 复制 route/business logic。`/acp/*`、`/mcp/*`、hooks、WS/SSE 保持各自协议前缀。

### 14.6 历史首期范围与顺序（已撤销，仅供目标契约查阅）

以下是原 M1 的“强依赖资源”定义，**不再作为阶段 1 的范围**：阶段 1 应搬移所有现有功能，而非只搬 AgentConfig 调用到的子集。

| Task | 必须迁移 | 明确不在首期 |
| --- | --- | --- |
| DAT-01 | `agent_config` 与五组既有聚合数据的 schema 归包；沿用稳定 ID 和 scope 列；仅新增 visibility 并回填可无损映射的公开 grant | revision/built-in/lifecycle/delete 等 AgentConfig 扩展；废弃 `user_config` 的迁移或逻辑修改；其他引用和运行状态机改写 |
| AGT-01 | Environment、persistent Instance、Coordinator、controller/runtime、relay/session 组合及其 repository 迁入单一包；公开 facade/ports/manifest；通过公开 exports 复用 Chat/YJS 等四个基础包 | 资源解析、Machine、Workflow 和非 runtime route 保持原位置；不拆分子 package，不改取消/超时/背压/恢复，不迁入无调用方的 `/acp/relay` 协议 route |
| REF-01 | 单一 `@fenix/model` 包内 Provider 聚合根与 Model 二级资源的 AgentConfig 选择、继承授权的可见列表/必要 CRUD、引用校验、运行协议/地址/模型/凭证与网关预算解析 | 与 AgentConfig 无关的网关管理/报表重做；Model 独立 scope、独立资源包或兼容 shim |
| REF-02 | Skill 必要 CRUD/可见列表、文件与归档编排、AgentConfig binding、运行 URL 解析 | 非 AgentConfig 消费者的体验重构 |
| REF-03 | MCP 必要 CRUD/可见列表、配置校验、AgentConfig binding、运行 transport/secret 解析 | MCP 协议服务本身的无关重构 |
| REF-04 | Knowledge Base 可见列表、Agent binding/策略/引用检查、knowledge MCP 运行解析；Agent memory 开关与 Hindsight 运行配置 | 知识导入/索引全链路和独立 memory 管理 UI 的无关重构 |
| ENV-01 | Machine/Sandbox 节点可用性与运行选择；Site App 可见列表/binding/运行视图；Environment/Instance 过渡 facade 与删除清理 | 独立 Environment package、公开 CRUD/API/page；Machine 文件/Workspace 的后续 EXE-01 全面重构 |
| AGT-02 | 通过上述公开 resolver 形成所有字段已解析的 DTO，再调用纯 `AgentLaunchSpecAssembler`；等价覆盖旧两次 builder 输出 | runtime 直接查询资源、重新设计 engine/plugin 协议 |
| RES/WEB | 唯一 AgentConfig facade/repository/`/web` route、Web contribution、调用方切换和旧 Web 删除 | 新建开放平台版本、EE 发布审批功能 |

历史强制依赖顺序已撤销。阶段 1 按现有功能闭包拆任务和实际引用排序；阶段 2 逐包查明依赖；阶段 3 由用户人工决定顺序。

### 14.7 Environment、数据治理与删除事务

Environment 的实体、schema、repository、locator、workspace 计算和生命周期在目标架构归 `@fenix/agent-runtime`。其不对外暴露独立资源入口是**后续治理目标**；阶段 1 必须保留现有 `EnvironmentService`、DTO、`/web/environments` CRUD、Web client、管理页面与现有前后端流程，不通过分包改变其可用性。

DAT-01 的数据真相与迁移步骤冻结如下：

1. 沿用 `agent_config.id` UUID 与 `organization_id + user_id` scope，不重编号、不创建通用 ownership JSONB 或新 grant 表。AgentConfig 的唯一功能性 schema 扩展是 `visibility`（`private | public`，默认 `private`）。
2. AgentConfig package 拥有主表及 `agent_config_skill`、`agent_config_mcp`、`agent_config_site_app`、`agent_knowledge_binding`、`agent_memory_config`；物理定义移动不得造成已有表 drop/recreate。
3. `resource_permission` 中归属一致、`principal_type=all` 且 `principal_id is null` 的 AgentConfig read grant 可无损回填为 public；orphan、scope 冲突、非法 all grant 和定向组织 grant 只进入核查计数，不得扩大 visibility。切换前做最终 delta 回填，切换后删除旧 AgentConfig grant，不双写。
4. 不新增 `revision`、`is_builtin`、`lifecycle_state`、删除恢复字段、删除幂等表或迁移审计表。数据迁移完成状态复用既有 `data_migrate_record`，聚合异常计数写入迁移日志。
5. `user_config` 已确认没有有效前端消费，属于废弃功能。本轮保持其旧 schema、service 和 route 不变，不回填默认 Agent ID，也不迁入新 package；后续清理旧配置代码时删除相关接口、无调用方前端代码和整张表。
6. 其他 AgentConfig 引用继续使用既有 stable ID，并由各自 REF/ENV/RES task 在真实迁移边界处理；DAT-01 不做无关引用治理。`channel_binding.agent_id` 与 Chat route 的 `agentId` 是 Environment ID，禁止机械迁移。

AgentConfig 的更新与删除只迁移既有业务语义，不在 ARC-03 新增 CAS、生命周期状态机、幂等 key 或 run/delete admission 协议。ENV-01/RES-01 通过 runtime 已导出的按 instanceId stop funnel 重接当前删除流程；并发语义若需增强，必须基于独立需求另立设计和任务，不能混入本次重构。

### 14.8 调用方切换、观测、回滚与最终删除门禁

| 调用方 | 新边界 | 负责 task |
| --- | --- | --- |
| CE Web 管理、Home、Sidebar | `@fenix/agent-config/web` client → `/web/agent-configs`；run 直接消费不透明 connection | WEB-02 |
| Task/Scheduler | 保存 stable AgentConfig ID；执行时以可信任务 actor 调 `AgentConfigRunFacade.openApiSession()`，不直接查配置；dispose 释放请求资源 | RES-01/INT-01；沿用 api/primary，调度专属 selection 后续 ADR 前不得冒充 workflow |
| Workflow | 保存 stable AgentConfig ID；调用 `AgentConfigRunFacade.openWorkflowSession()`，保留 workflow/primary 与 lease，finally dispose | AGT-01/02 + 调用方 task |
| Browser Chat/YJS | `/web/agent-configs/:id/run` 调 `startInteractive()` 返回 `environmentId + instanceUid`；继续现有 YJS/RCS/page/file locator 规则，WebSocket 引用与 Chat cancel 归 runtime | ENV-01/WEB-02；无 Environment locator 在 M1 后另立任务 |
| Site/ProdView/Observer/Model gateway | 只用 `AgentConfigService` 公开 DTO 或明确 reference port，不导入 repository/schema | ENV/REF/RES/INT |
| External CRUD/connect/OpenAI | 14.5 的薄 adapter，共享同一 Facade/RunFacade | RES-01/AGT-02 |
| Machine/ACP/file | 通过 runtime 或 file transport 公开 port；认证留在宿主 resource route | ENV-01，完整迁移归 EXE-01 |

每次切片至少记录结构化字段 `requestId`、`operation`、`agentConfigId`、必要时 `instanceId`、结果 code 和 duration；迁移记录 migration ID、batch、scanned/updated/skipped/error count。禁止日志记录 token、Cookie、Environment secret、Provider/MCP credential、完整 prompt、文件内容、完整 launch spec 或未脱敏外部错误。INT-01 必须以日志捕获测试验证这些字段与禁项。

阶段 1 不改表或 data migration，保持旧版本可用的迁移链与顺序；终态历史库升级、生产构建与 E2E 全绿即可作为可上线版本。阶段 3 按每个包制定增量生产升级与回滚策略，不假定生产始终冻结在旧版本；不得改写已经被正式环境消费的 migration，也不得以旧/新 runtime 双栈兜底。

阶段 1 仅删除实现已完整搬移且旧位置静态 caller search 为零的源文件；对应 route/client/payload 仍须在最终 owner 原样存在。阶段 1 终态行为契约、特征、浏览器、空库及历史库升级测试全绿。阶段 3 若需删除旧业务或协议入口，先完成数据 ID/scope/reference、已发布接口消费者和回滚核验，`/api` 外部合同需独立 ADR；不得建立 deprecated shim、name→ID 转发、双写或第二套 relay/session 协议。

### 14.9 历史 review 结论与阶段 3 的复核边界

ARC-03 曾给出单一 runtime package、稳定 ID、AgentConfig→runtime 授权边界、目标 `/web` DTO、Environment 非资源化等设计；旧 AGT-01/02 宿主 port 切换、首期范围和顺序不再是现行实施任务。阶段 1 不得因这些目标去改目前 runtime 查询、Environment 或 name CRUD 的运行行为。阶段 3 实施前需核实该包现状和合同；不能为了实现便利创造双写、第二资源 route 或擅自扩展 `/api`。

两项协议仍须另行决策：外部 `/api/agents` 与 external connect 的退役版本，以及彻底移除 wsUrl 中 Environment locator 的 Chat/File URL。阶段 1 两者都维持现状；阶段 3 对应包适配前若无独立协议决策，也不得自行删除或更改。
