# platform

CE 的平台层，放置跨所有领域模块共享、且必须保持稳定的契约与基础实现。

当前子包：

- `platform-sdk`：身份主体、资源范围、授权端口、模块声明和应用装配契约。
- `community-access-control`：CE 默认的用户—组织—角色授权实现。

允许依赖：无业务层依赖。

禁止依赖：`agent/`、`resources/`、`apps/`。CE 的组织角色实现不放在 SDK 中，而是位于本层独立的 `community-access-control` 包。
