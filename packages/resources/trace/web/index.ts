/**
 * Trace 观测的浏览器安全入口（`package.json` 的 `exports["./web"]` 指向本文件）。
 *
 * 浏览器安全 = 本文件的整条值导入图里不出现 `node:` 内建、`@server/*` 或宿主别名。本包的服务端能力（Langfuse
 * 薄客户端、读取服务、路由）只在 `./server` 出口，**绝不可**从这里转出：`createLangfuseClient` 会用 Basic
 * 凭据发请求，把它放进浏览器面等于把密钥下发到页面。
 *
 * 导出面按包外真实消费点收敛：宿主 `ArtifactsPanel` 取 `TracePanel`（面板装配是壳的职责，与 TasksPanel /
 * ProdViewsPanel 同款），宿主 i18n 经子路径 `./web/i18n` 取字典（见 `web/i18n/index.ts` 的说明：走子路径是
 * 为了不让首屏 bundle 驮上整张面板图）。图与详情的内部件不导出——它们今天没有第二个消费者，提前导出只会把
 * 「内部视图的 props 形状」变成对外契约。
 */

export { TracePanel, type TracePanelProps } from "./components/TracePanel";
export { TRACE_NS, type TraceResources, traceResources } from "./i18n";
