# External Agent API v1 设计

> 状态：设计稿，供书面审阅；尚未实施。日期：2026-10-29。分支：`feat/openai`。
> 目标：让外部系统通过 API Key 完成 Agent 的最小配置、文件准备和运行闭环。

## 1. 已确认范围

1. 资源范围：Agent、Provider / Model、Skill、MCP、已有知识库、持久 Instance、工作区文件上传和 Agent 对话。
2. 新版本统一使用 `/api/v1`；普通接口采用与 Web 一致的 `{ success, data / error }` 包装体。
3. Chat Completions 使用 OpenAI 原生 JSON / SSE / 错误结构，兼容 OpenAI SDK，不加平台包装体。
4. 知识库仅查询、绑定当前组织已有资源，不创建知识库，不上传、解析知识文档。
5. Web 与 v1 复用领域服务、文件执行面及 Agent runtime，分别维护应用入口与接口契约；Web 的变更不得破坏已发布 v1 的兼容性。修复实际存在的公共业务缺陷。
6. 本次不改数据库表结构，不新增依赖，不创建另一套 ACP 协议栈。
7. 工作流仅纳入现有 External Workflow 两个执行接口的 v1 路径与包装体统一，不扩展工作流配置、查询或运行管理能力。系统管理、网关管理 / 配额 / 用量、机器 / 沙盒管理、站点应用、完整会话管理 API 不在范围内。
8. connect 返回的 WebSocket 继续使用 ACP JSON-RPC；本版不向外部系统开放 Yjs 协议。
9. 本次范围内的旧外部 HTTP API 直接由 v1 替换并删除旧路由，不保留双版本、重定向或兼容 adapter；同步迁移仓库内调用方、示例、测试和文档。`/api/system`、`/api/auth` 保留现有接口及外部 OpenAPI 排除规则。

最小闭环：选择或配置模型 → 导入 Skill / 配置 MCP → 查询 KB → 创建并绑定 Agent → connect → 上传文件 → 对话 → 停止 / 重启。

## 2. 现状与方案选择

### 2.1 现状及必须修正的差异

| 领域 | 已有能力 | 本次修正 |
| --- | --- | --- |
| Provider / Model | Web 与 API 共用 ProviderFacade；网关是公开的系统托管 Provider 投影 | 响应补 `kind`、`gatewayType`；网关及其模型只读；修正更新默认值及模型缓存失效 |
| MCP | 三种连接类型及 CRUD 已共用 Facade | 补本地 `environment` 和启停；明确配置替换；不丢弃请求字段 |
| KB | 已有列表、状态 DTO 及 Agent 绑定 | 去掉外部全表可见；不把未检查的远端状态当作存在；绑定先校验再原子保存 |
| Agent | 已有模型、Skill、MCP、KB 绑定和节点配置 | 补记忆开关；模型绑定使用模型行 ID；资源授权与配置 / 关联的事务统一 |
| Skill | 导入已共用文件、元数据与归档编排 | 补按 ID 更新；保留完整文件补偿及稳定 ID |
| Instance | connect / HTTP 对话已使用持久 `api/primary` Instance | 统一环境和实例解析；补列表、详情、停止、重启；对话支持显式选择实例 |
| 文件 | API 仍有独立上传实现，Web 已有统一执行面 | 统一路径校验、冲突、限制、事件及审计，保留 Environment 级工作区语义 |
| 对话 | SDK 能解析响应，但仅使用最后一条 user 消息，部分参数被忽略 | 完整历史输入、标准停止原因、取消、错误和明确的参数支持范围 |

审计基线为 `c1ca64cdb9c6ba27c87d63b2ec723cd4c5bd5fd9`；书面设计时复核当前 HEAD `842139162`，相关旧 API 差异仍存在。新合入的 Sandbox 按需恢复及 OpenAPI 分组应继续复用。

前期审计共运行 247 项相关测试且通过，包括 125 项旧 API / 宿主测试和 122 项新业务边界测试；这属于历史验证记录，不代表 v1 已实现或真实端到端验收完成。尚未使用真实用户 API Key 完成网关推理、KB 检索和远程上传闭环。

### 2.2 备选方案

| 方案 | 收益 | 代价 / 结论 |
| --- | --- | --- |
| 重定义 v1 协议，独立维护应用契约并复用领域能力 | 同步当前业务，公共缺陷只修一份，Web 演进不牵动 v1 契约 | **采用**；直接替换范围内旧路由，既有业务回归迁移到 v1 |
| 旧接口只加前缀和包装体 | 改动少 | 保留业务缺陷和字段遗漏，不满足目标 |
| 对外复制全部 Web 能力并新建 Sessions / Runs 体系 | 能力全面 | 超出最小闭环，新增生命周期与存储负担，本次不做 |

## 3. 架构与职责

```text
API Key / session
        ↓
宿主认证、组织上下文、请求关联、协议错误处理、OpenAPI
        ↓
owner 包内 /api/v1 route：独立 DTO 校验、转换、响应映射
        ↓
v1 Resource Facade / Runtime 应用入口：维护 v1 契约
        ↓
与 Web 复用的领域能力 → owner Repository / 文件执行面 / Runtime Coordinator
```

| Owner | 职责 |
| --- | --- |
| `resources/agent-config` | Agent 授权、配置与绑定的原子保存；配置变更不自动重启其他用户实例 |
| `resources/model-management` | Provider / Model、网关只读规则、可见模型及缓存更新 |
| `resources/skill` | Skill 元数据、目录、归档与失败补偿 |
| `resources/mcp` | MCP 配置、启停与敏感字段的独立读写 DTO |
| `resources/knowledge` | 当前组织 KB 查询、远端状态及绑定校验 |
| `agent-runtime` | 环境 / 实例解析、生命周期、HTTP 对话、续聊句柄和 turn 租约 |
| `resources/machine` | 文件授权、路径校验、本地 / 远程执行、审计与文件事件 |
| `resources/workflow` / `resources/workflow-v2` | 各自既有执行入口的 v1 路径、DTO 包装与错误映射；继续由各自 owner 维护业务规则 |
| `apps/server` | 装配和协议聚合；不得实现资源规则或直接跨包读业务表 |

