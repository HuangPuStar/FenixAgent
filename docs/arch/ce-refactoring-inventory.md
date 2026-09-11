# CE AgentConfig 重构现状清单

> 事实基线：`7ed74cac8684bac6466cbfc17bb6746839f3f497`。本文只记录该 revision 的生产源码与既有测试所呈现的当前事实，不是 ARC-02/ARC-03 设计。
>
> 相对初始盘点提交 `ba8ab4d1737634b62042290c1735be8744d947bb`，该基线没有改变 `src/`、`web/` 中的 AgentConfig 生产行为；期间完成的 FND-00/FND-01 仅新增或调整设计文档、workspace manifest、app 空入口、TypeScript 配置与 CI 覆盖。逻辑 owner 和直接交接边界按该 revision 的最新设计重核。

## 1. 范围、证据与术语

证据优先级：可执行测试与生产源码 > `src/db/schema.ts` > 当前架构清单 `FUNCTIONAL_MODULE_INVENTORY.md` > 目标设计 `docs/design/ce-ee-refactoring/ce-ee-refactoring-collaboration-plan.md`、`docs/design/ce-ee-refactoring/ce-ee-engineering-architecture.md`。设计文档仅用于标注后续 task 和逻辑 owner，不能反向解释当前行为。

本文中的 `platform`、`agent`、`resources/agent-config`、`apps/server`、`apps/web` 是批准的**逻辑 owner 标签**，不是当前仓库路径。基础平台签名与拒绝语义留给 ARC-02，AgentConfig、Agent runtime/instance 和强依赖资源的公开接口与目标路径留给 ARC-03；本文引用的其余反引号路径均在本基线存在。

非目标：不修改生产行为、schema/migration、workspace/package、前端；不决定角色写权限与平台拒绝语义，不冻结 403/404、统一 envelope、目标 ID/DTO、`/app` 或外部 `/api` 契约；不展开实例/session/relay/cancel/timeout 生命周期；不读取或引用 AGT-00-only 文件。

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
| `user_config.default_agent` | AgentConfig **name** | 无 FK | `resources/agent-config`（默认配置引用）+ `apps/web`（调用方）；`src/services/config/user-config.ts`; DAT-01 回填 ID，WEB-02 切调用方 |
| `resource_permission.resource_id` | AgentConfig UUID 的文本多态引用 | 无 FK | `platform`; PLT-01/DAT-01 迁移 grant 与 orphan 校验 |
| `agent_config.agent_node` | machine 或 sandboxPool ID 的 JSON 判别联合；另有历史 `machine_id` FK | JSON 无 FK | `resources/agent-config`（持久化引用）+ `agent`（运行解析）；`src/services/config/agent-config.ts`、`src/services/environment-web.ts`; ENV-01 |
| Machine 注册匹配 | `machine.agent_name` 驱动配置 machine 绑定，形成 name 耦合 | 无 AgentConfig FK | `agent`; `src/services/registry.ts`; ENV-01/DAT-01 |
| Legacy channel | `channel_binding.agent_id` 实际承载 Environment ID，不是配置 ID | varchar，无 FK | `apps/server`（协议调用方）；`src/services/channel-binding.ts`、`src/repositories/channel-binding.ts`; 保留协议并重接 |
| Workflow 定义/transport | transport 参数名 `agentId`，宿主实现按 Environment name 查找和复用实例 | JSON/接口，无配置 FK | `apps/server`（自动化调用方）+ `agent`（实例端口）；`src/services/workflow/agent-chat-transport.ts`、`packages/workflow-engine/src/transport/transport.ts`; 保留并重接 |

固定基线扫描未发现另一张直接 FK 到 AgentConfig 的现行表。动态 JSON、导入数据和外部消费者无法靠 FK 枚举；DAT-01 contract 前必须对历史数据和 payload 做一次可审计扫描。

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

