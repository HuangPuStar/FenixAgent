# Agent 资源系统重设计

> 来源：需求访谈（2026-08-11） | 状态：目标设计（未实现）
>
> 版本规则以 [通用资源版本控制](../arch/07-versioning.md) 为准，AgentConfig 结构以 [Agent Config](../arch/04-agent-config.md) 为准。

## 目标结构

```text
AgentConfig(MAX / 整数)
├── RuntimeConfig
├── ExpertConfigBinding → ExpertConfig(MAX / 整数)
│                         ├── Skill(MAX / 整数)
│                         ├── MCP(MAX / 整数)
│                         └── Model(MAX / 整数) → Provider(MAX / 整数)
└── ConnectorBinding → ConnectorDefinition(MAX / 整数)
```

- 每个资源有一个可编辑 MAX 和若干不可变整数版本；
- RuntimeConfig 与 Binding 是 AgentConfig 版本聚合子表；
- ExpertConfig、ConnectorDefinition、Skill、MCP、Model、Provider 是独立资源；
- 所有引用保存真实作用域、`resource_id + integer version`。

## DAG 依赖

资源类型只允许按上图从上层到下层引用。多个上游可以共享同一下游，因此是 DAG，不是严格的树。

禁止：

- 反向依赖；
- 自引用；
- 未在架构中声明的同层或跨层引用；
- 通用 `resourceKind` 多态关系入口。

循环依赖通过模型边界消除，而不是依赖锁定时遍历整张图发现。

## 编辑与锁定

编辑只更新当前资源的 MAX 聚合。

锁定只复制当前资源：

```text
锁定前：AgentConfig(MAX) → ExpertConfig(MAX), ConnectorDefinition(3)
锁定后：AgentConfig(4)   → ExpertConfig(MAX), ConnectorDefinition(3)
```

- MAX/整数引用值原样复制；
- 不递归锁定下游；
- 不改写引用；
- 不遍历或锁定依赖图；
- 当前资源的主行、子表和关联在同一 PostgreSQL 事务中复制；
- MAX 保持可编辑，整数版本的当前资源数据不可修改。

MAX 编辑与锁定必须先锁定同一个 MAX 父行；所有子表和 Binding 写入都经该父行锁串行化。锁定请求携带 `lockKey`，相同资源链重复使用同一 key 时返回第一次创建的整数版本。

整数版本不是完整依赖快照。指向 MAX 的依赖可以随时间变化，同一个 AgentConfig 整数版本在不同时间运行可能得到不同的下游内容。

## AgentConfig 聚合

- RuntimeConfig：AgentNode、Env、Permission；
- ExpertConfigBinding：目标版本、`order / alias / enabled / isMain`，必须且只能有一个已启用的主 ExpertConfig；
- ConnectorBinding：引用 ConnectorDefinition，并保存 Agent 专属配置和启用状态。

编辑或锁定前校验主专家、引用存在和作用域、Connector 配置及 RuntimeConfig。

## 运行时

Environment 保存 AgentConfig 的资源 ID 和版本。运行时先固定该选择，再在同一个 PostgreSQL `REPEATABLE READ READ ONLY` 事务中逐层按照每条引用保存的版本值解析：

- MAX 读取目标当前工作版本；
- 整数读取目标锁定版本；
- 来源是否为整数不改变目标 MAX 的动态语义。

运行时检查缺失引用、权限、安全撤销和历史脏数据中的循环，但不把动态 MAX 转换成整数版本。外部 Secret、MCP 和 S3 操作在数据库快照读取完成后执行。

## 数据边界

- 每类资源使用具体 PostgreSQL 表和业务字段；
- 不建立通用内容表或额外 version UUID；
- 不强制 JSON 快照；
- MAX 子表可以受控更新，整数版本聚合不可修改；
- 审计字段记录 MAX 的创建/更新和整数版本的锁定；
- Skill 将迁移到 S3，存储与版本生命周期另立设计；
- 鉴权、API、外部存储和迁移由具体领域负责。

## 验证

- MAX 创建、编辑和并发冲突；
- 整数版本单调递增并排除 MAX；
- 锁定只复制当前资源聚合；
- MAX 编辑和锁定共用父行锁，子表并发变化不会形成混合聚合；
- 相同 lockKey 重试返回原整数版本；
- MAX 和整数引用均原样复制；
- 锁定不创建任何下游版本；
- 整数版本自身数据不可修改；
- schema/service 只能建立声明过的 DAG 方向；
- Environment 与 LaunchSpec 按保存的 MAX/整数引用解析。
- 单次 LaunchSpec 读取一个一致的 PostgreSQL 快照。

## 暂不设计

- Skill S3 object key、上传、复制、补偿与清理；
- Connector Package 形式；
- RuntimeConfig.Permission 新模型；
- 新密钥系统；
- 复制、分支和合并。