Web 与 v1 可有各自的 Resource Facade / 应用入口，分别维护 DTO、默认值、错误、编排及版本行为；不强制共用同一个 Facade。底层复用授权能力、绑定校验、原子持久化、文件执行与 runtime，不调用 Web route，不复制领域规则。跨包只经公开入口或已有注入端口，Domain Service 不接收 actor。

共享能力发生变化时必须验证 v1 契约；协议差异由 adapter 转换，行为差异由版本所属应用入口处理。若无法保持已发布行为，则发布新 API 版本，不能要求 v1 跟随 Web 破坏性变更，也不为保留旧行为复制整套 Web 业务实现。

## 4. 统一协议

### 4.1 URL、方法和 ID

- 基础路径：`/api/v1`。URL 为小写 kebab-case，资源采用复数；不修改 Web URL。
- 集合查询 GET，创建 POST，详情 GET，部分更新 PATCH，删除 DELETE；非 CRUD 生命周期动作使用子路径 POST。
- 路径参数均为稳定资源 ID，不接收资源名称、展示名或 `org/name` 文本键。
- `Agent.modelId` 指向模型表的 `id`；模型 DTO 的 `modelId` 是上游模型代码；Chat 请求的 `model` 则是 Agent 配置 ID。三者在 schema / 示例中明确区分。
- JSON 请求严格校验未知字段；仅 `extra`、模型 `options` 等明确声明的扩展对象允许自由键。PATCH 不应用创建时的默认值，空更新返回 400。
- 未出现字段表示保留；可空字段的 `null` 表示清空；关联数组 `[]` 表示解绑。显式值不能被 truthy 判断吞掉。

### 4.2 包装体与状态码

```json
{ "success": true, "data": { "items": [], "total": 0, "page": 1, "pageSize": 20 } }
```

```json
{ "success": false, "error": { "code": "NOT_FOUND", "message": "资源不存在或不可访问" } }
```

- 普通创建成功 201；查询、更新、删除、connect、停止、重启成功 200；没有业务数据时为 `data: null`，不采用 204。
- 列表统一 `page`（默认 1）和 `pageSize`（默认 20，最大 100）；过滤、计数和分页在数据库完成。固定稳定排序，不开放未经定义的任意列排序。
- 认证、schema 校验、请求体大小、路由异常、404 均遵守所命中协议的错误体；不能只包装正常 handler 返回值。
- 400：请求结构、绑定或不支持参数；401：认证失败；403：可见但禁止动作；404：不存在或不可见；409：冲突 / 生命周期状态不允许；413：请求或文件过大；422：已保存运行配置不可用；429：配额 / 并发限制；503：依赖或文件服务不可用；504：请求超时；未知故障 500。
- 使用已有错误类的状态及语义，文件域错误在 adapter 处映射为稳定 v1 错误码。服务端保留原始错误与 requestId，对外不透出堆栈、凭据、命令、内部路径或上游原始响应。

### 4.3 认证、授权与读 DTO

1. 推荐 `Authorization: Bearer <API_KEY>`；沿用宿主认证顺序，不新增系统密钥或下载签名密钥用途。
2. API Key 的组织入口来自 metadata 并重新验证成员关系，角色读取当前成员表；客户端组织 header / query 不得越过凭据范围。
3. 每次执行重新校验 Agent 可使用性、Instance owner、Environment 组织及 Agent 绑定；不能因为 runtime 已运行而跳过权限校验。
4. Agent / Provider / Skill / MCP 响应使用独立 v1 DTO，带公共 `scope` 和 `access.actions`；不再返回旧 `resourceAccess`，也不直接复用页面 DTO。模型继承 Provider 的授权；KB 不伪造 `visibility` 或平台授权字段。
5. `publicReadable` 沿用当前配置写入含义；响应从权威 scope 推导。资源可见不代表可修改或可用组织凭据探测。
6. Provider 密钥只写不回显，返回 `hasApiKey`；MCP 的 header / environment 值及 OAuth clientSecret 只写不回显，另给键名及已配置状态。空缺表示保留的规则仅适用于资源 PATCH 顶层，不代表完整 `config` 替换会自动保留密钥。
7. 日志与外部 DTO 不包含 Skill 源绝对路径、Environment secret、relay token、完整 ACP session ID、KB 远端账户凭据。网关运行凭证仍按当前调用者在启动流程中取得。

## 5. v1 接口清单

下表均相对于 `/api/v1`。Agent 最小闭环共 33 项操作，加上 External Workflow 协议统一的 2 项，共 35 项；MCP 探测等候选能力不计入本次必交付清单。

| 资源 | 方法与路径 | 操作数 |
| --- | --- | --- |
| Agent | `GET /agents`、`POST /agents`；`GET /agents/:id`、`PATCH /agents/:id`、`DELETE /agents/:id` | 5 |
| Provider | `GET /providers`、`POST /providers`；`GET /providers/:providerId`、`PATCH /providers/:providerId`、`DELETE /providers/:providerId` | 5 |
| Model | `GET /providers/:providerId/models`、`POST /providers/:providerId/models`；`GET /providers/:providerId/models/:id`、`PATCH /providers/:providerId/models/:id`、`DELETE /providers/:providerId/models/:id` | 5 |
| Skill | `GET /skills`、`POST /skills`；`GET /skills/:id`、`PATCH /skills/:id`、`DELETE /skills/:id` | 5 |
| MCP | `GET /mcp-servers`、`POST /mcp-servers`；`GET /mcp-servers/:id`、`PATCH /mcp-servers/:id`、`DELETE /mcp-servers/:id` | 5 |
| KB | `GET /knowledge-bases` | 1 |
| Instance | `POST /agents/:agentId/instances/connect`、`GET /agents/:agentId/instances`、`GET /instances/:id`、`POST /instances/:id/stop`、`POST /instances/:id/restart` | 5 |
| 文件 | `POST /environments/:environmentId/workspace/files` | 1 |
| 对话 | `POST /chat/completions` | 1 |
| External Workflow | `POST /workflows/:workflowId/execute`、`POST /workflow-v2/workflows/:id/run` | 2 |

