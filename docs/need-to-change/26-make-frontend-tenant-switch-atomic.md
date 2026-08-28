# 26. 前端组织上下文必须是一次原子状态转换

| 属性 | 结论 |
| --- | --- |
| 优先级 | P1 |
| 置信度 | 高 |
| 影响 | UI 显示 A、请求操作 B；跨源泄露组织 ID；首屏使用 stale org |

## 对抗判决

OrgContext monkey-patch 全局 `window.fetch`，每次从 localStorage 读取组织；React UI 状态却不监听 storage。另一个标签页切到 B 后，当前标签仍显示 A，但所有新请求已带 B。Provider 初始化前就渲染 Outlet，首批请求还可能在 interceptor/组织校正前发出。

## 已核验证据

- `web/src/contexts/OrgContext.tsx:33-48`：全局 patch；不限制 same-origin；`fetch(Request)` 未合并 input 自带 headers。
- `web/src/contexts/OrgContext.tsx:58-75`：加载失败只 console，仍结束 loading；没有 error/retry/no-access 状态。
- `web/src/contexts/OrgContext.tsx:78-121`：不监听 storage/BroadcastChannel，切换乐观更新多个权威源。
- `web/src/routes/__root.tsx:53-59`：OrgProvider 内立即渲染子路由，不根据 loading gate。
- 服务端 [8](./8-make-tenant-context-fail-closed.md) 当前还会对错误显式组织 fallback，放大 split-brain。

## 架构诊断

React state、localStorage、Better Auth active org、cookie/header 四个 implementation 都能成为当前组织真相。全局 fetch patch 又突破 API Module seam，把组织 header 加到任何第三方请求。

## 目标不变量

- TenantProvider bootstrap 完成且服务端确认 membership 后才渲染租户业务路由。
- 同源 request adapter 读取不可变 tenant snapshot；第三方请求永不自动携带组织头。
- 切换是 state machine：cancel旧租户请求 → 服务端确认 → 清/分区缓存 → 提交新 snapshot → 导航；失败完整回滚。
- 多标签页通过 storage event/BroadcastChannel 传播版本化切换；收到新版本时停止旧请求并刷新 UI。
- 所有 query cache、Y.Doc/session 和 polling key 包含 org identity，不能仅靠组件重挂。

## 分阶段整改

1. 移除全局 monkey patch，把 org header 收进 [25](./25-repair-frontend-request-seam.md) 的同源 adapter。
2. 增加 bootstrap/error/retry/no-org gate。
3. 实现跨标签页同步与请求 generation，验证切换竞态。
4. 与服务端 fail-closed 上线同一 release，避免一端仍 fallback。

## 验收

- A/B 多标签页切换、慢请求、失败回滚、首次加载和第三方 fetch 均做浏览器交互测试。
- 任何渲染提交前验证 response tenant generation；旧响应不能覆盖新组织视图。
- 可观测信号包含 tenant switch latency/failure、stale-response drop 和 context mismatch；不发送完整组织名等非必要 PII。

## 误报排除

服务端成员校验通常避免未授权数据泄漏；准确风险是同时属于多个组织的用户进行 wrong-tenant 操作。跨源 header 注入则是确定的数据暴露/CORS 行为。
