# Feature: 20260601_F001 - resource-permission

## 需求背景

当前系统已经完成基于 `organizationId` 的 team 维度隔离：同 team 内资源天然共享，跨 team 默认不可见。这一模型适合日常协作，但缺少更轻量的跨 team 共享方式。对于通用的 Provider、Skill、MCP Server，资源 owner 希望允许其他 team 只读引用，而不是让对方复制一份副本再自行维护。

本次调整明确：`resource-permission` 只作为内部数据表和内部 service 能力存在，不暴露任何独立 Web API。资源的增删改查仍全部走原资源接口，并在原资源 service 内完成权限判断、外部资源补充和来源字段补齐。

## 目标

- 为 `provider`、`skill`、`mcp_server` 三类资源增加跨 team 的只读授权能力
- 保持同 team 内默认可见规则不变，不把内部读权限迁移到授权表
- 权限能力只作为内部 service 被原资源接口使用
- 资源 list / get / create / update / delete 全部沿用原资源 API，并在原 service 内做权限判断
- 查询接口返回资源来源字段，前端根据来源判断是否允许编辑、删除、启停和修改可见性
- 跨 team 使用资源时走实时引用，不创建当前 team 副本
- `model` 不单独授权，而是继承其所属 `provider` 的可见性
- 外部资源仅可读，不能编辑、删除、启停或修改授权

## 方案设计

### 1. 核心决策

第一版采用“内部资源天然可见 + 跨 team 显式授权”的双层模型：

- 内部资源仍按现有 `organizationId` 过滤逻辑读取
- 新增授权表只表达“额外开放给谁读”
- 当前 UI 的“公开”只是原资源 update 请求中的权限字段变化，后端内部映射为 `grant(all, read)` / `revoke(all, read)`
- 运行时读取外部资源时始终读取源资源当前版本，不做导入复制
- 权限能力必须融入原资源的 list / get / create / update / delete / 运行时解析链路，调用方仍只访问原资源 API

不采用独立权限 API；调用方不需要知道授权表存在，也不需要自行拼接权限表数据。

### 2. 数据模型

新增表：`resource_permission`

建议字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `uuid` | 主键 |
| `organizationId` | `text` | 资源所属 team |
| `resourceType` | `varchar` | `provider` / `skill` / `mcp_server` |
| `resourceId` | `text` | 资源主键 ID |
| `principalType` | `varchar` | `all` / `organization` |
| `principalId` | `text \| null` | `all` 时为空，`organization` 时为目标 team ID |
| `action` | `varchar` | 第一版固定为 `read` |
| `createdBy` | `text` | 授权创建人 |
| `createdAt` | `timestamp with timezone` | 创建时间 |
| `updatedAt` | `timestamp with timezone` | 更新时间 |

唯一约束：

- `(resourceType, resourceId, principalType, principalId, action)`

索引：

- `(organizationId, resourceType)`，用于查询本 team 资源的授权状态
- `(principalType, principalId, action)`，用于查询当前调用方可访问的外部资源引用
- `(resourceType, resourceId)`，用于按资源回查 grants

Drizzle 层新增三个受限枚举即可，不需要引入独立策略系统：

- `resourcePermissionTypeEnum`
- `resourcePermissionPrincipalEnum`
- `resourcePermissionActionEnum`

### 3. 服务边界与模块拆分

后端新增或保留以下内部模块：

- `src/db/schema.ts`
  - 定义 `resourcePermission` 表与相关枚举
- `src/repositories/resource-permission.ts`
  - 负责授权记录的增删查
- `src/services/resource-permission.ts`
  - 内部权限能力服务，不对外暴露 route
  - 负责可读资源引用查询、授权状态读取、公开开关更新、来源元信息补齐和写操作归属校验

原资源 service 负责接入权限能力：

- `src/services/config/provider.ts`
- `src/services/config/model.ts`
- `src/services/config/skill.ts`
- `src/services/config/mcp-server.ts`
- `src/services/config/aggregate.ts`
- `src/services/skill.ts`
- `src/services/launch-spec-builder.ts`

Repository 建议职责：

