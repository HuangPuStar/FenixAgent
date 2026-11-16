# Access Control

Access Control 是资源管理面的唯一授权边界。它基于认证层提供的可信 `actor` 和 active organization
判定资源动作，并为列表查询生成可下推到数据库的约束。

## 主体与组织上下文

- 身份认证与可信主体的建立见[认证系统](./03-auth.md)。
- active organization 的解析、成员角色与资源隔离见[用户与组织](./14-user-org.md)。
- 资源模块、route 和前端不得自行读取成员角色或解释资源受众。

## 资源与授权边界

- `organizationId` 与 `ownerUserId` 是资源主表的归属事实；受控资源的 `visibility` 由 Access Control 解释为平台受众。
- 管理面调用路径是 `route → Resource Facade → Domain Service / Repository`。Facade 在调用领域服务前完成授权和资源状态校验；Access Control 提供单资源动作判定与列表查询约束。
- 列表、计数和详情的授权条件必须下推数据库，禁止先读取全量数据再在内存过滤。
- 授权查询与资源范围更新使用调用方当前事务，不能缓存根数据库连接；创建后的授权回读必须能看到同一事务内的资源。
- Runtime 不读取 actor、成员角色、资源归属或 `visibility`；资源层完成授权与状态校验后才传入已解析的运行参数。

## 嵌入宿主的装配替换

CE 独立启动时，`startHostRuntime` 使用生成的模块清单与默认路由贡献挂载函数。嵌入宿主可在启动前通过可选的 `assemblyOverrides` 同时传入 `manifests` 与 `mountContribution`，在原启动序中替换身份、授权实现和对应认证路由；`bootstrapServerAssembly` 仍按 profile 校验并装配依赖，不接受运行期修改模块。

覆盖不改变生命周期：装配结果句柄由 CE 宿主保管，启动失败及正常关闭时均释放。身份与授权须成套替换，不能让新的身份目录与默认 CE 授权或认证路由混用；嵌入宿主负责在调用前检查这组依赖完整性。

## 特例

`agent_site_app.visibility` 是站点自身的发布范围（`private`、`org`、`authenticated`、`public`），并非平台资源受众列；其读过滤由站点业务在同一 SQL 中下推。见 [Agent Sites](./18-agent-sites.md)。

资源定义、授权接口、迁移要求及实现示例见[Access Control 开发指引](../developer/architecture/access-control.md)。
