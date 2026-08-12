# 通用资源版本控制（`@fenix/versioning`）

> 涉及模块：`packages/versioning/`、`src/db/schema.ts`、所有需要版本化的具体资源
>
> **状态：目标架构（未实现）**。本文定义整数版本、`Version.MAX` 工作版本、单资源锁定和 DAG 依赖。版本只固定当前资源的数据，不固定其依赖内容。

## 1. 核心模型

```ts
export const VERSION_MAX = 2_147_483_647;
```

| version | 含义 | 可修改性 |
|---------|------|----------|
| `VERSION_MAX` | latest 工作版本 | 可以通过受控入口更新 |
| `1..VERSION_MAX - 1` | 锁定版本 | 当前资源的数据永远不可修改 |

每类资源使用自己的具体表：

```text
resource_id                         同一资源版本链的稳定身份
version integer                     MAX 或锁定整数版本
(scope, resource_id, version)       一行资源版本的唯一键
```

规则：

- 每条正常版本链有一行 MAX；
- 首次锁定产生 `1`，后续按 `2, 3...` 递增；
- 下一版本计算必须排除 MAX；
- MAX 和整数版本都可以引用目标 MAX 或目标整数版本；
- 锁定时所有引用值原样复制，不解析、不改写、不递归锁定下游；
- 锁定只保证当前资源行及其聚合子表不可修改，不保证下游依赖内容固定；
- 不使用语义版本、额外 `version_id` 或独立 latest 指针。

## 2. 具体资源表

```text
agent_config
  organization_id       text        not null
  resource_id           uuid        not null
  version               integer     not null
  lock_key              uuid        null
  created_at            timestamptz not null
  created_by_user_id    text        null
  created_by_name       text        not null
  updated_at            timestamptz not null
  updated_by_user_id    text        null
  updated_by_name       text        not null
  ...AgentConfig 业务字段
```

基本约束：

```text
primary key (organization_id, resource_id, version)
unique (organization_id, resource_id, lock_key)
check (version >= 1 and version <= 2147483647)
check (
  (version = 2147483647 and lock_key is null)
  or
  (version < 2147483647 and lock_key is not null)
)
```

复合主键保证同一版本链最多有一行 MAX；“正常版本链必须存在 MAX”由创建事务、repository 不提供 MAX 删除入口和契约测试保证。若存在整数历史但 MAX 缺失，读取和锁定应报告数据损坏。

只有 `resource_id + version` 是通用版本身份。具体资源自己声明作用域、业务字段、审计字段、子表、索引和外键。版本包不建立通用内容表。

`lock_key` 是调用方为一次锁定操作生成的 UUID，只用于网络重试幂等，不参与版本身份或资源引用：

- MAX 行的 `lock_key` 必须为空；
- 每个整数版本必须记录创建它的 `lock_key`；
- 同一资源链重复提交相同 key 时返回第一次创建的整数版本；
- key 的唯一范围是具体作用域和 `resource_id`，不同资源可以复用同一个 UUID；
- 锁定命令只有“复制当前 MAX 聚合”一种语义，因此不额外保存请求摘要。

### 2.1 审计字段

MAX 可以更新：

- `created_*` 记录工作版本首次创建；
- `updated_*` 记录工作版本最近保存。

锁定版本是新行：`created_*` 记录本次锁定人和锁定时间；`updated_*` 初始与 `created_*` 相同，之后永远不变。锁定时只复制 MAX 的业务字段和业务子表，版本、`lock_key` 及全部审计字段由本次锁定重新生成，不能从 MAX 机械复制。

名称保存当时的展示快照，避免用户改名或删除改变历史含义。用户 ID 是否建立外键由账号删除策略决定，不允许删除用户时修改锁定版本。

## 3. 引用语义

所有版本化引用保存：

```ts
export interface ResourceReference {
  readonly resourceId: string;
  readonly version: number; // VERSION_MAX 或锁定整数
}
```

MAX 与整数来源都允许以下两种引用：

```text
target(resource_id, VERSION_MAX)   动态读取目标 latest
target(resource_id, 7)             固定读取目标版本 7
```

锁定时引用原样复制：

```text
锁定前：AgentConfig(MAX) → ExpertConfig(MAX), Connector(3)
锁定后：AgentConfig(4)   → ExpertConfig(MAX), Connector(3)
```