- `listByResource(resourceType, resourceId)`
- `createGrant(record)`
- `deleteGrant(resourceType, resourceId, principalType, principalId, action)`
- `listOwnedByOrganization(orgId, resourceType?)`
- `listAccessibleForPrincipal(orgId, resourceType)`
- `canReadExternalResource(resourceType, resourceId, principal)`

Permission service 建议职责：

- `listReadableResourceRefs(ctx, resourceType)`：返回当前 team 可读的外部资源引用，不直接组装业务资源对象
- `getResourceAccess(ctx, resourceType, ownerOrgId, resourceId)`：返回单个资源对当前调用方的来源和可操作性
- `decorateResourceAccess(ctx, resourceType, rows)`：为原资源 service 已取出的资源补充来源字段
- `setPublicRead(ctx, resourceType, resourceId, enabled)`：仅供原资源 update 接口内部调用
- `canReadResource(ctx, resourceType, resourceId, ownerOrgId)`
- `assertInternalWritable(ctx, resourceType, resourceId, ownerOrgId)`：所有写操作统一调用，外部资源直接拒绝

关键边界：

- `resource-permission` service 不返回完整 Provider / Skill / MCP / Model 业务对象
- 外部资源的业务字段由对应资源 service 按原有数据结构读取和返回
- 前端、route、运行时组装逻辑只访问原资源接口
- 资源列表、详情、公开状态和可编辑性，全部由原资源 service 的统一读取入口决定
- 列表不按名称合并；同名资源通过 `resourceAccess.resourceKey` 和来源组织区分

### 4. 原资源 API 规则

资源接口维持原有入口，不新增权限入口：

- Provider：继续走 providers 配置接口 list / get / set / delete
- Skill：继续走 skills 配置接口和 skill 运行时入口
- MCP Server：继续走 mcp 配置接口和 LaunchSpec 组装入口
- Model：继续走 models 配置接口，并继承 Provider 可见性

查询接口必须返回来源字段：

```ts
type ResourceAccess = {
  ownership: "internal" | "external";
  sourceOrganizationId: string;
  sourceOrganizationName?: string;
  resourceUid: string;
  resourceKey: string;
  manageable: boolean;
  writable: boolean;
  publicReadable?: boolean;
};
```

字段语义：

- `ownership = "internal"`：资源属于当前 team
- `ownership = "external"`：资源来自其他 team 的授权
- `sourceOrganizationId/sourceOrganizationName`：资源来源组织；内部资源也返回当前组织 ID，便于前端统一展示
- `resourceUid`：资源自身 uid，即原资源主键 ID
- `resourceKey`：稳定唯一 key，格式建议为 `${sourceOrganizationId}/${resourceUid}`
- `manageable`：当前用户是否能修改可见性，第一版仅本 team `owner/admin` 为 true
- `writable`：当前用户是否能编辑、删除或启停资源；外部资源恒为 false
- `publicReadable`：内部资源是否存在 `all:read` 授权，用于前端展示公开状态和开关初始值

写接口规则：

- create：始终写入当前 `ctx.organizationId`
- update：仅允许内部资源；若请求携带公开状态字段，由原资源 service 内部调用 `setPublicRead`
- delete：仅允许内部资源
- enable / disable / test / import 等会改变资源状态或依赖内部资源归属的动作：仅允许内部资源
- get / list：允许返回内部资源和有 read 授权的外部资源

### 5. 权限规则

资源读权限统一按以下顺序判断：

1. 若资源 `organizationId === ctx.organizationId`，按本 team 资源直接放行
2. 若不属于本 team，检查是否存在匹配授权
3. 第一版只匹配两种授权：
   - `all:read`
   - `organization:<ctx.organizationId>:read`
4. 命中则允许读取，否则拒绝

资源可见性管理权限单独判断：

- `owner` / `admin`：可通过原资源 update 接口修改内部资源可见性
- `member`：不可修改资源可见性
- 外部 team：即使可读，也不可修改资源、删除资源、启停资源或修改授权

这里继续复用现有 `AuthContext` 和 organization 角色语义，不额外引入新的 RBAC 子系统。

### 6. 资源读取链路改造

权限不能作为旁路 API 让调用方自行关联，必须下沉到原资源 service 层。所有资源读取入口统一采用：

