# Web 配置接口按资源 ID 定位实现计划

> **面向 AI 代理的工作者：** 使用 executing-plans 在当前会话逐任务实现；若用户明确选择子代理执行，再使用 subagent-driven-development。步骤使用复选框跟踪。本计划不授权自动提交。

**目标：** Model/Provider、Skill、MCP、AgentConfig 的控制台管理操作统一用数据库资源 ID 定位，消除名称或资源键被当作身份标识的问题。

**架构：** 保留 `/web` 协议适配层，统一资源集合与 ID 路径的 REST 风格，通过各 owner 包的 Resource Facade 完成 ID 定位、权限校验和业务编排。按资源完成后端、DTO、前端和测试的垂直切片，最终前后端同版本发布，不增加旧名称接口兼容层。

**技术栈：** Bun、Elysia、Zod v4、Drizzle/PostgreSQL、React、现有 request/unwrap 与 ahooks。

**规格：** 本文「范围与协议约定」；依据本次会话已确认的 ID 定位目标、内部前端同步切换约束，以及排除默认 Agent/默认模型偏好的决定。本文记录本次实施范围与最终契约。

## 全局约束

- 用户已授权在隔离 worktree 实现；未经明确要求不创建 commit。
- 不调整数据库表、唯一索引和存量数据，不需要 DDL 或数据迁移。
- 不修改已发布 `/api/*` 的路径、请求、响应、授权和错误语义。
- 不处理默认 Agent、默认模型/轻量模型偏好及其 `user_config` 存储，不清理这些遗留功能。
- 不新增改名能力、不放开同组织重名；跨组织同名资源必须能够按各自 ID 准确操作。
- 保留内置 Agent 和系统托管 Provider 的既有保护规则。
- ID 是定位信息；读、更新、删除、使用等权限仍由 Facade 与 access-control 判定，禁止 route 直接查表绕过授权。
- 协议 DTO、领域对象、数据库记录和前端类型仍在边界转换；不引入通用 CRUD 框架。
- 现有接近或超过 500 行的路由文件，按已有 handler/support 模式拆分本次涉及的逻辑，新增/重写文件不超过 500 行；不夹带无关重构。
- 测试使用现有 fixture/test-utils；每个 test 上方添加中文行为注释，不直接 mock.module()。

## 范围与协议约定

### 1. 身份与名称

- `id` 一律表示对应表行的数据库 ID（当前生成值为 UUID，协议校验为非空字符串），不是配置名、resourceKey 或上游模型代码。
- `name` 保留配置名称含义；Provider 的展示名称独立使用 `displayName`。
- Model 保留 `modelId` 表示上游模型代码（如 `gpt-4o`），`id` 表示平台 Model 行 UUID。
- Model 的权限继承所属 Provider；子行操作同时校验 Provider 与 Model 的归属关系。
- 列表、详情和创建/更新结果必须提供后续操作需要的真实 ID；禁止保存后靠名称查询来恢复 ID。
- Skill/MCP 的创建与更新结果补齐 `{ id, name }`；Provider 保存结果补齐 `{ id, name }`；Model 写操作结果提供 `{ id, modelId }`。保留仍需要的 scope/access 等字段。
- 删除仍遵循各端点原有空结果约定，不为形式统一增加无用响应。

### 2. 接口形态

使用集合 GET/POST、单资源 GET/PATCH/DELETE；附加操作按单资源子路径提供 POST。下表均省略 `/web` 前缀。

| 资源 | 列表/创建 | 已有资源操作 |
| --- | --- | --- |
| AgentConfig | `GET/POST /config/agents` | 详情、局部修改、删除使用 `/config/agents/:id`；重启使用 `POST /config/agents/:id/restart` |
| Skill | `GET/POST /config/skills` | `/config/skills/:id`；下载为 `/:id/download`，权限修改为 `/:id/access` |
| MCP | `GET/POST /config/mcp` | 详情、局部修改、删除使用 `/config/mcp/:id`；PATCH 同路径修改 enabled；POST `/:id/test`、`/:id/inspect`，GET `/:id/tools` |
| Provider | `GET/POST /config/providers` | 详情、更新、删除使用 `/config/providers/:id`；探测为 POST `/:id/fetch-models`，子模型为 `/:providerId/models/:id` |
| Model | `POST /config/providers/:providerId/models` | `PATCH/DELETE /config/providers/:providerId/models/:id`，路径参数为 Model 行 UUID |