## 11. 责任、依赖与风险登记

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
| DAT-01 | CE task pool，独占 migration journal | PLT-01、ARC-03 | ID/ownership/grant/binding/reference 的 expand-backfill-switch-contract |
| AGT-01 | CE task pool | AGT-00、FND-01、ARC-03 | 无权限 Agent runtime 与 InstanceManager |
| WEB-01 | CE task pool | FND-03、FND-05 | CE Shell、薄 route 和 Web contribution 装配，不创建资源页面 |
| REF-01 | CE task pool，独占 DB 锁 | PLT-01、DAT-01 | model/provider/credential 公开能力 |
| REF-02 | CE task pool，独占 DB 锁 | PLT-01、DAT-01 | Skill 与 archive 公开能力 |
| REF-03 | CE task pool，独占 DB 锁 | PLT-01、DAT-01 | MCP 与 launch config 公开能力 |
| REF-04 | CE task pool，独占 DB 锁 | PLT-01、DAT-01 | knowledge/memory 公开能力 |
| ENV-01 | CE task pool，独占 DB 锁 | PLT-01、DAT-01、AGT-01 | Environment/node/Site、删除清理与引用迁移 |
| AGT-02 | CE task pool | AGT-01、REF-01、REF-02、REF-03、REF-04、ENV-01 | 从公开资源结果组装完整 LaunchSpec |
| WEB-REF-01 | CE task pool | WEB-01、REF-01、REF-02、REF-03、REF-04、ENV-01 | 资源管理页、selector、route 与导航整合 |
| RES-01 | CE task pool，独占 DB 锁 | PLT-01、DAT-01、AGT-01、AGT-02、REF-01、REF-02、REF-03、REF-04、ENV-01 | AgentConfig facade/repository/`/app` route/run，唯一后端写路径 |
| WEB-02 | CE task pool | RES-01、WEB-01、WEB-REF-01 | AgentConfig 页面/client/caller 切换和旧 Web 删除 |
| INT-01 | CE task pool + EE-C | FND-05、PLT-01、PLT-02、PLT-04、REF-01、REF-02、REF-03、REF-04、ENV-01、AGT-02、RES-01、WEB-02 | 空库/升级库、权限、CRUD/run、UI、日志/requestId 关联、补偿/回滚 E2E |

| 风险 | 严重度 | 证据 | 必须满足的控制 |
| --- | --- | --- | --- |
| role 未参与写授权 / active-org fallback | 高 | `src/services/resource-permission.ts`、`src/services/org-context.ts` | ARC-02 + EE-C 明确语义；PLT-01 contract tests |
| 非事务聚合写/并发覆盖 | 高 | route 编排及三个 binding service | RES-01 事务边界、并发测试、失败补偿 |
| name 与混合 ID 语义 | 高 | Web CRUD/default/Meta、Chat Environment ID | DAT-01 回填与调用方逐项切换，禁止 alias |
| grant/credential orphan | 高 | 无 FK 文本/UUID 引用 | 数据校验、清理/约束方案、删除测试 |
| runtime 仍查资源与权限 | 高 | `src/services/orchestration-instance.ts`、`src/services/launch-spec-builder.ts` | RES-01 `resolveForRun`; AGT-02 仅收已授权快照 |
| 外部 `/api` 合同未知 | 高 | 当前可用 CRUD/connect/OpenAI 入口 | ARC-03/独立 ADR 决定退役窗口，不擅删/长期转发 |
| 日志敏感数据与关联不足 | 中高 | LaunchSpec 日志、generic HTTP logger | 复用 `@fenix/logger` 与 `requestId`；INT-01 验证脱敏和诊断关联 |
| 真实 DB/runtime/browser 证据缺失 | 中高 | 测试等级表 | DAT/AGT/WEB/INT tasks 补 E2E 与升级演练 |

## 12. 删除台账

### 12.1 Must-delete（切换完成后删除，不建兼容层）

