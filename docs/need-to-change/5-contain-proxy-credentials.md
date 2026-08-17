# 5. 代理边界必须默认剥离凭据和 hop-by-hop headers

| 属性 | 结论 |
| --- | --- |
| 优先级 | P0 |
| 置信度 | 高 |
| 影响 | Session/API Key/组织上下文泄露给下游，响应注入 Cookie/Location |

## 对抗判决

Workflow UI 代理复制全部入站 headers，仅改 Host；Agent Sites 代理只删 Host 和 Cookie，仍会透传 Authorization、API key、组织头和文件操作头。代理把“客户端对 RCS 的授权”误当成“RCS 对下游的授权”。

## 已核验证据

- `src/routes/web/workflow-proxy.ts:5-25`：`new Headers(request.headers)` 后直接发给 acpx-g，并原样返回响应 headers。
- `src/services/agent-sites.ts:183-224`：只删除 `host`/`cookie`，其余入站凭据及响应 headers 基本透传。
- `web/src/contexts/OrgContext.tsx:33-47`：前端全局注入 `X-Active-Org-Id`，扩大被代理的上下文。
- `web/src/api/request.ts:113-120`：文件操作还会携带 `X-File-Op-Id`。

## 架构诊断

proxy implementation 目前以 denylist 猜“不该转发什么”。安全代理应以目标协议为 interface，只构造下游需要的最小 headers。客户端身份、平台身份和下游应用身份是三个不同安全域。

## 目标不变量

- 请求 headers 使用 allowlist；Cookie、Authorization、Proxy-*、Connection、Host、Forwarded 和内部组织/追踪头默认删除。
- 下游凭据由服务端按目标和权限显式铸造，不能复用客户端交给 RCS 的 credential。
- 请求/响应 hop-by-hop headers 严格处理；`Set-Cookie`、`Location`、CSP、CORS 和缓存头按代理场景重写或拒绝。
- body、timeout、客户端 abort、上游 drain 和 backpressure 有独立策略，错误不回显内部 URL。
- 每个代理场景声明身份映射和信任等级，不提供“万能透传”公共函数。

## 验收

- 用 canary Authorization/Cookie/API key 发请求，下游只看到允许的身份材料。
- 恶意下游不能给 RCS 域设置 Cookie、把 Location 指向内部地址或注入宽松 CSP/CORS。
- 大流量/慢下游遵循背压；客户端断开会有限时清理上游，但不会破坏共享资源。

## 依赖与删除条件

应复用 [4](./4-centralize-outbound-request-policy.md) 的目标校验和网络预算。所有 `new Headers(request.headers)` 的代理实现迁移完成后，增加静态门禁并删除旧 helper。
