# Access Control

此包将承载默认的用户、组织、角色、资源范围和动作授权实现。

`fenix.module.ts` 声明稳定装配 ID `access-control` 并提供 CE 默认工厂。资源模块通过 `AccessControlModule` 和 `ResourceScopeStore` 访问授权，不读取 member/role，也不接收 SQL 条件。
