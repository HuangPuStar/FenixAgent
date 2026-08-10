# Sandbox Provider

FenixAgent 的沙盒 Provider 接口及 OpenSandbox Cluster 实现。

启用 OpenSandbox Cluster Provider：

```env
RCS_SANDBOX_CLUSTER_URL=http://localhost:8080
RCS_SANDBOX_CLUSTER_API_KEY=replace-with-cluster-api-key
```

资源池的 `provider_key` 使用 `opensandbox-cluster`。FenixAgent 首次创建时按 `pool_id + sandbox_id` 调用 Cluster allocate，后续通过同一个业务 `sandbox_id` 代理请求。Cluster 负责 Server 选择、API Key 注入和 host volume 路径改写。

FenixAgent 保存 OpenSandbox 返回的外部沙盒 ID，用于底层查询、恢复和删除。远程删除成功后才释放 Cluster binding，删除失败时保留 binding 以便重试定位。

OpenSandbox create 请求使用 `timeout: null`，由调用方显式删除沙盒，不依赖 TTL 自动回收。