Provider 分页列表 → Provider 下模型列表已满足模型选择，无需首版再增加平铺模型目录。暂不增加外部 Instance 创建 / 删除、Environment CRUD、KB 详情 / 管理、MCP tools / inspect / test-url、Provider 模型自动发现或探测；其中 MCP 连接测试优先作为下一批增量。

## 6. 资源契约

### 6.1 Agent 与绑定

| 字段 | 创建 / 更新语义 |
| --- | --- |
| `name` | 创建必填；首版创建后不通过 v1 重命名，PATCH 不接收，避免只改元数据而遗漏内部名称依赖 |
| `modelId` | 模型行 ID；允许 null，沿用已有默认模型解析规则；闭环示例显式指定 |
| `prompt`、`description`、`extra` | 可选；null 清空；extra 为明确的扩展配置 |
| `agentNode` | `{}` 使用平台默认节点；或 `{ kind: "machine", machineId }` / `{ kind: "sandbox", sandboxPoolId }`，按当前节点规则验证 |
| `skillIds`、`mcpIds` | 仅接收资源 ID；显式数组整体替换，各自缺席保持原绑定 |
| `knowledge` | `{ knowledgeBaseIds, policy? }`；null 或空 ID 数组解绑；不新增 KB |
| `enableMemory` | 创建默认 false；更新缺席保持，读回真实开关；只管理已有记忆配置，不暴露 Hindsight 管理接口 |
| `publicReadable` | 公开受众开关，权限与 Web 相同 |

详情返回全部可写字段及 `id`、`builtIn`、`scope`、`access`；列表返回 `id/name/description/modelId/agentNode/knowledgeBaseCount/scope/access`。不保留已废弃的 `model` 文本引用，不引入页面标签或站点绑定字段。

绑定保存流程：

1. 在持有 actor 的应用入口校验目标 Agent 的动作权限；Model 经 Provider 授权，Skill / MCP 经其 owner Facade，KB 经 knowledge 的组织校验。有效 UUID 不等于已授权。
2. 先验证全部请求与绑定集合；同一数组重复 ID 返回 400，不静默过滤无效名称或资源。
3. 经 `@fenix/platform-sdk/server` 的 `runInTransaction()` 保存 Agent 行、记忆开关和本次显式出现的全部关联；更新锁定 Agent 行，避免并发替换交叉混合。KB 使用 Agent 所属组织的已有库，调用者必须有该 Agent 的更新权。
4. 失败回滚数据库更改；创建失败不留下空 Agent，绑定失败不清空旧绑定。KB 远端调用、文件写入及 runtime 重启不放在数据库事务中。
5. 并发 POST 的同组织同名冲突由数据库唯一约束原子返回 409，不采用“预查询 + upsert 覆盖”。普通并发 PATCH 按提交顺序生效，不引入新版本列。

修改配置或关联不会自动改变运行中的进程；调用方显式重启自己的实例使其加载新配置。删除 Agent 沿用既有内置资源保护及 strict stop / 清理编排，不绕过其他实例生命周期。

### 6.2 Provider / Model 与网关

- Provider 创建字段：`name`、`displayName?`、`protocol?`（创建默认 openai）、`baseUrl?`、`apiKey?`、`extraOptions?`、`publicReadable?`。PATCH 除 name 外均可选，不设置默认 protocol。
- Provider 列表包含 `id/name/displayName/kind/gatewayType/protocol/baseUrl/modelCount/hasApiKey/scope/access`；详情增加 `extraOptions`，子模型通过独立分页接口获取，避免详情加载全部模型。`kind` / `gatewayType` 为只读。
- Model 保留 `id/providerId/modelId/displayName/modalities/limitConfig/cost/options`；创建时 `modelId` 为必填上游代码，PATCH 不重命名该代码，其他配置可更新。
- Model ID 必须属于路径中的 Provider；外部不能借子模型路径读写其他 Provider 的数据。
- 网关 Provider 由现有系统初始化 / 同步路径维护；v1 只读取本地投影，不在列表请求中请求上游。未初始化无网关行，未同步可能无模型，不把这种状态伪装成网关不可读。
- `kind: gateway` 的 Provider 及模型禁止用户写入，即使调用方在系统组织有管理角色。网关凭证不在 Provider 响应中，正常运行继续调用现有凭证服务。
- Provider / Model 成功写入后统一失效可用模型缓存，Web 与 v1 共用同一提交后动作；网关同步使用同一失效入口。事务失败不发布成功事件。既有多进程缓存仍受现有 TTL 约束，不新增分布式缓存系统。

### 6.3 Skill

- `POST /skills` 保留单 Skill 目录导入：multipart 的 `manifest` JSON 字符串、重复 `files` 字段、可选 `overwrite=true|false`；manifest 与文件一一对应，保留二进制原字节。
- 默认同名返回 409；显式 overwrite 仅覆盖本组织且有 update 权限的资源，保留其 ID 和受众。新建 201，覆盖已有资源 200；并发覆盖在同一 Skill 维度串行，不混合目录内容。
- `PATCH /skills/:id` 接收 `content?`、`description?`、`metadata?`、`publicReadable?`，按 ID 更新已有 SKILL.md；metadata 为字符串字典，显式对象整体替换。附件目录更新继续使用显式覆盖导入。
- 创建、更新、导入、删除均通过现有 Skill Facade 和内容编排，保留文件快照、归档处理与失败补偿，不直接 upsert 元数据。
- 列表 `id/name/description/scope/access`，详情增加 `content/metadata`，不暴露源绝对路径。删除仍按现有引用与文件清理规则执行。