1. 按原逻辑读取内部资源
2. 调用 `resource-permission` service 获取当前 team 可读的外部资源引用
3. 由原资源 repository / service 读取这些外部资源的业务字段
4. 在原资源 service 内补齐来源字段和稳定身份 key，不按名称做去重合并
5. 按原 API 返回结构返回给调用方

这样前端 `/web` 接口、Agent LaunchSpec、Meta Agent、Workflow 等调用方都不需要知道授权表存在，也不需要实现二次查询和关联逻辑。

#### 6.1 Skill

改造 `skill` 的 list / get / runtime 读取入口：

- 内部资源读取仍按 `organizationId` 查询
- 外部读取由 `skill` service 调用 `resource-permission` service 后补充
- 列表返回内部资源和外部资源全集，不按名称合并
- 查询结果带 `resourceAccess`
- 外部 skill 标记为只读，并附带来源字段

运行时读取 skill 内容时，不复制到本 team 目录，直接读取源 skill 当前内容。这样源内容更新后，下一次运行自动生效。

实现要求：

- `web` 端 skill 列表、详情和运行时读取必须复用同一套可读性判断
- 不能在前端先列内部 skill，再单独调用权限 API 追加外部 skill
- 公开开关的读取和修改都通过原 skill 接口完成

#### 6.2 MCP Server

改造 `mcp_server` 的 list / get / Agent LaunchSpec 组装入口：

- 内部 MCP 保持原有逻辑
- 外部 MCP 由 `mcp-server` service 调用 `resource-permission` service 后补充到候选列表
- 查询结果带 `resourceAccess`
- LaunchSpec 解析时允许直接引用外部 MCP 源配置

第一版明确不做脱敏，因此返回完整配置。该行为只适用于受信任的内部协作网络。

实现要求：

- 配置页、Agent 配置引用、LaunchSpec 组装必须看到一致的 MCP 可见集合
- 不允许只改配置页列表，而遗漏 `getAgentFullConfig()` 或 LaunchSpec 构建链路
- 公开开关的读取和修改都通过原 MCP 接口完成

#### 6.3 Provider / Model

`provider` 是授权最小单元，`model` 不独立授权。

改造点：

- Provider 列表/详情读取支持外部授权资源
- Provider 查询结果带 `resourceAccess`
- Model 列表必须通过所属 provider 判断可见性
- Model 查询结果补充 provider 的来源字段，前端据此判断 model 是否可编辑
- 任何按 `provider/model` 解析模型引用的入口，都必须统一走 provider 可读性判断
- Agent LaunchSpec 组装、Meta Agent 创建、Workflow agent config resolver 等运行时入口必须使用同一个 provider/model 可见性入口

实现约束：

- 不允许只在前端“显示外部 provider”，却遗漏运行时解析链路
- 不允许 model 查询直接按内部 provider 过滤，否则外部 provider 下的 models 会丢失
- 公开开关的读取和修改都通过原 provider 接口完成

建议做法：

- 抽一个统一的 provider 可见性解析入口
- model 查询先拿 provider 集合，再展开其下 models
- 对外返回 model 时补充其 provider 的来源信息，避免 UI 把外部 provider 下的 model 误判为内部可编辑

### 7. 列表身份与同名展示

所有支持外部资源的读取入口统一采用同一身份规则：

- 资源列表不做同名合并，也不做“内部覆盖外部”
- 稳定唯一身份使用 `(sourceOrganizationId, resourceUid)`
- 前端列表 key 使用 `resourceAccess.resourceKey`
- 资源引用、选择器值、运行时解析不能只依赖 `name`

展示规则：

- 默认显示为 `组织 / 资源名`
- 若资源名为空或不可靠，显示为 `组织 / 资源 uid`
- 同名资源可以同时出现，由来源组织区分
- 内部资源和外部资源即使同名也都是不同资源，不能静默隐藏任一方

写操作保护：

- 对 `external` 资源的更新、删除、启停、授权管理请求全部拒绝
- create 操作始终写入当前 `ctx.organizationId`
- update / delete / enable / disable 等写操作必须先通过 `assertInternalWritable` 校验资源归属，不能只依赖前端隐藏按钮

### 8. 前端交互映射

第一版前端只做“公开”开关，不暴露完整授权编辑器。