- GET 集合接口只列资源，GET `/:id` 查询详情；单资源写操作缺少 ID 不匹配路由，非法参数按 schema 拒绝，不得退化为创建或名称查询。
- 旧 `name` 查询参数不再定位已有资源；Agent/MCP/Provider 集合仅带旧 `name` 的请求返回框架校验错误 422，防止被集合 GET 静默当成列表。创建请求中的 `name` 仍是业务字段。
- 不存在/不可见/无操作权限分别遵循现有 Facade 错误规则，不因切到 UUID 放宽可见性或泄露资源存在性。
- Provider 当前 PUT upsert 拆为明确 POST 创建、PATCH 按 ID 更新；不存在的 ID 不创建新行。同组织同名创建返回冲突，不覆盖已有配置。
- 已保存模型的连通性测试使用 POST `/config/providers/:providerId/models/:id/test`，校验父子归属后从行记录取上游 `modelId`。
- Provider 获取模型清单使用 `POST /config/providers/:id/fetch-models`：已保存配置通过路径定位，继续要求原有探测权限；未保存草稿使用 `POST /config/providers/probe-models`，使用内联连接配置（上游默认端点与无密钥端点保持既有支持），不读取任何已保存资源密钥。草稿请求使用既有会话认证规则，不用名称定位资源。
- MCP 的 `test-url` 等纯草稿探测保留原用途，无资源 ID 时仅使用显式输入；不为无资源的动作制造假 ID。
- `/config/agents/templates`、Skill 上传/导入和其他集合动作保留各自语义。Skill 导入同名冲突仍属于组织内业务判重。
- `/web/config/models` 的可用列表与刷新继续提供服务；`current` 偏好读写、默认 Agent 接口和存储均保持现状。

### 3. 共用业务逻辑

- 优先复用已存在的 `getById/readDetailById/updateById/removeById/saveById` 等入口。
- 缺失 ID 入口时补充 Facade 方法，在完成授权后调用同一份更新/删除/重启实现；禁止 route 先把 UUID 还原为 name，再走名称查找。
- `/api` 或排除范围仍在使用的名称方法可保留；仅删除本次切换后没有消费者的内部名称适配方法。
- Skill 按 ID 找到并授权资源后，可使用真实行的 organizationId/name 操作既有目录和归档；继续执行完整文件编排及失败回滚。
- 修正 Provider `getForProbe` 忽略 `ProviderRef.by` 的问题；对 UUID 使用 ID 查询并保留 update 授权。

## 文件结构与职责

| 范围 | 主要文件 | 职责 |
| --- | --- | --- |
| 公共视图类型 | `packages/web-runtime/web/types/config.ts` | 明确 UUID、配置名、展示名和上游模型代码，补齐缺失 ID |
| AgentConfig 后端 | `packages/resources/agent-config/src/server/{facades/agent-config-facade.ts,routes/web/config/agents.ts,routes/web/config/agent-route-support.ts,schemas/config.schema.ts}` | ID 定位的查询、更新、删除、重启及协议 schema |
| AgentConfig 前端 | 同包 `web/api/agents.ts`、`web/hooks/use-agent-sidebar-tree.ts`、`web/pages/agent-panel/agent-editor/`、`web/pages/agent-panel/pages/{AgentManagementPage.tsx,agent-home-creation.ts}` | API client、编辑目标、删除/重启和创建进入流程 |
| MCP | `packages/resources/mcp/src/server/{facades/mcp-server-facade.ts,routes/web/config/mcp.ts}` 及同包 `web/api/mcp.ts`、`web/pages/agent-panel/pages/` | CRUD、启停、探测与工具操作、批量创建回滚 |
| Skill | `packages/resources/skill/src/server/{facades/skill-facade.ts,routes/web/config/skills.ts,routes/web/config/skill-route-support.ts}` 及同包 `web/api/skills.ts`、`web/pages/agent-panel/pages/` | ID 授权、文件编排、下载、权限修改和页面交互 |
| Provider/Model | `packages/resources/model-management/src/server/{facades/provider-facade.ts,routes/web/config/providers.ts,routes/web/config/provider-handlers.ts,routes/web/config/provider-views.ts,routes/web/config/provider-probe.ts,schemas/config.schema.ts}` | 父子 ID、显式创建与更新、DTO、草稿/存量探测 |
| 模型前端 | 同包 `web/api/providers.ts`、`web/lib/provider-resource-access.ts`、`web/pages/agent-panel/pages/agent-models-*.ts*`、`provider-editor-dialog.tsx` | 明确字段语义，列表目标、表单、增删改测均携带 UUID |
| 长期契约 | `docs/arch/04-agent-config.md`、`06-config.md`、`06-config-provider.md`、`06-config-skills.md`、`06-config-mcp.md` | 实现完成后记录最终 Web 身份契约 |

