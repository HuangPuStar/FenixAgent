# @fenix-ee/agent-config

EE 对 CE AgentConfig 的商业扩展模块。

包含：

- `EnterpriseAgentConfigFacade`：复用 CE CRUD 和 `agent-config:use` 授权流程。
- `AgentConfigApprovalPolicy`：发布专用窄端口；EE 默认复用企业授权实现，甲方可在 app 装配时替换。
- 发布状态仓储：EE 创建配置时生成 `draft`，`publish()` 后转为 `active`。
- `resolveForRun()` 覆盖：先校验 `use`，再限定只有已发布配置可启动。
- `agentConfigPublicationModule`：EE 自有发布表、迁移、发布 API、控制台入口与 capability。
- `db/`：EE 自己拥有的发布扩展表；不修改 CE `resources` 或属性表。
- `web/`：EE 静态替换的空发布页面 contribution。

允许依赖：CE `agent-config` 的公开入口与 CE 平台契约。

禁止放入：复制 CE CRUD、身份授权模型细节或 InstanceManager。身份与范围由 EE `enterprise-access-control` 提供；实例运行仍原样复用 CE runtime。
