# 模型网关一期设计

> 状态：已评审、已实现；日期：2026-08-26；最后按实现校准：2026-09-01

## 1. 目标与范围

Fenix 通过一个系统维护的 Gateway Provider 将 LiteLLM 模型提供给全部 Agent。LiteLLM 负责上游模型、Virtual Key、用户预算和用量事实；Fenix 负责 Provider/Model 投影、租户权限、运行时凭证注入、预算管理和用量归因。

一期支持：

- 管理员跳转 LiteLLM 配置模型，检查差异并手动同步模型目录；
- 用户跨 Organization、Agent 和模型共享的 USD 全局预算；
- Agent 首次使用时懒创建并复用 Virtual Key；
- 管理端按组织、用户、Agent、模型查看用量；
- 用户从 Gateway Provider 进入“我的用量”；
- 管理员在 Key 管理页人工核对并回收无用或需手动失效的 Key。

一期不做：多 Gateway Provider 策略、Organization/Team 预算、模型 CRUD、用量明细导出、用量流水镜像、定时 Key 对账和实时权限变更反向禁用。

## 2. 核心规则

### 2.1 系统 Provider 与模型

- 系统 Provider 的稳定名称为 `fenix-model-gateway`，`kind=gateway`、`gatewayType=litellm`；默认展示名为“全局模型网关”。
- Provider 是 Fenix 的公开只读资源；普通 Provider 管理接口不能修改或删除它。
- Provider 不保存共享调用密钥，`apiKey` 为空。每次 Agent 启动按主体取得专属 Key。
- LiteLLM 模型目录是事实来源；Fenix `model` 表仅保存 Agent 可选择的投影。
- 检查模型只读；只有“同步模型”会新增、更新、删除投影并更新公开地址。同步使用锁，失败保留原投影。
- 同步删除模型时沿用既有外键语义：引用该模型的 `AgentConfig.modelId` 置空，后续启动报未配置模型。

### 2.2 身份与凭证映射

| Fenix 概念 | LiteLLM 概念 | 稳定标识/规则 |
| --- | --- | --- |
| 用户 | Internal User | `fenix-<userId>`，不含 Organization 和 Provider |
| 一次 Agent 调用主体 | Virtual Key | `gatewayProviderId + organizationId + userId + agentConfigId` |
| Key 主体标识 | `metadata` | `fenix_gateway_provider_id`、`fenix_organization_id`、`fenix_user_id`、`fenix_agent_config_id` |
| Key 用量标识 | `token_id` | `/key/generate` 返回的 `token`，也是 daily activity 的 Key 标识 |

同一用户在多个组织中使用网关时，拥有同一个 LiteLLM Internal User 和多把按 Agent/组织隔离的 Virtual Key。

Virtual Key 不设置模型 allowlist 或 `key_alias`。模型选择由 Fenix 的 Gateway Provider Model 投影约束；同步模型或切换 Agent 模型不更新 Key allowlist。主体归属仅由 metadata 和本地 Mapping 保存，避免 LiteLLM 已 block 的同名 Key 阻止后续创建。

Fenix 在 `model_gateway_credential` 中保存：

- 四元主体关联与 `externalCredentialId`（LiteLLM `token_id`）；
- 仅用于运行时注入的 `encryptedCredential`；
- `active`、`blocked`、`error` 状态及无敏感 metadata。

唯一约束为 `(gatewayProviderId, organizationId, userId, agentConfigId)`。主体失效不会自动删除 Mapping；管理员在 Key 管理页确认回收后，Fenix 先 block 远端 Key，再删除本地 Mapping，使后续恢复访问时可创建新 Key。密钥明文和 Master Key 不出现在 API、日志或前端；管理 API 仅返回 metadata 关联出的主体标识和名称。

## 3. 架构与职责

```text
管理端 / Agent 面板
        │
routes → model-gateway services → repositories → PostgreSQL
        │                │
        │                └→ model-gateway-sdk → model-gateway-litellm → LiteLLM
        │
Agent LaunchSpec ← 解密当前主体的 Virtual Key
```

| 模块 | 职责 |
| --- | --- |
| `packages/model-gateway-sdk` | 供应商无关的模型、预算、凭证、用量契约和错误码 |
| `packages/model-gateway-litellm` | LiteLLM REST DTO、请求和字段转换；私有语义不得泄漏到上层 |
| `src/services/model-gateway/` | Provider 同步、预算、凭证、用量聚合和对账编排 |
| `src/repositories/model-gateway-*` | Mapping、Provider/Model 等持久化查询 |
| `launch-spec-builder` | 判断 `kind=gateway`，预算预检后注入解密的专属 Key |

依赖方向保持 `route → service → repository`。路由只做鉴权、参数校验和响应映射，不直接访问数据库或 LiteLLM。

## 4. 部署配置

