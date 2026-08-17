# 36. Agent Configuration 必须作为带 revision 的事务聚合保存

| 属性 | 结论 |
| --- | --- |
| 优先级 | P1 |
| 置信度 | 高 |
| 影响 | API 返回失败但主配置已改变、旧绑定被删、并发保存产生混合版本 |

## 对抗判决

Agent 保存按顺序更新主记录、memory、knowledge、skill、MCP、SiteApp、expert。各绑定 helper 使用“先删后插”且没有共享 transaction；任一后续校验/插入失败，前面步骤不会回滚。两个并发全量替换还可能交错成既不是 A 也不是 B 的配置图。

## 已核验证据

- `src/routes/web/config/agents.ts:358-385`：更新路径逐项提交多个子资源。
- 同文件 `:552-579`：创建路径也分阶段提交。
- `src/services/config/agent-config-skill.ts:14-26`、`agent-config-mcp.ts:14-26`、`agent-config-site-app.ts:22-35`：绑定替换无 transaction 参数。
- `src/services/agent-knowledge.ts:121-157`：knowledge 绑定同样独立修改。
- `src/db/schema.ts:443-523,745-799`：引用存在的 FK 不能保证聚合版本原子性或组织一致性。

## 架构诊断

Agent 是一个聚合，当前却暴露多个可独立写的浅 service interface，事务 seam 留给 route。route 删除测试失败：删 route 会连同保存顺序、校验和部分回滚语义一起消失。

## 目标不变量

- 一个 AgentConfiguration command 先在事务外解析/验证外部引用，再在一个数据库事务写主记录、权限和全部关系。
- 所有引用同时通过 [7](./7-enforce-tenant-integrity-in-database.md) 的租户/共享 grant 检查。
- 聚合有 revision/version；客户端基于旧 revision 保存返回 409，不静默覆盖。
- 创建/更新失败后所有表保持原版本；领域事件只在事务成功后发布。
- read model 能返回同一 revision 的完整配置，不能跨事务拼接中间状态。

## 分阶段整改

1. 为每个子步骤注入失败，建立当前 partial write 回归集。
2. 建立 AgentConfiguration Application Module 与 transaction-scoped repositories。
3. 加 revision/CAS 并迁移 UI 冲突反馈。
4. 删除 route 内顺序编排和各子 service 的公开 replace interface。

## 验收

- 任一步失败，主表/所有绑定逐字节等于保存前状态。
- 并发 A/B 保存结果只能是完整 A 或完整 B，过期一方得到可重试冲突。
- 指标包含 validation deny、revision conflict、transaction rollback 和 event publish failure。

## 非目标

不要求把 Agent 运行实例生命周期塞进同一数据库事务；这里只定义配置聚合。实例重启/应用新配置应由后续 operation 明确处理。
