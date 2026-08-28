# 29. 用聚合 Read Model 和生产预算替代固定轮询/N+1

| 属性 | 结论 |
| --- | --- |
| 优先级 | P2（规模增长前升级为 P1） |
| 置信度 | 高 |
| 影响 | 请求风暴、慢首屏、移动端失败、错误被吞成空数据、镜像膨胀 |

## 对抗判决

Agent Sidebar 每 15 秒取 agents+envs，再对每个 active env 无界并发 detail；WorkflowList 每轮先 GET 并丢结果，再 refresh 第二次 GET；Models list 后每 provider N+1 detail，失败被吞成空模型。Vite 将生产 sourcemap 打进 dist，并把 warning 阈值抬到 10MB；Knowledge 静态引入 G6，未打开图谱也付费。

## 已核验证据

- `web/src/pages/agent-panel/AgentSidebarTree.tsx:111-174`：固定轮询 + active env `Promise.allSettled` N+1。
- `web/src/pages/workflow/WorkflowList.tsx:41-55`：一次 poll 触发两次 list。
- `web/src/pages/agent-panel/pages/AgentModelsPage.tsx:77-99`：provider N+1，单项失败映射空数组。
- `web/vite.config.ts:27-30`：`sourcemap:true`，`chunkSizeWarningLimit:10000`。
- `AgentKnowledgeBasesPage.tsx:61-64` 静态 import Graph panel，后者 `:3-4` import G6。
- 当前工作区新鲜本地 dist：总 55MB、map 36MB；Knowledge 约 1.48MB raw/419KB gzip，Models 约 2.01MB/444KB。该数据不是 release 遥测，只是预算失效的本地证据。

## 架构诊断

后端 query interface 太细，消费者为了渲染一个视图承担 N 次调用、失败聚合和轮询。前端以页面可见性无关的 interval 保持“新鲜”，bundle 又没有 route/feature 预算；错误和 genuine empty 也被合并。

## 目标方向

- 为 Sidebar、Models 等建立租户作用域聚合 read model，返回视图需要的 count/status/summary；避免客户端 N+1。
- 实时状态优先事件/增量 invalidation；轮询有 visibility pause、jitter、single-flight、并发上限和指数退避。
- 图谱、文档预览、xlsx/mammoth、编辑器等重依赖按 route/feature 动态加载。
- sourcemap 不随公开静态制品分发；私有上传到错误平台并受 release 访问控制。
- CI 设 route gzip、初始 JS、总 asset、source map 和请求次数预算；阈值超出需显式评审。

## 分阶段整改

1. 修 Workflow 双请求，给 Sidebar N+1 加并发上限/可见性暂停。
2. 提供 Sidebar/Models 聚合 query，删除前端失败吞空。
3. 对 G6/preview/editor 做动态 import，建立真实浏览器性能基线。
4. 将 budget、Web Vitals 和 API fan-out 纳入 release gate。

## 验收与观测

- 一个页面刷新请求数与 active env/provider 数不再线性增长。
- 慢/失败子资源显示 partial/error，不伪装为空。
- CI 输出每 route gzip 差异；生产监控 LCP/INP、chunk load error、请求扇出和 polling QPS。
- 低端设备/慢网完成关键流程的预算写入验收标准。