| 环境变量 | 含义 |
| --- | --- |
| `RCS_MODEL_GATEWAY_TYPE` | 网关类型，当前为 `litellm` |
| `RCS_MODEL_GATEWAY_BASE_URL` | Fenix 后端访问 LiteLLM 的地址 |
| `RCS_MODEL_GATEWAY_PUBLIC_BASE_URL` | 注入公开 Provider、供 Agent 访问的地址；未设时回退 Base URL |
| `RCS_MODEL_GATEWAY_ADMIN_KEY` | LiteLLM 管理凭证，仅服务端使用 |
| `RCS_MODEL_GATEWAY_ADMIN_UI_URL` | 管理员浏览器打开的 LiteLLM 地址 |
| `RCS_MODEL_GATEWAY_CREDENTIAL_ENCRYPTION_KEY` | Virtual Key 本地加密密钥 |
| `RCS_MODEL_GATEWAY_DEFAULT_USER_BUDGET_USD` | 首次激活用户的默认预算金额 |
| `RCS_MODEL_GATEWAY_DEFAULT_BUDGET_DURATION` | 默认周期；空值为一次性 |

Base URL 与浏览器管理地址必须分开配置。检查、用量和“我的用量”读取已有 Provider，不得因页面访问覆盖 Provider 的展示名或公开地址。

## 5. 管理与用户体验

### 5.1 管理页 `/ctrl/admin/model-gateway`

| Tab | 行为 |
| --- | --- |
| 概览 | 显示健康、模型同步状态、近 7 天消耗趋势和管理后台入口 |
| 模型 | 提示模型在 LiteLLM 配置；检查只读返回差异，手动同步更新投影 |
| 配额管理 | 搜索/筛选用户与组织；单个或批量设置、重置预算；预算始终是用户全局预算 |
| 消耗统计 | 按日期、组织、用户、Agent、模型筛选；返回汇总和各维度金额排序的用量条 |
| Key 管理 | 只列出 Fenix 创建且存在本地 Mapping 的 Key，实时展示主体、Key ID、可用性和创建时间；管理员可勾选任意 Key 后确认回收 |

组织选项显示“组织名（ID）”；用户显示“用户名（邮箱）”；Agent 显示“组织名 / Agent 名”。管理端可搜索用户、Agent，服务端按关键字查询并由前端防抖。

### 5.2 用户入口与“我的用量”

Gateway Provider 卡片显示“模型网关”标签，并提供“我的用量”入口：

```text
/agent/model-gateway-usage/:providerId
```

页面使用接口返回的 Provider 名称，展示该用户跨所有组织的预算、已消耗、剩余额度、请求/Token，以及按 Agent、模型的消耗。它固定显示最近 30 个自然日，不提供组织、日期或时间趋势筛选。未激活用户显示“暂未设置预算”和空用量，不会因此创建远端 User 或 Key。

## 6. 模型同步

```text
管理员在 LiteLLM 配置模型
  → 返回 Fenix 检查差异（只读）
  → 手动同步
  → Fenix 更新 Gateway Provider Model 投影
```

检查结果：

| 状态 | 含义 |
| --- | --- |
| `synced` | 外部目录与本地投影无差异 |
| `pending` | 存在新增、更新或删除差异 |
| `unknown` | LiteLLM 不可达、鉴权失败或目录读取失败 |

同步总是重新读取外部目录，不能应用浏览器中旧的差异。只有同步路径允许更新公开地址；管理员若修改过 Provider 展示名，同步配置视为部署投影的一部分。

## 7. Agent 运行时与预算

### 7.1 运行时流程

```text
Agent 启动
  → 识别 Gateway Provider
  → 查询用户预算（已耗尽则拒绝启动）
  → 查找/创建 LiteLLM Internal User
  → 查找/创建四元 Mapping 与 Virtual Key
  → 解密 Key，注入 LaunchSpec
  → Agent 调用 LiteLLM
```

首次创建同一主体的 Key 由 Mapping 唯一约束裁决；竞态创建出的未采用远端 Key 尽力禁用。复用已有 Key 时不调用 `/key/update` 更新 allowlist。

预算范围是 `Gateway Provider + Fenix User`，覆盖该用户在全部 Organization、Agent 和模型上的网关调用。普通 Provider 不参与网关预算或统计。

### 7.2 预算策略

- 默认预算仅在首次创建 LiteLLM Internal User 时写入；之后修改默认值不回写已有用户。
- 管理员设置预算立即更新 LiteLLM，不清零当前消耗；新上限低于已消耗金额时立即视为耗尽。
- 支持一次性、`1d`、`7d`、`30d`。Fenix 的一次性为 `duration=null`；LiteLLM 侧写为 `2000d`，读取时转回 `null` 且不显示重置时间。
- 单次和批量设置最多 100 位用户，返回逐用户成功/失败结果。
- 重置只清零 LiteLLM spend，不修改金额或周期。LiteLLM bulk update 对未激活用户会创建远端 User；这是一期接受的行为。

