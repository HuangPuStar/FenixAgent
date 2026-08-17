# 27. 轮询、mutation 和响应提交必须绑定资源 identity/generation

| 属性 | 结论 |
| --- | --- |
| 优先级 | P1 |
| 置信度 | 高，可用延迟响应稳定复现 |
| 影响 | A 数据覆盖 B 页面、组合错误 ID 执行 mutation、永久 spinner、请求重叠 |

## 对抗判决

AgentKnowledgeBasesPage 用一个共享 interval ref 轮询上传/重解析；切换 KB 不取消旧轮询。A 的延迟响应会在 B 页面执行 `setResources(A)`，完成时又 `runLoadDetail(A)`，而 URL/kbId 仍是 B。随后 UI 可能用 B kbId + A resourceId 发 toggle/reparse。KnowledgeGraph 的 interval 也不随 knowledgeBaseId 变更清理，且 setInterval 允许慢请求重叠。

## 已核验证据

- `web/src/pages/agent-panel/pages/AgentKnowledgeBasesPage.tsx:261-280,355-380,464-531`：资源加载与共享 pollingRef。
- 同文件 `:554-562`：进入新 KB 没有取消旧 operation。
- 同文件 `:1093-1103,1453-1464`：mutation 使用当前 kbId 与当前列表 resourceId，且未 unwrap 失败。
- `web/src/pages/agent-panel/components/KnowledgeGraphPanel.tsx:50-72,264-294`：interval 生命周期只跟卸载，慢 poll 可重叠。
- 多个页面把 raw ApiResponse 交给 `useRequest`，HTTP 失败不会进入 hook error，empty/loading 状态继续推进。

## 架构诊断

异步工作被组件变量/interval 拥有，而非 `{orgId, resourceId, operationId, generation}`。response 提交没有验证自己仍属于当前视图；轮询既是 transport 又是状态机，调用方重复实现终态判断。

## 目标不变量

- 每个 async scope 有稳定 identity、generation 和 AbortSignal；资源/租户切换立即取消上一 scope。
- response 只有 identity+generation 仍匹配时才能提交状态。
- polling single-flight，使用完成后递归调度而非重叠 setInterval；可见性隐藏时暂停。
- 长任务由后端 operation status/SSE 推送更佳；轮询只是有界 fallback，含 deadline、backoff 和失败终态。
- mutation state machine 明确 idle/submitting/succeeded/failed/reconciling，不靠 toast 和局部 boolean 猜状态。

## 分阶段整改

1. 写 A 慢响应 → 立即切 B 的 deterministic test，当前应失败。
2. 抽取可取消 resource operation hook/module，先迁移 KB upload/reparse/graph。
3. 所有资源页面采用 generation 提交保护和统一错误语义。
4. 推动后端提供 operation projection，删除页面内 provider-specific 轮询。

## 验收与观测

- URL、标题、detail、resource 列表和 mutation 参数始终属于同一 identity。
- abort、慢响应、乱序、组件卸载、跨 org 切换不会产生 React state 提交或后端错误目标操作。
- 指标覆盖 overlap prevented、stale response dropped、poll timeout/backoff 和 operation stuck。

## 回滚

逐功能迁移；旧 interval 在切换时至少强制清除。不能为了兼容同时让新旧 poll 写同一 state。
