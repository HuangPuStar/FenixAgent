# 7. 把租户完整性从查询习惯提升为数据库不变量

| 属性 | 结论 |
| --- | --- |
| 优先级 | P0 |
| 置信度 | 高；已发现可构造的跨组织关联和同组织用户覆盖 |
| 影响 | wrong-tenant 关联、名称泄露、用户配置互相覆盖、删除级联越界 |

## 对抗判决

多数业务表有 `organizationId`，但关联表只对全局 ID 建外键，没有把“左右两端属于同一组织”编码进数据库。更直接的破坏已存在于 `user_config`：它被定义和使用为用户偏好，主键却只有 organizationId；同组织第二个用户写入会覆盖第一个用户的模型、Agent 和 permission，row.userId 仍可能保留首写者。

## 已核验证据

- `src/db/schema.ts:942-953`：`user_config.organization_id` 是单列主键，`user_id` 不是唯一键组成部分。
- `src/services/config/user-config.ts:18-51`：读取只按组织；upsert 冲突目标也只有组织，虽接收 AuthContext 却忽略 userId 过滤。
- `src/db/schema.ts` 中 `agentKnowledgeBinding`、`agentConfigSkill`、`agentConfigMcp`、`agentConfigSiteApp`、`agentConfigExpert` 等关联通过全局 ID 外键连接，未携带/约束共同 organizationId。
- `src/routes/web/agent-sites.ts:190-216`：创建 app 接受 `agentConfigId` 并直接持久化，没有验证该 config 属于当前组织。
- `src/routes/web/agent-sites.ts:81-92`：补充 creator 名称时按 ID 查询，不附组织过滤。

反例一：同组织用户 A/B 分别保存偏好，B 更新同一 org 主键，A 随后读取 B 的设置。反例二：构造另一个组织的 agentConfigId 与当前组织 app 关联，应用层漏检时数据库接受该关系。

## 架构诊断

TenantScope 目前只是许多函数参数，不是 persistence interface 的组成部分。Repository 仍接受裸 ID，schema 也允许跨租户组合；每个 route 的一次漏检都会穿透到底层。数据库的高 leverage 没有被用于保护领域不变量。

## 目标不变量

- 用户私有数据的键包含 `(organizationId, userId, domainKey)`；先修 `user_config` 为 org+user 复合唯一/主键。
- 租户内实体拥有可被复合 FK 引用的 `(organizationId, id)` 唯一键；关联表携带 organizationId，并强制两端一致。
- 系统级/全局记录使用显式 scope discriminator 或独立表，不用 `organizationId = "system"`/nullable 含糊表达。
- Repository 的 interface 接收 scoped identity，不暴露只按裸 ID 的可误用方法。
- 所有迁移先审计现存跨租户/重复数据，无法归属的记录隔离而非猜测修复。

## 分阶段整改

1. 紧急修复 user_config，编写同组织两用户隔离迁移和测试。
2. 列出全部 tenant-owned 表、关联和唯一约束，生成不变量矩阵。
3. 从高风险绑定表开始增加 organizationId、复合唯一/FK 和 repository scoped key。
4. 删除 route/service 中已经由 DB 保证的重复“兜底”，保留授权检查而非完整性猜测。

## 验收与回滚

- 数据审计查询证明无跨组织关系、无用户配置覆盖；数据库直接插入反例失败。
- 迁移支持 expand → backfill → validate → contract，旧版本应用在 contract 前仍能运行。
- 指标记录约束冲突的匿名计数和表/操作，不输出他组织 ID 细节给客户端。
- 回滚只能回滚应用流量，不删除已建立的保护性约束，除非完成兼容性评估。