## 8. 用量统计

### 8.1 日期和数据源

Fenix 用量统计使用首尾包含的 UTC `YYYY-MM-DD` 自然日范围。前端快捷范围按“含今天的最近 N 个自然日”生成；接口拒绝 ISO 时间戳。自定义范围最多 90 个自然日。

LiteLLM daily activity 是用量事实来源，Fenix 不复制消费流水。用量可能存在上游聚合延迟；查询失败必须显示错误，不能回退为 0。

### 8.2 过滤与归因

所有查询必须显式携带 `gatewayProviderId`，只统计能关联到该 Provider Mapping 的 Key。无 Mapping 时直接返回空聚合，不能汇入同一 LiteLLM 实例的其他 Key 消耗。

| 维度 | 过滤/归因方式 |
| --- | --- |
| 组织 | Mapping 的 `organizationId` |
| 用户 | Fenix `userId` 对应 `fenix-<userId>` |
| Agent | Mapping 的 `agentConfigId` |
| 模型 | LiteLLM 返回的模型 ID |
| Key | LiteLLM `token_id` = Mapping `externalCredentialId` |

有主体筛选时，服务端按候选 Key 查询，最多并发 3 个请求；无主体筛选时只进行一次全量查询。金额、Token、请求数从 LiteLLM 聚合结果累加。按组织、用户、Agent、模型的结果均由后端补齐可读名称并按金额降序返回。

## 9. API 契约

系统管理 API 使用 `RCS_SYSTEM_API_KEYS`：

```text
GET  /api/system/model-gateway/config
GET  /api/system/model-gateway/models/status
POST /api/system/model-gateway/models/actions/sync
GET  /api/system/model-gateway/keys
POST /api/system/model-gateway/keys/actions/remove

GET  /api/system/model-gateway/budgets
PUT  /api/system/model-gateway/budgets/:userId
POST /api/system/model-gateway/budgets/actions/bulk-update
POST /api/system/model-gateway/budgets/actions/bulk-reset

GET  /api/system/model-gateway/subjects/users
GET  /api/system/model-gateway/subjects/agents
GET  /api/system/model-gateway/usage
```

个人用量 API 使用 Session 鉴权：

```text
GET /web/model-gateway/:providerId/usage
```

该路由校验当前用户对指定 Gateway Provider 的读取权限，由路径 Provider 决定数据范围，并返回 `gatewayProvider`、当前用户预算和用量。请求参数为 `startAt`、`endAt` 的 `YYYY-MM-DD` 日期范围；个人页面不暴露组织筛选。

## 10. 生命周期、失败与安全

### 10.1 Key 管理与人工回收

系统不运行定时 Key 对账任务。Key 管理页只读取 Fenix 创建且仍有本地 Mapping 的 Key，并在每次查询时依次检查：

1. 本地 Mapping 为 `active` 且存在加密密文；
2. 用户与组织存在，且用户仍属于该组织；
3. Agent 存在且属于该组织；
4. 用户仍拥有该 Agent 的读取权限。

任一条件不满足时，页面显示具体不可用原因。该可用性是 Fenix 侧的主体与本地凭证状态，不主动请求 LiteLLM 验证远端 Key 是否仍有效。

管理员可以勾选任意 Key 回收，包括页面当前仍显示“可用”的 Key。回收按每个 Key 独立执行：

- LiteLLM `/key/block` 成功或返回 404：删除本地 Mapping；
- 其他远端错误：保留本地 Mapping，并在结果中标记删除失败。

回收不删除 LiteLLM User；LiteLLM block 也不会删除远端 Key。删除本地 Mapping 后，后续 Agent 启动会新建 Key 并写入新的 Mapping。

### 10.2 安全与隔离

1. Master Key 仅存在服务端环境和 LiteLLM adapter。
2. Virtual Key 仅以加密形式保存；解密值只在 LaunchSpec 构建的最小作用域内使用。
3. 管理 API 使用系统密钥；个人用量以 Session User 和路径 Provider 做授权。
4. 组织、用户、Agent 身份从服务端认证上下文和 Mapping 获取，不能由客户端覆盖。
5. 外部错误转换为稳定、脱敏的领域错误；不返回密钥、内部 URL、外部响应体或资源标识。

## 11. 已接受限制与后续演进

- LiteLLM daily activity 仅按 UTC 日桶汇总，不能提供小时级精确统计。
- LiteLLM bulk reset 的 upsert 行为会激活未使用用户；一期不额外过滤。
- 实例连接接口的并发启动问题属于既有通用 Environment/Instance 路径，不属于模型网关；该问题在 E2E 中单独跳过。
- 当前只实现一个全局 Gateway Provider。若支持组织自有网关，需重新定义 Provider、用户身份与预算隔离策略，不能复用一期的全局预算语义。