协议 schema 以各 owner 的现有定义文件为准；按测试和类型检查追踪所有调用点，不能只改本表列举的页面。

## 审查重点（Review Focus）

1. 跨组织出现同名资源：所有操作命中传入 UUID 对应行，公开只读资源不能被修改或拿其密钥探测（任务 1—4）。
2. Model UUID 属于另一个 Provider：更新、删除和测试均失败，不能操作或请求错误的上游（任务 4）。
3. 更新使用失效 UUID、前端仍发名称：明确报错，不能 upsert 成新资源、更新同名资源或静默进入列表模式（任务 1—4）。
4. MCP 批量创建中途失败：只补偿删除本次创建且已拿到 UUID 的资源，保留已有同名资源和原始失败原因（任务 2）。
5. Skill 文件写入或归档失败、Provider 创建并发冲突：保留完整回滚/冲突语义，不能留下部分更新或覆盖已有配置（任务 3—4）。

## 任务 1：AgentConfig 的完整管理流程切换 ID

**文件：** 上述 AgentConfig 后端/前端及公共视图类型；按 ID 调用已有 API 的宿主适配点如需调整，只改内部实现并保留外部契约。

**测试：**
- 修改 `packages/resources/agent-config/src/__tests__/round44-agent-config-routes.test.ts` 及两份 `round45-agent-config-routes-*.test.ts` 中受影响用例。
- 修改同包 `web/__tests__/{agent-resource-access-flow.test.ts,agent-create-enter-flow.test.ts,config-agents-page.test.ts}`。
- 回归同包 `src/__tests__/{api-agents-routes.test.ts,agent-config-delete-stops-instances.test.ts,agent-config-create-conflict.test.ts}`。

- [x] 添加行为断言：`get(uuidA).id === uuidA`；同名 `uuidB` 不受更新/删除/重启影响；仅 `name` 不触发详情或写入；失效 UUID 不创建配置；内置保护保持原行为。
- [x] 先运行受影响测试，确认因未支持 ID 请求或仍发送 name 而失败。
- [x] 补齐 Facade 的 `updateById/removeById/restartInstancesById`，参数及返回沿用现有方法，只替换定位参数为 `resourceId: string`；读接口复用 `getById`。提取共享操作实现，保留原有停止实例、关联清理与权限逻辑。
- [x] 修改 route/schema/client：已有资源使用 ID 路径；列表/详情/save DTO 保证 ID；默认 Agent 与 templates 不变。
- [x] 编辑、管理页、侧栏删除/重启使用 `agent.id`；查找所有 `agentName/resourceKey` 操作目标，改为明确的 `agentConfigId`。
- [x] 首页创建冲突不再 `get(data.name)`：保留“复用本组织已有同名 Agent”体验，先取列表，按本组织及名称找到候选 UUID，再按 UUID 查询并重验权限；找不到/不唯一时明确失败，不取跨组织同名条目。正常创建直接用响应 ID。
- [x] 运行 `bun test packages/resources/agent-config/src/__tests__ packages/resources/agent-config/web/__tests__`，预期 PASS。

## 任务 2：MCP 的 CRUD、工具与探测操作切换 ID

**文件：** 上述 MCP 文件；复杂路由协议声明与 handler 分离，避免继续扩大 `mcp.ts`。

**测试：** 同包 `src/__tests__/{mcp-server-facade.test.ts,round40-mcp-config-routes.test.ts,round66-mcp-config-routes.test.ts,round47-api-mcp-routes.test.ts}`，`web/__tests__/{config-mcp-api-client.test.ts,mcp-resource-access-flow.test.ts,mcp-page-states.test.tsx}`；批量补偿行为在 `web/__tests__/mcp-batch-create-rollback.test.ts` 新增用例。

- [x] 添加失败测试：所有已有资源操作使用 UUID 路径；同名资源与跨组织只读边界；create 响应返回真实 ID；第 2 个批量创建失败时只调用 `del(firstCreatedId)`，不调用 `del(name)`，原始错误仍返回页面。
- [x] 先运行受影响测试确认失败。
- [x] CRUD 复用 `getById/getWritableById/updateById/removeById`；补齐 `setEnabledById/listToolsById/saveInspectedToolsById`，保持原返回类型并复用同一操作实现。test/inspect 通过已授权行继续现有探测逻辑。
- [x] create handler 返回 Facade 已生成的 UUID；更新/动作响应中涉及资源身份的字段提供真实 UUID，不把 路径参数原值当名称回传。
- [x] 更新 client、页面与对话框操作目标；批量创建记录返回 ID，补偿失败保留诊断上下文，不吞掉补偿异常，也不覆盖最初的创建错误。
- [x] 保留草稿 `test-url` 输入模式；改现有资源 action 不影响无资源探测。
- [x] 运行 `bun test packages/resources/mcp/src/__tests__ packages/resources/mcp/web/__tests__`，预期 PASS。