映射方式：

- 查询开关状态：使用原资源查询接口返回的 `resourceAccess.publicReadable`
- 打开公开：调用原资源 update / set 接口，传入公开状态字段
- 关闭公开：调用原资源 update / set 接口，传入公开状态字段
- 后端在原资源 service 内把公开状态变化映射为 `all:read` 授权创建或删除

界面建议：

- 内部资源显示 `Internal`
- 外部资源显示 `External`
- `resourceAccess.publicReadable === true` 的内部资源显示 `Public`

外部资源页面行为：

- 可查看
- 可被 Agent 配置引用
- 不显示编辑、删除、启停、授权操作

前端约束：

- 资源选择器、配置页和运行时入口都继续调用原资源 API
- UI 只消费原资源 API 返回的 `resourceAccess` 字段判断来源和可操作性
- 前端隐藏按钮只是体验优化，后端仍必须在原资源写接口中拒绝外部资源写操作

### 9. 渐进实现顺序

建议按以下顺序落地，减少中间态不一致：

1. 新增 schema、迁移、repository、内部 `resource-permission` service
2. 打通原资源接口与内部权限 service 的交互边界
3. 打通 `skill` 原 service 的 list / get / update / delete / runtime 外部读取与写入校验
4. 打通 `mcp_server` 原 service 的 list / get / update / delete / enable / disable / LaunchSpec 外部读取与写入校验
5. 打通 `provider/model` 原 service 的 list / get / update / delete / runtime 解析链路
6. 前端在原资源页面消费 `resourceAccess` 字段，并通过原资源 update 接口切换公开状态

原因：

- `skill` 和 `mcp_server` 的可见性模型更直接，适合作为第一批验证对象
- `provider/model` 有继承关系和运行时解析链路，放在最后更稳妥
- 每一步完成后，都应确保原资源 API 已经能直接返回可读外部资源，而不是依赖调用方二次查询

## 实现要点

- 迁移只新增 `resource_permission`，不修改 `provider` / `skill` / `mcp_server` 表结构
- 所有资源写操作必须继续要求资源归属 `organizationId === ctx.organizationId`
- 可见性读取不要散落在各个页面、route 或运行时调用方中，必须沉到对应资源 service 层统一判定
- 外部资源必须从原资源 API 返回
- `model` 的外部可见性必须继承 `provider`，不能复制一套独立授权规则
- 查询接口返回外部资源时要补齐 `resourceAccess`，避免前端和运行时误把外部资源当内部资源
- 列表身份以 `sourceOrganizationId + resourceUid` 为准，不以资源名去重
- 原资源 service 返回列表时要一次性补齐来源和只读字段，调用方不需要再查权限表
- 第一版不做脱敏，需要在文档和 UI 文案中明确其适用范围是受信任内部协作

## 验收标准

- [ ] 新增 `resource_permission` 表，支持 `provider`、`skill`、`mcp_server`
- [ ] 内部资源默认仍按原逻辑可见，不依赖 `resource_permission`
- [ ] 资源查询接口通过原 API 返回内部和外部可读资源
- [ ] 查询结果包含 `resourceAccess.ownership`、来源组织、`resourceUid`、`resourceKey`、`writable`、`manageable`、`publicReadable` 等字段
- [ ] 前端“公开”开关通过原资源 update / set 接口修改，后端内部映射为 `all:read` 授权的创建与删除
- [ ] `member` 不能修改资源可见性
- [ ] 外部 team 可浏览被授权的 `provider`、`skill`、`mcp_server`
- [ ] 外部资源通过原资源 API 返回，不需要前端额外查询权限数据后自行关联
- [ ] `model` 通过 `provider` 继承可见性，不单独授权
- [ ] 跨 team 使用资源时走实时引用，不产生当前 team 副本
- [ ] 内部资源与外部同名资源同时返回，不做合并；前端显示为“组织 / 资源名或 uid”
- [ ] 外部资源对调用方只读，不可编辑、删除、启停、管理权限
- [ ] Agent LaunchSpec、Meta Agent、Workflow 等运行时入口与前端列表看到一致的可读资源集合
- [ ] 第一版不做脱敏，文档中明确标注该取舍与适用范围
