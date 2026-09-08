# @fenix-ce/community-access-control

CE 默认的用户、组织与角色授权实现包。

包含：用户主体映射、默认组织资源归属、组织范围 `ResourceQueryConstraint` 和 CE 资源操作授权决策。生产实现中，成员关系和角色表查询也应收敛在此包。

允许依赖：`@fenix-ce/platform-sdk` 的稳定契约，以及授权实现所需的身份/持久化适配器。

禁止放入：任何资源 DTO、资源 CRUD、实例运行、EE 工作空间或客户定制规则。资源包只能依赖 `AccessControlModule`，不能读取本包的组织角色内部模型。