## 任务 3：Skill 的 CRUD、下载与权限操作切换 ID

**文件：** 上述 Skill 文件及公共 `SkillInfo` 类型，将真实返回的 ID 声明为必需字段。

**测试：** 同包 `src/__tests__/{skill-facade.test.ts,round44-skills-config-routes.test.ts,api-skills-routes.test.ts,skill-import-name-overwrite.test.ts}`，`web/__tests__/{skill-resource-access-flow.test.ts,skill-resource-access-boundaries.test.tsx,agent-skills-page-states.test.tsx}`；下载/文件失败边界沿现有 fixture 补充。

- [x] 添加失败测试：跨组织同名 Skill 的详情/编辑/下载/权限/删除命中 UUID；不可读资源无文件返回；文件写入或归档失败后元数据和原文件保持一致；创建/更新返回 `{ id, name }`。
- [x] 先运行受影响测试确认失败。
- [x] 详情/删除复用已有 ById；补齐 `updateById/setPublicReadableById`，返回值沿用现有方法；完成 ID 定位与授权后使用真实资源的目录信息执行文件操作。
- [x] route/schema/client 切换为 `:id`，更新下载链接与错误处理、页面目标以及保存后的状态；禁止前端退回到名称作为 ID。
- [x] 上传与导入保持既有同名冲突策略、文件编排和回滚，不把名称判重错误地删掉。
- [x] 运行 `bun test packages/resources/skill/src/__tests__ packages/resources/skill/web/__tests__`，预期 PASS。

## 任务 4：Provider/Model 身份、创建与探测完整切换

**文件：** 上述 Provider/Model 文件及公共 `ProviderInfo/ProviderDetail/ProviderModel` 类型；`ModelEntry` 可用列表已提供真实 ID，保持其既有可用列表契约。

**测试：** 同包 `src/__tests__/{round-config-providers-routes.test.ts,provider-facade-model-scope.test.ts,round-config-models-routes.test.ts}`、`web/__tests__/provider-model-resource-access-flow.test.ts`；同包 `provider-facade-model-scope.test.ts` / `provider-repository.test.ts` 覆盖 ID 定位、创建冲突与父子归属，路由和前端资源访问测试覆盖字段语义、搜索与探测身份传递。

- [x] 添加失败测试：Provider 的 `id` 是 UUID、`name` 是配置名、`displayName` 是展示名；子模型 `id` 是 UUID、`modelId` 是上游代码；父子 ID 错配拒绝更新/删除/测试；探测 UUID 能准确找到资源且保持 update 授权。
- [x] 添加失败测试：POST 返回真实新 ID，重复/并发同名创建不覆盖；PATCH 不存在的 ID 返回未找到且行数不变；仅 name 的旧请求明确拒绝；无 ID 的内联草稿探测不读取已有密钥。
- [x] 先运行受影响测试确认失败。
- [x] 修正 `getForProbe` 使用 ref 的判别字段；Provider 读取/更新复用 ID 入口，删除与子模型操作使用 `{ by: "resourceId", value: providerUuid }`，子模型使用 `{ by: "id", value: modelUuid }`。
- [x] 创建复用现有领域创建原语，补充 Facade 显式 create 入口；数据库唯一约束负责竞态判重，不能通过 name upsert 实现创建。保留 `/api` 的已有行为。
- [x] 更新 Web views/schema：移除 Provider 中配置名占用 `id` 的投影，子模型保留独立上游代码；子模型操作响应提供真实 ID。重复 UUID 别名仅在确认无消费者后删除。
- [x] 更新表单 Draft，将创建用配置名与编辑目标 UUID 分离；更新前端目录、选择、查重、增删改测及工具函数。删除 `providerApi.set` 的 PUT→POST 回退，调用方明确选择 create 或 update（PATCH）。
- [x] 区分已保存配置与草稿的 fetch-models 请求；已保存模型 test 从 UUID 解析上游代码；展示、能力推断和上游请求继续使用真正的 `modelId`，不能误用 UUID。
- [x] 保持 `/web/config/models` 的 `available` 和 refresh 行为及偏好字段，不迁移 `current`。若共享 helper 同时服务遗留偏好组件，保留其既有值格式，不能连带改变存储。
- [x] 运行 `bun test packages/resources/model-management/src/__tests__ packages/resources/model-management/web/__tests__ packages/web-runtime/web/__tests__`，预期 PASS。

