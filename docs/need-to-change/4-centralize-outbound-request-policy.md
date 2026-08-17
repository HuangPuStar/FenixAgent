# 4. 所有租户可控出网必须经过统一策略

| 属性 | 结论 |
| --- | --- |
| 优先级 | P0 |
| 置信度 | 高；未发现通用 SSRF 防护 seam |
| 影响 | 内网/metadata 探测、凭据外送、DNS rebinding、资源耗尽 |

## 对抗判决

Task HTTP 定义和 Workflow API 节点允许用户直接提供 URL，执行器把它交给 `fetch()`。这使控制面网络位置成为租户能力：loopback、容器服务名、RFC1918、link-local/metadata、重定向目的地和超大响应都进入攻击面。

## 已核验证据

- `src/services/scheduler/http-executor.ts:18-38`：定时任务直接 fetch 用户定义 URL。
- `packages/workflow-engine/src/executor/api-executor.ts:37-64`：API 节点直接 fetch 模板解析后的 URL。
- `src/routes/web/tasks-v2.ts:91-108`：普通 session 用户可创建任务；手动 trigger 同样可达执行器。
- `packages/workflow-engine/src/executor/api-executor.ts:80-98`：完整读取响应后才处理，没有统一响应大小策略。
- 全仓搜索未找到对私网、loopback、link-local、DNS 解析/重绑定和重定向复检的权威实现。

## 架构诊断

“发 HTTP 请求”被当作库调用，不是安全敏感的领域能力。URL 解析、地址分类、DNS、redirect、timeout、响应预算、凭据和审计分散在多个 executor/provider/proxy 中，导致规则没有 leverage。

## 目标方向

建立 Outbound Request Policy Module，所有租户可控目的地必须经同一 interface：

- scheme/port/host allowlist；规范化后再判定。
- 解析全部 A/AAAA，阻断 loopback、private、link-local、multicast、metadata 与平台内部域；连接时复核解析结果。
- 每次重定向重新执行策略，限制次数并禁止跨协议降级。
- 按调用场景决定是否允许公网、是否走 egress proxy、可携带哪些 header/secret。
- 连接、首字节、总时长、响应体、解压后大小和并发均有界；流式丢弃超限响应。
- 只记录目的地主体、策略决策、时延和字节数；URL query/header 先脱敏。

## 分阶段整改

1. 紧急阻断常见内网/metadata 段和非 HTTP(S) scheme，并关闭自动 redirect 或逐跳检查。
2. 迁移 Task 与 Workflow API 节点，补 DNS rebinding、IPv6、十进制/混合编码 IP 测试。
3. 迁移知识库 URL import、webhook、provider 健康检查和所有代理出网。
4. 用静态检查禁止业务代码直接对用户 URL 调用 `fetch`。

## 验收

- `127.0.0.1`、`::1`、RFC1918、169.254.169.254、内部 DNS、重定向到内网、DNS 首次公网二次私网全部被拒。
- 合法公网目标在策略允许时可达，错误可诊断且不暴露内部地址。
- 外部服务慢读、无限 chunk、压缩炸弹不能占满控制面内存或连接池。

## 边界说明

固定、运维配置的内部服务地址可以有独立策略，但不能与租户 URL 共用“只要是字符串就 fetch”的 seam。Workflow 执行迁移到隔离 runner 后仍需要出网策略；隔离不是放弃 egress 控制。