以后 ExpertConfig(MAX) 被修改，读取 AgentConfig(4) 时会看到新的 ExpertConfig 内容。这是明确接受的语义：AgentConfig(4) 只固定 AgentConfig 自身数据，不是完整依赖快照。

版本化关联表必须外键到来源和目标的 `(scope, resource_id, version)`，并声明领域唯一约束。来源和目标作用域分别建模，不能使用 `resource_kind + resource_id` 或含混 resourceKey 代替真实外键。

## 4. 依赖必须是 DAG

依赖关系由资源类型声明为单向分层结构。例如：

```text
AgentConfig
  → ExpertConfig
    → Skill
    → MCP
    → Model
      → Provider
```

多个上游可以共享同一下游，因此结构是 DAG，而不是严格的树：

```text
ExpertConfig A ─┐
                ├→ Skill X
ExpertConfig B ─┘
```

不允许反向依赖、自引用或同层任意引用。具体资源定义必须声明允许的目标资源类型；schema 和 service 只提供这些方向的类型化关联表，不提供任意 `resourceKind` 关系入口。这样循环依赖在模型边界上无法表达。

权威 allowed-edge 清单：

| 来源 | 允许目标 |
|------|----------|
| AgentConfig | ExpertConfig、ConnectorDefinition |
| ExpertConfig | Skill、McpServer、Model |
| Model | Provider |
| Skill、McpServer、Provider、ConnectorDefinition | 无 |

新增版本化关联表必须先更新此清单并接受 schema/code review；调用方不能自行提交来源或目标 resource kind。

若未来新增关系可能破坏既有层级，必须先更新架构中的依赖方向并证明仍是 DAG，不能只增加一个运行时环检测绕过模型审查。

运行时仍应使用访问集合防御历史脏数据，但它不是主要无环保证。

## 5. 编辑 latest

用户编辑资源时更新 MAX 主行及其 MAX 聚合子表：

```text
saveLatest(resourceId, input)
  1. 具体领域完成鉴权和业务校验
  2. SELECT MAX 父行 FOR UPDATE，作为该资源链唯一聚合锁点
  3. 校验目标引用存在、作用域和允许的依赖方向
  4. 更新 MAX 主行、子表、关联和 updated 审计
  5. 提交
```

编辑 latest 不产生整数版本。具体资源应使用可靠的编辑并发标识防止两个客户端相互覆盖；该标识属于编辑协议，不属于版本身份。

所有 MAX 子表和关联的 INSERT/UPDATE/DELETE 都必须先取得同一 MAX 父行锁。repository 不暴露绕过父行锁的子表写入口；父行锁既防止编辑之间互相覆盖聚合，也防止编辑与锁定复制产生混合时点。

## 6. 锁定当前资源

锁定只复制当前资源的 MAX 聚合：

```text
lockVersion(resourceId, lockKey)
  1. 校验锁定权限
  2. SELECT MAX 父行 FOR UPDATE，与 MAX 编辑使用同一聚合锁点
  3. 查询该资源链是否已有相同 lockKey；有则返回已有整数版本
  4. 在父行锁内读取完整 MAX 主行、子表和关联
  5. 查询最高锁定版本（排除 MAX）
  6. 计算 nextVersion；无可用整数时返回 VERSION_EXHAUSTED
  7. 复制 MAX 业务字段和版本化业务子表
  8. 原样复制全部引用版本值，包括 MAX
  9. 使用本次 actor、数据库时间和 lockKey 生成版本及审计字段
 10. 插入新的不可变整数版本并提交
```

锁定不会：

- 修改或删除 MAX；
- 创建任何下游资源版本；
- 把 MAX 引用转换成整数引用；
- 遍历或锁定整张依赖图。

主行、子表和关联必须在同一个 PostgreSQL 事务内复制。并发锁定同一资源链必须串行化，避免分配相同整数版本。

相同 `lockKey` 的首次事务已提交但响应丢失时，重试必须返回原整数版本；不得读取当前 MAX 再创建新版本。唯一约束冲突应回读已有结果并转换为成功响应，不能暴露数据库异常。

## 7. 运行时一致读取

动态 MAX 引用允许不同启动读取不同内容，但单次启动不能拼接不同数据库时点：

