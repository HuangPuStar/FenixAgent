# platform

EE 的平台扩展层，放置对 CE 平台契约的替换实现。

当前子包：

- `enterprise-access-control`：企业身份、租户、授权和多工作空间范围过滤。

允许依赖：CE `platform/` 提供的稳定契约。

禁止依赖：`agent/`、`resources/`、`apps/`；本层只提供决策和范围，不持有资源业务逻辑。