### 6.4 MCP

创建使用 `{ name, config, publicReadable? }`，config 按 type 为严格联合：

| type | 字段 |
| --- | --- |
| `local` | `command: string[]` 必填且非空；`environment?: Record<string,string>`、`timeout?: number`、`enabled?: boolean` |
| `remote` | `url` 必填；`headers?`、`oauth?: object | false`、`timeout?`、`enabled?` |
| `streamable-http` | `url` 必填；`headers?`、`timeout?`、`enabled?` |

- PATCH 使用两个互斥形状：`{ enabled: boolean }`，或 `{ config: 完整连接配置, publicReadable? }`；仅修改受众可使用 `{ publicReadable }`。禁止启停与配置替换混在同一请求。
- `config` 是一个完整连接配置字段，替换时不深合并；必须重新提供该类型全部必要字段及所需凭据。只传 timeout 或 headers 不构成完整连接配置，返回 400，不写入。
- 单独启停只改启用状态，保留原连接配置；历史仅有 disabled 标记的行不可直接启用，要求先补全配置。
- 列表包含 `id/name/type/enabled/summary/toolsCount/scope/access`；详情返回脱敏配置及 `headerNames/environmentNames/hasClientSecret` 等只读凭据状态，不返回密钥或可误提交的掩码。
- 工具缓存仍由当前业务维护；v1 不声称已检测 / 可连接。MCP 配置、开关变化在实例重启后应用。

### 6.5 已有 KB

- 列表只查询当前 API Key 组织的知识库，分页及 total 使用同一组织谓词。旧代码的“global = 不加 WHERE”不属于可继续保证的共享语义。
- 返回 `id/name/description/provider/status/resourcesCount/bindingsCount/embeddingModel/parseMethod/chunkMethod/remoteExists`；不包含远端账号、创建者凭据或 lastError 原文。
- `status` 保留本地业务状态；`remoteExists` 是 `true | false | null`：确认存在、确认不存在、未验证 / 上游不可达。不能以本地 ready 代替实时远端存在性。
- 复用现有 provider 检查能力，对当前页做有界并发和超时的远端检查；检查失败时保留本地信息，返回 null，不误标为不存在。普通列表不顺带回填本地配置。
- 绑定校验确认本地存在且属于 Agent 所属组织，不把远端临时网络故障变成永久解绑或拒绝保存；远端不可用在真实运行时明确报错。
- Web 与 v1 共享 KB 查询和绑定领域规则。删除旧外部查询路由，v1 按组织收紧查询范围，并使用统一包装体。

## 7. Instance 与文件闭环

### 7.1 connect 和实例选择

`POST /agents/:agentId/instances/connect` body 为 `{ instanceId?: string }`，不再使用 `instanceUid` 作为外部入参名。

```json
{
  "success": true,
  "data": {
    "agentConfigId": "<agent-config-id>",
    "environmentId": "<environment-id>",
    "instanceId": "inst_<opaque-id>",
    "status": "running",
    "runtimeGeneration": 1,
    "relay": { "wsUrl": "/acp/relay/<environment-id>?instanceId=inst_<opaque-id>" }
  }
}
```

1. 显式传 instanceId：先按当前用户读取持久实例，再验证 Environment 组织、Agent 绑定和 Agent 使用权限；直接采用它所属的 Environment，不能先随意选环境再把合法实例判为不匹配。
2. 未指定：解析当前组织 / 用户 / Agent 的 Environment，再 find-or-create 持久 `api/primary`。API 默认实例与 `chat/default`、`workflow/primary` 分开。
3. 多个已有匹配 Environment 时按 `createdAt`、`id` 固定选择，不依赖无序第一条；connect 与 Chat 共用同一解析入口。
4. 首次环境准备按组织 / 用户 / Agent 使用数据库事务级 advisory lock 串行，复用现有 Environment 服务；自动名称不与其他用户冲突。事务提交后才启动 runtime，不新增环境绑定表。
5. 自动实例复用已有 creation key 唯一约束；Coordinator 处理 singleflight、generation、停止 / 重启仲裁和现有 Sandbox 按需恢复。
6. 显式 HTTP 实例允许当前用户的 api / user 来源实例，禁止接管 workflow 来源实例。首版不创建额外实例或扩大实例管理权限。

`relay.wsUrl` 指向现有 ACP JSON-RPC 中继，沿用 ACP 会话请求与事件契约，不加普通 HTTP 的 `{ success, data / error }` 包装体。外部客户端通过此连接使用 ACP；Web Chat 的 `/acp/yjs/:agentId` 文档同步与平台对话命令不属于本版对外契约。

返回的 relay 地址使用现有认证机制，没有 bearer query 或一次性 relay token；ACP / relay 保持独立协议前缀。HTTP 路径不接受客户端 cwd。relay 对外 ACP 输入涉及 cwd 的动作也必须按认证后的 Environment 校验 / 注入，不把原始透传当作绕过工作区边界的理由。

### 7.2 实例查询与生命周期

