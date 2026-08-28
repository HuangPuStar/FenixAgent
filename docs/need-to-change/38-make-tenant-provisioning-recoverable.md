# 38. 用户注册与个人组织创建必须原子或可恢复

| 属性 | 结论 |
| --- | --- |
| 优先级 | P1 |
| 置信度 | 高 |
| 影响 | 注册成功但无组织、孤立 organization、首次请求随机失败 |

## 对抗判决

普通用户注册 after-hook 先创建 organization，再创建 owner membership；两次写不在同一事务，catch 只 console.error，不影响注册结果。第二步失败会留下孤立组织；第一/任一步失败会得到“用户已注册但 TenantContext 无法建立”的半成品账户。

## 已核验证据

- `src/auth/better-auth.ts:61-83`：user after-hook 分两次写 organization/member，并吞错继续。
- 系统管理员初始化使用了更严格的事务路径，说明数据库能力存在，但普通注册未复用。
- `src/services/org-context.ts:96-131`：无组织时返回 null，普通业务 route 大量假设 `authContext!`。

## 架构诊断

Identity 与 Tenant Provisioning 是两个 Module，当前通过不可靠 after-hook 串接，没有 durable operation、transaction 或修复状态。注册 HTTP success 被误当作业务账户 ready。

## 目标不变量

- 用户、个人组织、owner membership 对产品而言是一个 provisioning outcome：全部可用或明确 pending/failed。
- 若 better-auth 与业务表可共享 transaction，原子提交；否则建立幂等 Provisioning operation/state machine。
- slug/name 冲突、重复 hook、响应丢失和进程崩溃可安全重试，不创建第二组织。
- 首次登录检测 pending/failed 并自动恢复或给出可操作错误，不进入普通租户页面。
- 审计记录 provisioning operation/attempt，不记录密码/token。

## 分阶段整改

1. 对组织写后、member 写前注入失败，建立半成品回归测试。
2. 抽 TenantProvisioning Module；优先采用单 transaction，否则 durable claim。
3. 增加首次登录 repair 和运营可见的 stuck queue。
4. 删除 after-hook 内吞错式编排，hook 只触发/等待权威 operation。

## 验收

- 任一步失败并任意重试后，最终只有一个组织和一个 owner membership。
- 注册响应/首次登录准确表达 ready/pending/failed。
- 指标包含 provisioning latency/failure/retry/stuck/orphan repair。

## 回滚

保留 operation ledger 和修复器；回滚 UI/接入不能重新允许半成品用户进入业务路由。
