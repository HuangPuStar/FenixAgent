# @fenix-ee/access-control

EE 对 `@fenix-ce/platform-sdk` 中 `AccessControlModule` 的完整实现。

包含：外部主体到企业工作空间的映射、授权决策，以及将可访问工作空间转换为 `ResourceQueryConstraint`。它可被甲方 SSO、LDAP、ABAC 或自定义授权实现整体替换。

允许依赖：CE 平台契约。

禁止放入：AgentConfig CRUD、实例运行编排、发布状态或 CE 角色模型。它只输出身份、范围和操作决策，供资源应用层消费。