1. 启动开始先读取并固定 Environment 当前保存的 AgentConfig 版本选择；
2. 在同一个 PostgreSQL `REPEATABLE READ READ ONLY` 事务中读取 AgentConfig 及整个配置 DAG；
3. 严格按各关联保存的 MAX/整数值解析；
4. 完成数据库 DTO 捕获后提交只读事务；
5. Secret 解析、MCP 探测和 S3 下载等外部操作在数据库事务外执行。

该规则只保证一次启动读取一个一致的 PostgreSQL 快照，不保证不同启动得到相同结果。首期所有参与装配的配置元数据必须位于同一个 PostgreSQL 数据库。

## 8. 查询

| 查询 | 条件与顺序 |
|------|------------|
| latest | `version = VERSION_MAX` |
| 锁定版本历史 | `version < VERSION_MAX ORDER BY version DESC` |
| 最高锁定版本 | `version < VERSION_MAX ORDER BY version DESC LIMIT 1` |
| 最近操作 | `updated_at DESC`，再以作用域、`resource_id`、`version` 稳定排序 |

不能直接用 `ORDER BY version DESC` 查询历史，否则 MAX 总在第一位。时间只用于操作展示，不能用来分配版本号。

资源审计信息：

- 创建时间和创建人：MAX 的 `created_*`；
- 最近更新时间和更新人：MAX 的 `updated_*`；
- 锁定版本的创建时间和创建人：该整数版本的 `created_*`。

## 9. 非 JSON 资源和子表

具体资源可以使用正常 PostgreSQL 字段、数组、enum 和版本化子表。子表携带来源 `(scope, resource_id, version)`。

编辑 MAX 时受控更新 MAX 子表；锁定时只复制当前资源的 MAX 子表。锁定版本的主行、子表和关联提交后均不可修改或补写。

只有真正无固定结构的业务字段才使用 JSONB。外部文件资源的存储、复制和生命周期由该资源单独设计，不进入通用版本包。

## 10. 不可变性与删除

- MAX 只能通过具体资源的受控保存入口修改；
- 锁定版本不提供 UPDATE 或补写子表/关联入口；
- 被引用版本使用 `ON DELETE RESTRICT`；
- 常规业务路径不删除 MAX 或锁定版本；
- 归档、安全撤销、法规擦除和链级业务唯一性由具体领域定义。

普通 CHECK/FK 不能独立阻止持有写权限的代码修改历史行。当前通过 repository 边界、事务入口和数据库权限保证；没有真实需求时不预设 sealed 字段、trigger 或通用保留系统。

## 11. 包边界

`@fenix/versioning` 提供：

- `VERSION_MAX`、整数版本范围和 `VERSION_EXHAUSTED`；
- `lock_key` 列、唯一约束和幂等结果查询工具；
- `resource_id`、integer `version` 和基础约束构造器；
- MAX、最高锁定版本和下一版本查询工具；
- 单资源版本链的串行化工具；
- 复制当前资源聚合时使用的基础类型和错误。

具体资源负责：

- 具体表、业务字段、子表和类型化 DAG 关联；
- 鉴权、业务校验和 latest 编辑并发；
- 读取 MAX 聚合并插入锁定版本；
- API、外部存储、迁移和运行时引用解析。

版本包不遍历跨资源依赖图，不创建下游版本，不建立通用内容表或 `resourceKind` 多态引用。

## 12. 验证

版本包覆盖：

- MAX 与锁定版本范围；
- 下一版本排除 MAX 及版本耗尽；
- latest、历史和时间查询；
- 同一资源并发锁定；
- 锁定响应丢失后使用相同 lockKey 重试只返回原版本；
- MAX 编辑、子表增删改和锁定复制共用父行锁，不产生混合聚合；
- 锁定时 MAX/整数引用均原样复制；
- 锁定后 MAX 保持不变。

每个具体资源覆盖：

- MAX 聚合编辑和并发冲突；
- 主行、子表、关联的锁定复制与事务原子性；
- 锁定版本不可修改；
- 只允许架构声明的 DAG 依赖方向；
- 引用外键、作用域和删除限制；
- 单次 LaunchSpec 在一个 REPEATABLE READ 快照内解析动态 MAX 图。

数据库变更遵循项目 Drizzle 迁移流程。