- Agent 实例列表按当前用户、当前组织、Agent 及允许的 creationSource 在数据库过滤分页；GET 查询不创建环境、不启动实例。
- 详情及列表项返回 `instanceId/agentConfigId/environmentId/name/creationSource/isDefault/status/runtimeGeneration/createdAt/updatedAt`，时间为 ISO 8601 UTC；不返回内部 lastFailure 原文。
- status 使用现有 `stopped/starting/running/stopping/unknown`，不增加假状态或把持久记录存在等同于运行中。
- stop 使用 strict 模式，成功才返回 `data: null`；重复停止已确认停止的实例成功，停止失败保持 unknown，不谎报停止或删除记录。
- 手动停止后 connect / Chat 返回 409 `INSTANCE_STOPPED`；显式 restart 才解除停止意图。自动空闲回收后可以按现有 ensure 规则重新启动。
- restart 保留 instanceId，使用新 runtimeGeneration，返回最新实例详情；旧 turn 失败、旧续聊句柄失效。客户端超时不能保证重试 restart 仍是同一次动作，应先查询状态。
- 文件不随一次 HTTP 对话结束或普通 runtime 重启而删除；底层 Sandbox 销毁后的存储保留能力遵从现有 Sandbox 契约，不承诺额外持久化。

### 7.3 文件上传

- multipart 字段保留 `files`、`path?`（默认 `user`）、`relativePaths?`（JSON 数组）；数组出现时数量必须与 files 一致。v1 首版只写 `user/` 子树。
- 通过 v1 文件应用入口复用 AgentFileService 与底层文件执行能力；路径范围、限制与错误映射由 v1 契约约束，不随 Web 入口变化。审计 `source: api`、actorId 取认证用户，不复制本地写盘或远程上传逻辑。
- 批次写入前校验所有路径、文件名、大小、重复目标；拒绝绝对路径、`..` 段、控制字符、symlink 逃逸。复用当前词法和 realpath 校验。
- 单文件上限为当前公共常量 92 MiB；整次 multipart 受宿主 108 MiB 传输上限限制，远程单帧批次还受现有合计 92 MiB 原始字节限制。错误码均为 413，不能只写“每个文件都未超限”就承诺整批可上传。
- 本地 / 远程同名均返回 409 `PATH_CONFLICT`，不静默覆盖；变更事件及 actor/source 透传与 Web 一致。远端未确认具备冲突保护时，不能以一次无锁 stat 预检冒充原子保护，应补齐已有机器执行动作的排他创建语义后验收。
- 上传不是跨文件事务：写入前校验能避免输入错误造成部分落盘，执行中磁盘 / 网络故障仍可能部分完成；对这类失败不承诺整批回滚，不自动重试，不返回虚假的全批成功。重试冲突需由调用方核对。
- 响应 `data: { environmentId, files: [{ name, path, size }] }`，path 为工作区相对路径。配置远程机器但 file-ws 不可用时返回 503，不回退本地文件系统。

## 8. OpenAI SDK 对话契约

### 8.1 入口与支持范围

```ts
const client = new OpenAI({ apiKey, baseURL: "https://fenix.example.com/api/v1" });
const result = await client.chat.completions.create({
  model: agentConfigId,
  messages: [
    { role: "user", content: "请总结 user/input.txt" },
  ],
  stream: false,
});
```

支持的请求字段是 `model`、`messages`、`stream?`（默认 false）、`n?`（只接受 1）。messages 支持 system / developer / user / assistant 的纯文本 content，最后一条必须是非空 user 消息；system / developer 只允许在历史开头，user / assistant 历史保持输入顺序。

不支持多模态 content、tool / function 消息、调用方 tools、采样 / token 上限参数、response_format、logprobs、store 或 stream_options；传入这些字段明确返回 OpenAI 400 `invalid_request_error`，不静默丢弃。SDK 可解码不等于实现 OpenAI 全量 API；本版保证声明的纯文本 Chat Completions 子集。

Agent 工具由已绑定 Skill / MCP / KB 决定，采样等运行配置仍由 Agent / 模型配置控制。OpenAI SDK 的 Models、Responses、Files 接口不属于本次兼容承诺。

### 8.2 无状态完整历史与可选续聊

| 模式 | 请求 | 行为 |
| --- | --- | --- |
| 标准模式 | 不带 `X-Session-Id`；messages 为完整历史 | 每次新建独立 ACP session；完整文本历史一次送入 Agent，不隐式复用前次对话 |
| 平台续聊扩展 | 带响应返回的 `X-Session-Id`；messages 恰好一条 user | 恢复同一受控会话，只追加本轮输入；带历史数组时返回 400，防止重复追加 |

- 两种模式均可用 `X-Instance-Id` 指定已授权实例；未指定时，标准模式选择 api/primary，续聊模式从平台句柄恢复实例并重新授权。
- `X-Session-Id` 为不可猜测的 `fcs_` 平台句柄，**不是** ACP `ses_*`，也不是 RCS session ID。响应返回 `X-Instance-Id`、`X-Session-Id`、`X-Session-Expires-At`、`X-Request-Id`，保持响应 JSON 原生。
- 句柄仅在服务端映射到组织、用户、Agent、Environment、Instance、runtimeGeneration 和 ACP session；持有句柄不能替代 API Key 或资源授权。
- 首版复用当前单宿主运行控制面的进程内状态，句柄从创建或最近一次续聊请求获准时起有效 30 分钟，每组织 / 用户最多 256 条、进程最多 10000 条；到期或容量不足时回收最久未使用的空闲条目，活动 turn 不回收。新请求在发送 prompt 前预留容量，全部活动占满时返回 429，不能先执行再发现没有容量。
- 服务重启、实例 generation 变化、停止、会话不可恢复、取消或执行失败使句柄失效；句柄错误 / 不属于当前主体统一 409 `SESSION_UNAVAILABLE`，不尝试把输入作为原始 ACP ID。合法句柄与显式 Agent / Instance 不一致也拒绝，不切到另一实例续聊。
- 进程重启后会话扩展不保证恢复；多宿主部署需将同一实例请求路由到其运行控制 owner，未命中句柄不得新建会话伪装续聊。跨宿主持久恢复不在首版承诺内，标准完整历史模式不依赖该映射。
- 输入完整历史通过独立的文本上下文适配器按角色、顺序及转义后的内容组装；不是只挑最后一条 user，也不把历史 assistant 内容伪装成新用户输入。ACP 只有 prompt 内容块，本版不声称它等价于上游模型原生 role 消息接口；Agent 配置的系统约束仍保持权威。
- 对话复用 `openAgentSession`、现有 relay、`startPromptTurn` 与 `acquireAgentSessionTurn`；会话确认结果仅在服务端暴露给受控句柄映射，不能新写 session/new / load / prompt 协议流程。
- 同一会话同时发起第二个 turn 返回 409 `AGENT_SESSION_BUSY`；不同会话依当前执行配额并行。取消未确认时保留原有执行 / 会话占用规则，不提前释放形成重叠 prompt。
- 并发隔离以 Instance 与会话为边界：不同实例可同时运行，同一实例内不同会话也可同时聊天，不增加实例级全局对话锁。请求 / ACP 事件必须准确归属对应会话；一个会话取消、超时或失败不取消其他会话，也不释放其占用。停止 / 重启实例则影响该实例的全部会话，不影响其他实例。会话并发不代表独立文件工作区，workspace 仍按 Environment 归属解析。

