# @fenix/access-control

CE 默认的资源范围与动作授权实现，以及把授权条件下推到 SQL 的查询编译器。

## 职责

- **动作推导**：`src/policy/policy-facts.ts` 是唯一一处「actor + resource scope → 有效动作集合」的实现，
  `authorize` / `resolveAccess` / `resolveAccessMany` 与列表谓词编译器共用它。因此列表可见集合与
  单资源校验在结构上不可能漂移；`authorization-consistency.test.ts` 用随机组合断言两者等价。
- **查询下推**：`src/query/build-predicate.ts` 把已解析的授权事实编译为 Drizzle 条件，
  `src/query/drizzle-authorized-resource-query.ts` 实现 `platform-sdk` 的 `AuthorizedResourceQuery` 端口，
  负责 list / count / findById。三个入口共用同一条件，分页、排序与计数一律在授权条件之后。
- **物理绑定**：`src/scope/column-resource-scope-store.ts` 由各资源包声明的
  `ResourceRegistration.storage` 建立 `resourceType → (表, 归属列)` 索引；未知 `resourceType` 直接报错，
  不静默返回空集合。
- **装配**：`src/suite.ts` 的 `createDrizzleAccessControl({ database, bindings, identity })` 产出
  `{ accessControl, authorizedQuery, scopeStore }`，由宿主 `apps/server` 注入资源包。

## 不透明条件

`ResourceQueryConstraint` 是给资源模块用的**不透明句柄**：内部载荷挂在
`platform-sdk` 导出的 `RESOURCE_QUERY_CONSTRAINT_PAYLOAD` symbol 键上，只有本包能读。
资源包既不构造也不解析它——这使「资源模块不得自行判断权限」成为编译期事实，而不是约定。
条件里的 `provider` 字段用于校验一致性，防止跨实现的句柄被混用。

## 归属真相

`visibility` 是四张受控资源主表（`agent_config` / `skill` / `mcp_server` / `provider`）上的
`varchar(20) NOT NULL DEFAULT 'private'` 列，与归属列处于同一张表、同一事务，因此创建期归属由
`resolveInitialScope` 在 INSERT 前解析并由同一条 INSERT 写入，不存在「先建行再补写」的窗口。
`initializeResourceAccess` 留给 EE 的 side-table 型 `ResourceScopeStore`，CE 不调用。

**组织口径是当前 active organization**：组织资源的可见范围只有 `ActorContext.activeOrganizationId` 一个
组织，`memberships`（全量）只用于回答「actor 在当前组织里是什么角色」。跨组织共享只由
`visibility = 'public'` 表达；把成员关系展开成组织 ID 的并集会让其他组织的私有资源混进当前组织的列表
（见 `docs/design/ce-ee-refactoring/review/task-1.2-platform-identity-authorization.md` §1.67）。

## 依赖边界

本包属 `platform-impl`，按依赖矩阵只可依赖 `platform-sdk` 与被绑定的 `identity` 公开入口；
不得依赖 `agent-runtime`、`resources`、`apps`，也不得穿透 identity 的内部路径。
反向方向 `identity → access-control` 由 `FORBIDDEN_PACKAGE_DEPENDENCIES` 阻断。

普通资源模块**不得**依赖本包的具体实现：它们只依赖 `platform-sdk` 的授权契约，实现由宿主注入。

## 已知项

`apps/server/src/db/schema.ts` 中 `resource_permission` 表及其三个 pg enum 的 DDL 仍在（带 `removeWhen`
注释）。它已无任何运行时读写方，但**唯一读者**是启动期数据迁移
`apps/server/src/services/data-migrates/backfill-resource-visibility.ts`——SQL 迁移先于启动期 data migration
执行，同一发布内 DROP 会让全新库启动即失败、升级库静默丢失公开共享语义，因此 DROP 推迟到下一个发布
（回填记入 `data_migrate_record` 之后）。

理由与执行条件见 `docs/design/ce-ee-refactoring/ce-access-control-design.md` §6.2 与
`docs/design/ce-ee-refactoring/review/task-1.2-platform-identity-authorization.md` 第九节。
