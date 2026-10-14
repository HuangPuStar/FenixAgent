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
- Runtime 不读取 actor、成员角色、资源归属或 `visibility`；资源层完成授权与状态校验后才传入已解析的运行参数。

## 特例

`agent_site_app.visibility` 是站点自身的发布范围（`private`、`org`、`authenticated`、`public`），并非平台资源受众列；其读过滤由站点业务在同一 SQL 中下推。见 [Agent Sites](./18-agent-sites.md)。

资源定义、授权接口、迁移要求及实现示例见[Access Control 开发指引](../developer/architecture/access-control.md)。