### 8.3 响应、流式与失败

- 非流式使用 `chat.completion`；流式使用 `text/event-stream` 的 `chat.completion.chunk`，包含稳定 id / created / model / choices。model 为请求中的 Agent ID。
- 流式首块声明 assistant role，后续 content 为增量文本，终块给标准 finish_reason，成功结束发送 `data: [DONE]`。
- ACP 自然结束 `end_turn` 映射 `stop`，长度终止映射 `length`；未知终止不伪造正常完成。平台内部工具执行不会对外生成假 tool_calls 或把工具 XML 混进回答。
- 内部思考、plan、工具参数及结果不默认混入 assistant content；只映射可展示的 Agent 文本消息。没有真实 token 统计时不返回伪造的 usage 全零对象。
- 普通 JSON 错误为 `{ error: { message, type, param, code } }`，code 保留平台可判定错误；禁止出现 success / data 包装。
- 认证、参数、实例 / 会话、运行就绪和 ACP 握手在发送流式成功响应头前完成；此前失败正常返回对应 HTTP 状态。流开始后失败发送原生 error 事件数据并关闭，不伪造成功终块；客户端断连时无法保证错误事件送达。
- 连接中断、AbortSignal 或默认 300 秒总超时取消当前 turn；等待就绪、握手、事件读取都纳入预算，SSE 背压与 listener / relay 租约必须有界释放。请求释放不停止共享 runtime。
- 沿用 runtime / session 配额；不自动重试 prompt，不在响应中断后重放。CORS 暴露上述响应头及现有 Retry-After，不增加通配敏感凭据。

