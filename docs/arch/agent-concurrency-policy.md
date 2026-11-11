# Agent 动态并发策略

`@fenix/agent-runtime` 独占 `agent_concurrency_policy` 的 schema、仓储、服务、管理 Facade 和系统路由。策略只约束下一次准入，不停止已运行的实例。

1. `agentMaxConcurrency`：平台数据库覆盖 → `RCS_AGENT_MAX_CONCURRENCY`；未配置不限。
2. `userAgentMaxConcurrency`：指定用户覆盖 → 平台数据库覆盖 → `RCS_USER_AGENT_MAX_CONCURRENCY`（部署默认 10）。额度按同一用户跨组织累计。
3. `scheduledAgentMaxConcurrency`：平台数据库覆盖 → `RCS_SCHEDULED_AGENT_MAX_CONCURRENCY`；未配置不限。按定时执行租约统计，不按复用实例数统计。

数据库仅允许一条 `userId IS NULL` 平台策略；用户行由 `userId` 唯一索引和身份外键约束，用户删除级联清理。用户行只能设置每用户上限。覆盖为 PostgreSQL integer 范围内的正整数；`null` 恢复继承。平台全空行允许保留，用户空覆盖直接删除。

模块启动先加载并校验全部策略，失败则模块创建失败；未初始化的实例和执行准入都拒绝。管理操作在当前进程串行：事务提交后发布新快照，失败保留上一快照。准入同步读取快照，沿用原总量／用户计数、spawn reservation 和定时执行 lease，不引入数据库 await。

系统密钥守卫保护以下接口：

- `GET/PATCH /api/system/agent-concurrency`
- `GET /api/system/agent-concurrency/users`：仅显式覆盖列表
- `GET/PUT/DELETE /api/system/agent-concurrency/users/:userId`

PUT 请求为 `{userAgentMaxConcurrency: number | null}`。成功返回 `{success:true,data}`；设置投影包含 `override`、`value` 和 `source`（`environment/global/user`），`value:null` 表示不限。用户不存在返回 404。管理页 `/admin/agent-concurrency` 复用 AdminKeyGate，提供平台及用户覆盖、实际值／来源、恢复继承与删除，不读取实例列表。

策略与 reservation 均为进程内治理，管理更新不跨副本广播；当前部署沿用单进程语义，多副本部署需另行设计统一同步与分布式额度。发布先执行 Drizzle DDL，回滚应用前保留策略表即可；删除覆盖可恢复部署配置。服务记录加载和已提交策略变化，错误由上层统一记录，日志不含系统密钥。