## 任务 5：集成验证、长期契约与发布

**文件：** 上述架构文档；`apps/server/src/__tests__/config-integration.test.ts` 与被完整流程命中的前端集成测试。

- [x] 更新 Web 契约集成测试：四个资源从 list/create 返回 UUID 后可直接完成 detail→update/action→delete；缺 ID、旧 name 请求和不存在 ID 不发生意外写入。
- [x] 搜索 `agentApi/skillConfigApi/mcpApi/providerApi` 的所有消费点，以及手写 `/web/config/*` URL，逐项确认已有资源不再用名称/resourceKey；默认偏好接口和导入判重作为明确保留项。
- [x] 同步 `docs/arch/` 的最终接口参数、字段含义、权限、创建/更新语义；删除受影响注释和测试中“Web 必须按名称定位”的过时描述。
- [x] 运行 `bun run fastcheck`，预期静态门禁与受影响测试全绿。
- [x] 运行 `bun run build:web`，预期生产构建成功。
- [x] 运行 `bun run precheck`，预期全量门禁通过；相关失败必须处理或提供阻塞证据，不能声明通过。
- [x] 人工验证：创建四类资源并编辑/操作/删除；跨组织同名公开资源可读且无权修改；Agent 创建后正确进入实例；MCP 批量创建失败补偿正确；Skill 下载/导入正常；Provider 草稿探测和已有模型测试正常。
- [x] 检查 diff 不包含业务表/迁移、偏好存储、无关资源及生成路由树的手工修改。确认后等待用户的提交/发布指令。

## 发布与回滚

1. 四个切片可以分别验证，正式发布前必须全部通过集成检查，后端与 Web 构建产物作为同一版本发布。
2. 不保留名称兼容端点；发布后旧浏览器页面可能失败，应刷新载入新前端。沿用现有静态资源缓存策略核对该行为，不新增另一套版本机制。
3. 无数据库迁移；回滚时将后端与 Web 产物整体回滚至同一旧版本，避免新旧契约混用。
4. 可观测性沿用现有请求日志与错误信封，确认 UUID 校验失败、未找到、无权限、探测失败和文件回滚错误可定位，日志不记录密钥。

## 计划自检

- [x] 四个资源的 CRUD 和附加 action 均有任务，默认偏好和 schema 变更明确排除。
- [x] 每个资源按后端、DTO、前端、测试完整切换；最终统一发布。
- [x] UUID、name、displayName、modelId 的含义明确，已有可用模型列表不被误改。
- [x] 五项审查重点均分配到行为测试，包含父子归属、跨组织同名、旧请求、失败补偿与并发冲突。
- [x] 覆盖 precheck、Web 生产构建、长期契约及成对回滚；没有自动提交或直接实施步骤。

## 实施结果

- 工作分支：`feat/web-config-rest-id`；隔离目录：`/Users/liyuan/Work/FenixAgent-web-config-rest`；未创建提交。
- AgentConfig、MCP、Skill、Provider/Model 已完成 REST + ID 切换；已同步前端与长期契约。
- 独立审查发现的探测诊断丢失、目录搜索字段遗漏、Skill PATCH 未提交字段丢失均以回归测试修复。
- `bun run fastcheck`、`bun run precheck`、`bun run build:web` 全部通过；precheck 三批合计 12,868 项通过、108 项跳过、0 项失败。
- 没有使用真实上游或真实 PostgreSQL 并发压测；唯一键冲突行为通过真实仓储 SQL 分支测试与 Facade 冲突测试验证。

## 实施裁决

1. 按用户已批准的 REST 路径实施，取代原 action 风格限制；不改数据库、不自动提交。部署或回滚需前后端同时切换，否则旧客户端会报路由/校验错误。
2. ID 按既有契约校验为非空字符串，不新增 UUID 格式限制，也不回退名称查询；若需严格 UUID 格式，应另行收紧协议，当前非 UUID 输入会进入受控查找。
3. schema 校验沿用 Elysia 422，缺少资源路径为 404；不增加转换到 400 的适配层。依赖旧 400 的内部调用需同步更新。
4. Provider 草稿探测保留会话认证与内联凭据/默认端点行为，不新增持久资源的 create 授权；已存配置探测始终要求 update。若未来需要单独限制草稿出站探测，应另设策略。