| 旧资产 | owner/task | 删除前置与证据 | 回滚边界 |
| --- | --- | --- | --- |
| `src/routes/web/config/agents.ts` | `resources/agent-config`; RES-01 | `/app` CRUD/run 已验收；`web/src/api/agents.ts` 与所有调用方切走；route search 为零；合同/权限测试绿；观测窗口无流量 | 切换前可回滚新 app；删旧写入口后不双写 |
| `src/services/config/agent-config.ts`、`src/services/config/agent-config-skill.ts`、`src/services/config/agent-config-mcp.ts`、`src/services/config/agent-config-site-app.ts` | `resources/agent-config`; RES-01 + REF/ENV | 所有 route/runtime/Meta/Site callers 改公开 service；事务/权限/删除测试等价 | 以新 facade 版本回滚，不加 shim |
| `src/repositories/agent-config.ts` | `resources/agent-config`; RES-01/AGT-02/Observer owner | runtime 和 Observer 改公开 DTO/port；无内部 import；LaunchSpec/Observer tests 绿 | 保留新公开 adapter，不保留双 repo |
| `web/src/api/agents.ts` | `resources/agent-config`（Web client）；WEB-02 | 页面、Sidebar、Task、ProdView、Home 全切 `/app` stable ID client；request tests/build 绿 | Web/server 同发布窗口回滚 |
| `web/src/routes/agent/_panel/agents.tsx` 中旧 adapter 与 `web/src/pages/agent-panel/pages/AgentManagementPage.tsx`、`web/src/pages/agent-panel/AgentFormDialog.tsx`、`web/src/pages/agent-panel/pages/AgentHomePage.tsx` 的 AgentConfig-owned 实现 | `apps/web`（薄 route）+ `resources/agent-config`（页面）；WEB-02 | 新 contribution 覆盖 loading/empty/error/retry/unauthorized/success；浏览器关键流绿；Shell 不再导入 | 静态 contribution 版本回滚，不并存两页面 |
| `web/src/pages/agent-panel/AgentSidebarTree.tsx` 中 AgentConfig 业务片段及 AgentConfig-owned locale keys | `apps/web`（Shell）+ `resources/agent-config`（业务片段）；WEB-02 | Shell contribution 已重接；事件和 namespace 引用 search；仅删专属 key | 保留共享 Shell/namespace，不整文件盲删 |
| `src/db/schema.ts` 中旧定义位置 | `resources/agent-config`; DAT-01 | 模块 schema 成为唯一真相；Drizzle diff 无意外 DDL；空库/升级库、ID/grant/binding 校验通过 | expand/contract 前可回滚兼容 app；已 contract 后走补偿 migration |

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

### 12.3 Contract-decision-required（ARC-02、ARC-03 或单独 ADR 后处置）

| 资产/冲突 | 必须决定 | 未决定前规则 |
| --- | --- | --- |
| `src/routes/api/agents.ts` | ARC-03/ADR：稳定外部 CRUD 是否退役、窗口、版本/限流/兼容义务 | 不擅删，不新增永久转发或第二写路径 |
| `src/routes/api/instances.ts` | ARC-03/ADR：connect 是否并入 `/app/:id/run`，复用/响应 DTO | 保持现行为可比较基线 |
| `src/routes/api/openai-chat.ts` | ARC-03/ADR：OpenAI-compatible 合同与外部消费者 | 保持 endpoint/流错误行为，资源授权仍需收敛 |
| auth/error | ARC-02：session/env secret/API key 次序、active-org fallback 和平台拒绝语义；ARC-03：AgentConfig 403/404、role 与 `use` | ARC-01 只记录；对应契约确认后冻结 |
| ID/schema | ARC-03：name/resourceKey、defaultAgent、Environment route `agentId`、workflow/channel payload | 逐字段迁移，不做字符串批量替换 |

## 13. 开始/停止与删除判定

首个资源闭环实现开始前：固定本清单 revision；ARC-02 完成平台边界与 EE-C 替换需求确认，ARC-03 基于本清单和 AGT-00 冻结资源/Agent 契约；为每个引用建立 owner、数据回填、caller search、contract test、观测和回滚步骤；schema task 取得 migration journal 锁。

立即停止并升级：需要生产行为修复但 task 未授权；身份/租户/use 或外部合同仍冲突；发现未分类调用方/数据引用；需要 live 凭证/客户数据；迁移无法幂等补偿；新旧写路径将并存；真实测试暴露与冻结基线不同；日志样例可能含敏感值。

任何旧资产只有在新权威路径已运行、数据/API/调用方验证通过、观测窗口无旧流量、回滚版本仍兼容当前 schema 时才可删除。删除后不得以 deprecated shim、alias、双写或 name->ID 转发恢复旧内部路径。
