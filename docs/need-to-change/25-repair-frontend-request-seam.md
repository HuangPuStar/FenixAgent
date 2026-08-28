# 25. 前端请求 Module 只能有一种默认失败语义

| 属性 | 结论 |
| --- | --- |
| 优先级 | P1 |
| 置信度 | 高，真实调用点已闭合 |
| 影响 | 上传/删除/发布假成功、永久 spinner、幂等 header 丢失、取消泄漏 |

## 对抗判决

`request()` 对 HTTP/业务失败返回 `{success:false}` 而不 reject；部分调用者 `unwrap()`，另一部分直接 `await` 并依赖 catch/onError。后者会把 4xx/5xx 当成功。请求组装还在构造 headers 后展开 `...init`，调用方 headers 可覆盖内部 JSON/opId headers；注释承诺的网络重试一次根本没有执行。

## 已核验证据

- `web/src/api/request.ts:90-149`：headers 合并后 `...init` 覆盖；带 headers 的调用会丢 `content-type`/`x-file-op-id`。
- `web/src/api/request.ts:199-236`：失败返回 Result；catch 直接返回 NETWORK_ERROR，没有第二次 execute。
- `web/src/api/request.ts:150`：收到 response headers 就清 timeout，后续慢 `text/json` 不再受控。
- `web/src/api/request.ts:284-298`：合并 signal 的 listener 成功后不移除。
- `web/components/chat/ChatComposer.tsx:299-335`：上传失败仍加入附件。
- `web/src/pages/agent-panel/components/KnowledgeGraphPanel.tsx:264-305`：生成失败仍轮询；删除失败仍清本地图并 toast 成功。
- `VersionPanel`、`VersionIndicator`、`TriggerPanel`、`WorkflowVersions`、`TasksPanel` 均存在未 unwrap mutation。

## 架构诊断

Request Module 同时暴露 Result 和 exception 两套 interface，关键复杂度被推给所有消费者。`useRequest` 的 onError 只理解 rejected Promise，无法补偿这个双语义 seam。假成功不是页面偶发疏忽，而是浅 Module 的系统性产物。

## 目标不变量

- 默认域 client 返回已解包数据；HTTP、业务、解析、timeout、network 统一抛结构化 ApiError。
- 少数需要 Result 的冲突/条件请求使用显式命名的独立 interface，不与默认请求混用。
- headers 按确定顺序合并，内部必须头不可被意外覆盖；允许覆盖项明确列出。
- 带 opId 的可重试写只对网络未知结果重试一次并复用 ID；HTTP/业务错误不重试。
- timeout 覆盖 response body 消费；signal/listener/timer 全部在 finally 释放。
- Query/Muation hook 提供稳定 loading/error/cancel，页面不能把失败映射成 empty。

## 分阶段整改

1. 为 request interface 写黑盒 contract test：header、慢 body、abort、一次重试、HTTP/业务错误。
2. 新增单一异常语义并迁移所有 mutation；每迁移一组删除对应手工 `success` 判断。
3. 迁移 query，要求 error+retry 与 stale data 明确区分。
4. 删除双语义旧入口，不保留 deprecated shim。

## 验收

- 上述真实假成功场景均显示错误且不更新本地成功状态/启动轮询。
- `trigger-panel.test.tsx` 等源码字符串测试替换为真实 HTTP 失败交互。
- telemetry 按 error class/route/status 计数，不记录 body/token；cancel 不计产品错误。

## 回滚

按 API module 垂直迁移，不能在同一调用点同时保留 raw Result 与 throw 分支。回滚以模块为单位，contract tests 始终运行。