OpenAI 协议依据：[Chat Completions 官方参考](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。兼容测试使用仓库现有 `openai` SDK，而非只比较手写 JSON。

## 9. External Workflow、旧接口替换与规范同步

### 9.1 External Workflow 两个接口

仅统一现有两个执行接口的 URL 版本与 HTTP 包装体，不合并引擎，不新增工作流能力：

| 当前路径（交付时删除） | v1 替换路径 | 保留的执行契约 |
| --- | --- | --- |
| `POST /api/workflows/:workflowId/execute` | `POST /api/v1/workflows/:workflowId/execute` | 旧引擎；`inputs / mode / version / timeout`，同步 / 异步执行及版本解析规则 |
| `POST /api/workflow-v2/workflows/:id/run` | `POST /api/v1/workflow-v2/workflows/:id/run` | 新引擎；`parameters / isAsync / ext`，已发布版本运行、限流、审计、API 渠道自愈规则 |

路径中的 `workflow-v2` 是现有业务模块名，`/api/v1` 才是本次外部 HTTP API 的版本；两类工作流标识及引擎不互通。

- 两者成功响应均为 HTTP 200、`{ success: true, data: <原执行结果> }`；同步与异步原有结果字段和可空语义保持不变，不为包装统一额外改成 201 / 202。
- 旧引擎的 `SUCCESS / FAILED / TIMEOUT` 是执行结果状态，继续放在 `data.status`。正常取得失败结果或同步等待超时仍为 `success: true`；`TIMEOUT` 仍表示停止等待、后台继续运行。请求被拒绝或服务异常才使用顶层 `success: false`。
- 旧引擎结果中的 `error` 如存在，保留在 `data.error`；对外 message 须经过既有安全映射，不透出原始异常。
- 新引擎原有输出字段也叫 `data`，保留为 `data.data`，不把上游 JSON 字符串自动解析或重命名；`executeId / token / cost / debugUrl` 继续位于外层包装体的 `data` 内。
- 错误统一为 `{ success: false, error: { code, message } }`。保留各自既有状态码与错误语义，包括工作流 422 参数校验、409 未发布 / 渠道拒绝、429 与 `Retry-After`、502 / 503 / 504 上游故障；通用认证与框架错误也必须使用新包装体。
- 认证与组织上下文仍复用宿主守卫；本地主键解析、跨组织同形 404、调用者配额和用户身份传递均保持有效，不把改包装当作绕过现有校验的入口。

新引擎成功示例：

```json
{
  "success": true,
  "data": {
    "executeId": "<execute-id>",
    "data": "{\"answer\":\"ok\"}",
    "token": 12,
    "cost": "0.01",
    "debugUrl": null
  }
}
```

### 9.2 OpenAPI 与替换安排

1. 每条 v1 路由声明适用的 params / query / headers / body / response / security / detail；multipart 使用真实 binary schema，Chat 声明 200 JSON 与 SSE 两种媒体类型，不出现“没有成功响应定义”。
2. 继续使用宿主 `/docs/openapi/external` 和 `/docs/openapi/external/json`，按最终完整路径聚合；保留现有 `/api/system`、`/api/auth` 及其子路径排除规则，External Workflow 分组仅展示替换后的两个 v1 接口。
3. v1 交付直接删除本次范围内旧外部 HTTP 路由，包含 Agent 配置与运行、Provider / Model、Skill、MCP、KB、文件上传、Chat Completions 及上述两个工作流执行接口。不保留裸响应版本、转发 shim、重定向或双版本 adapter。
4. 同批迁移 API 示例、脚本、内部调用方、测试和外部指南中的路径 / 包装体；建立实际旧路由到 v1 的替换清单，验证已删除路径不能继续调用旧 handler，OpenAPI 不残留旧 operation。用户已确认直接替换，不把未知外部消费者作为保留旧路由的条件。
5. ACP relay 是独立协议入口，仍按第 7 节保留；`/web/*`、`/api/system`、`/api/auth` 及本次范围外的协议入口不随旧外部 HTTP 路由删除。KB 全表读取在 v1 收紧为当前组织，不保留旧隔离缺陷。
6. 已同步 `AGENTS.md`（链接到 `CLAUDE.md`）、`docs/developer/system/backend-development.md` 和 `docs/developer/architecture/engineering-standards.md` 的长期规则：外部资源 API 版本化、普通接口统一包装体、特殊协议例外，以及复用领域能力、分别维护契约。本次旧路由直接替换、暂不开放 Yjs、工作流字段处理等具体决策仅保留在本设计中。规范更新不表示运行实现已完成，落地时仍须同步 schema、调用方和 OpenAPI。
7. 实现后将稳定事实落入 `docs/arch/` 的 Agent 配置、Provider、Skill、MCP、文件及实例文档，并更新 `external-api.md` / `external-agent-session-guide.md`。本设计稿不提前把未落地能力声明为现状。

## 10. 交付切片与验收

### 10.1 垂直切片

| 切片 | 可观察结果 | 包含的公共修复 |
| --- | --- | --- |
| A：选择模型并创建 Agent 后完成一次 SDK 对话 | Provider / Model 查询、Agent 基础 CRUD、v1 envelope、无状态 Chat 可用 | Provider 默认值 / 冲突、权限复验、缓存、完整历史与原生响应 |
| B：绑定能力并上传资料后完成带工具对话 | Skill / MCP CRUD、KB 列表及 Agent 绑定、connect / 上传可用 | 绑定授权 / 事务、MCP 字段、KB 范围 / 状态、文件执行一致性 |
| C：运行管理与续聊 | 实例列表 / 详情 / 停止 / 重启、续聊句柄、错误及取消闭环 | generation / 手动停止 / 租约、句柄有界生命周期、文档和消费者迁移 |
| D：External Workflow 协议统一与替换收口 | 两个执行接口迁到 v1 并统一包装；范围内旧 HTTP 路由全部删除 | 工作流成功 / 失败 / 超时语义、限流与上游错误保持；调用方及 OpenAPI 同步迁移 |

每个切片贯穿协议、应用入口和真实行为验证，不先铺完所有 route 再联调。

### 10.2 必须覆盖的验收行为

| 场景 | 预期 |
| --- | --- |
| 网关查询与绑定 | 外部可见已同步 Provider / Model，识别 gateway；绑定模型行 ID 可启动，凭证不外泄；任何网关写入失败 |
| Provider 增量更新 | Anthropic Provider 只改 displayName 后仍为 anthropic；并发同名创建至多一条成功，冲突不覆盖 |
| PATCH 保留语义 | 修改 prompt 不清空关联；MCP 启停保留 environment / headers / OAuth；完整 config 缺必要字段时拒绝且原值不变 |
| 配置与关联事务 | 不存在、不可见、跨组织 KB 或其他非法绑定不造成部分保存；注入关联写入失败时保留原配置及关联 |
| Skill 文件一致性 | 导入与覆盖保留二进制；覆盖 ID 不变；文件 / DB / 归档失败走已有补偿，无半成品 |
| KB 状态 | 只返回当前组织；远端不存在为 false、不可达为 null；检查不修改本地配置 |
| 身份与隔离 | 两组织同名资源互不误操作；同一 Agent 的不同用户使用不同 Environment / Instance / workspace；公开 Agent runtime 复用仍复验权限 |
| 并发 connect | 同组织 / 用户 / Agent 的并发首次连接不创建重复默认环境和 api/primary；显式实例正确反查环境 |
| 多实例并发 | 使用同一 Agent、当前调用者已有且可授权的两个不同 Instance，并发 connect 与 Chat；在配额允许时两者均可进入执行，instanceId / runtimeGeneration / 会话句柄及回复正确归属，无串流或错误复用；停止 / 重启其中一个实例不影响另一个实例的在途聊天及后续使用 |
| 同实例多会话并发 | 同一 Instance 下至少两个不同会话的 turn 执行时间重叠，在配额允许时均正常执行，不误报 AGENT_SESSION_BUSY，不被实例级锁整体串行；覆盖两个无句柄请求各建独立会话，以及两个不同续聊句柄同时继续对话；历史、文本增量、工具事件、结束信号和响应头不串会话 |
| 多实例多会话并发 | 至少两个不同 Instance、每实例至少两个不同会话交错收发；覆盖流式与非流式请求混合，以及不同 ACP 会话在 relay 上的并行交互；响应、ACP 请求回执与会话事件均路由到正确调用方，不能只验证每条请求最终成功 |
| 并发失败与回收 | 多会话执行期间取消、断连、超时或注入单会话故障，只影响目标会话；其他在途会话可继续完成及续聊；配额超限稳定返回 429，不挤掉已接纳请求；单会话完成不停止共享 runtime、不释放其他会话的 lease / listener / 配额，全部收口后占用回到基线；实例停止 / 重启只使该实例全部会话终止或失效 |
| ACP 连接 | connect 返回已认证实例的 ACP relay 地址；可完成会话创建、prompt 与 update 事件接收；消息沿用 ACP 契约，不包装为 HTTP envelope，不切换为 Yjs |
| 生命周期 | strict stop 失败不报成功；手动停止后 connect / Chat 为 409；重启保留 instanceId、改变 generation、使旧句柄失效 |
| 文件一致性 | 本地 / 远程冲突均不覆盖；92 MiB 单文件、108 MiB 请求与远程合计限制分别验证；越界 / symlink 拒绝；事件和审计一致，无远程静默回退 |
| SDK 完整历史 | 多轮历史实际传到 Agent；非流式及流式可由现有 SDK 消费；无 XML、内部思考、非标准结束原因或虚假 token 数 |
| SDK 失败 | 不支持参数返回原生 400；401 / 409 / 413 / 429 / 503 / 504 / 500 结构正确；SSE 中断及取消不泄漏监听器、不停止共享 runtime |
| 续聊 | 新句柄可追加一轮；完整历史与句柄混用被拒；跨用户 / 组织 / 实例 / Agent / generation、过期句柄均不能恢复；同会话重入 409 |
| 工作流协议 | 两引擎同步 / 异步均匹配新 envelope；旧引擎 FAILED / TIMEOUT 为 data 状态，新引擎保留 data.data；认证 / 跨组织 / 422 / 429 / 上游错误及 Retry-After 不丢失 |
| 版本契约独立 | Web 的 DTO、默认值、错误或编排变化后，已发布 v1 的相应行为仍通过固定契约回归；共享领域能力更新同时验证两入口，不以跟随 Web 改动作为 v1 验收标准 |
| 文档与替换 | 实际 HTTP 响应匹配 schema；OpenAPI 有 Bearer security、multipart 请求体与 Chat 成功媒体类型；范围内旧 handler 不再可达，文档只列新路径，system / auth 排除规则保持 |

验证顺序：针对性行为 / 回归测试 → 带真实认证的本地集成 → 真实网关 / KB 工具 / 远程文件闭环 → `bun run fastcheck` → 发布或提交前 `bun run precheck`。修改文档运行 `bun run docs:build`；若实现实际修改前端，再执行 `bun run build:web`。

真实联调至少使用两个组织、同组织不同角色、同 Agent 不同用户，并记录 requestId 与持久 Instance ID；禁止把真实密钥写入测试、示例、日志或文档。基础设施缺失时报告未验收项，不能用 stub 通过代替真实闭环。

并发验收以不同会话并行聊天为主要目标；同会话重入 409 只是保护边界，不能替代多会话并发验收。自动化测试用可控屏障等待所有目标 turn 均已进入执行，再交错推送带不同标记的回复并注入取消 / 故障；不得仅用 Promise.all 发请求却让 stub 顺序完成。真实联调也必须记录至少两个 turn 的执行区间确有重叠，并验证取消一个会话后另一个仍完成。测试复用已有实例创建能力准备多实例，不因此新增外部实例创建 API；同 Environment 共享 workspace 的实例 / 会话使用不同测试文件，消息隔离不能被误写成文件系统隔离保证。

## 11. 可观测与回滚

- 沿用现有结构化日志和 trace，记录协议版本、路由模板、requestId、actor / organization、agentConfigId、instanceId、runtimeGeneration、阶段、耗时及错误码；不记录凭据、原始 ACP 会话 ID 或整段用户消息 / 文件内容。
- 重点观察配置保存失败 / 回滚、授权拒绝、网关启动失败、文件冲突、runtime unknown、会话忙、超时 / 取消与句柄回收；复用现有观测入口，不另建指标平台。
- v1 协议聚合及跨层应用能力按切片交付，发布前同步迁移调用方；运行时不保留旧 adapter。若回退发布，需同时回退服务与受控调用方版本，避免路径 / 包装体错配。回滚代码不删除资源、不做数据回填或逆迁移。
- 本次无 DDL，因此无需数据迁移；已修正的跨组织隔离规则不通过回滚恢复为全表可见。若实现发现必须变更表结构，应先单独说明业务必要性并取得批准。

## 12. 主要实现依据

| 范围 | 当前源码 / 文档 |
| --- | --- |
| Agent / 绑定 | `packages/resources/agent-config/src/server/{facades,routes/api,routes/web/config,services/agent-associations.ts}` |
| Provider / Model | `packages/resources/model-management/src/server/{facades,routes/api/models.ts,routes/web/config,model-gateway,services/available-models-cache.ts}` |
| Skill / MCP | 各自 owner 包的 `src/server/{facades,routes/api,routes/web/config}` |
| KB / 绑定 | `packages/resources/knowledge/src/server/{facades/knowledge-base-facade.ts,services/agent-knowledge.ts,services/knowledge-base-list.ts,repositories/knowledge-base.ts}` |
| Instance / 对话 | `packages/agent-runtime/src/{routes/api,services/agent-chat-service.ts,services/agent-prompt-turn.ts,services/agent-session-admission.ts,server/services/api-instance.ts,server/services/agent-instance-service.ts}` |
| 文件 | `packages/resources/machine/src/server/{facades/machine-file-facade.ts,services/agent-file-service.ts,services/file-backends.ts,services/api-workspace.ts}` |
| External Workflow | `packages/resources/workflow/src/server/{routes/api/workflows.ts,schemas/api-workflow.schema.ts,services/workflow/workflow-execute.ts}`；`packages/resources/workflow-v2/src/server/routes/api/workflows.ts` |
| 稳定约束 | [实例管理](../arch/22-agent-instance-management.md)、[工程规范](../developer/architecture/engineering-standards.md)、[后端规范](../developer/system/backend-development.md) |

本稿明确的协议子集、生命周期和失败语义作为后续实现计划与验收依据；实现尚未开始，现有外部指南继续描述已上线旧接口。
