# 9. 删除无租户 Workflow 历史存储回退

| 属性 | 结论 |
| --- | --- |
| 优先级 | P0 |
| 置信度 | 高 |
| 影响 | 发现、读取并认领无归属 Workflow，跨组织数据混入 |

## 对抗判决

代码注释声称只扫描当前组织目录，implementation 却无条件扫描全局 `<base>/<workflowId>` 历史路径。恢复接口会把找到的目录和 YAML 以当前请求者的 organizationId/userId 插入数据库。历史兼容层因此成为无鉴权所有权迁移器。

## 已核验证据

- `src/services/workflow/workflow-fs.ts:78-84`：文档同时承诺组织隔离并描述旧路径回退。
- `src/services/workflow/workflow-fs.ts:88-124`：列举可恢复项时总会扫描全局 legacy base。
- `src/services/workflow/workflow-fs.ts:127-138`：新路径不存在就接受全局旧路径。
- `src/repositories/workflow-def.ts:337-375`：恢复时把该目录绑定到当前 AuthContext，没有旧 owner 元数据校验。
- `src/routes/web/workflow-defs.ts:140-185`：普通 session 用户可列出并恢复。

## 架构诊断

长期请求路径承担了一次性数据迁移责任，兼容逻辑没有移除条件，也没有可证明的 ownership。它违反项目“内部路径删除优于兼容”的原则，并把 storage layout 变成授权 seam。

## 目标方向

- 立即关闭在线 legacy 扫描/恢复入口。
- 用一次性、运维授权的 migration/quarantine 工具枚举旧目录，基于可验证元数据映射组织；无法证明归属的条目隔离并人工处理。
- 迁移生成不可变审计清单：source hash、目标 org、操作者、时间、结果；重复运行幂等。
- 完成后删除旧路径读取、全局 UUID 扫描和 action 兼容分支；运行时只接受组织路径。

## 验收

- 任意租户请求不能观察全局 legacy ID 是否存在。
- migration dry-run 与 apply 结果一致；重复执行不产生第二份记录。
- 应用启动/请求路径发现 legacy 目录时只告警并拒绝，不自动认领。
- 存量链接/调用方的移除影响通过明确 release note 处理，不保留隐式 fallback。

## 回滚

旧目录在验证期只读保留并限制运维访问；回滚恢复数据库指向时仍必须保留组织归属，不能重新启用在线全局扫描。
