# 6. 为未可信内容建立单一渲染安全策略

| 属性 | 结论 |
| --- | --- |
| 优先级 | P0 |
| 置信度 | 高 |
| 影响 | 存储型/同源 XSS、会话内操作、数据外送 |

## 对抗判决

知识库导入内容会进入三条不一致的渲染路径：HTML iframe 同时允许 script 和 same-origin；Docx 转 HTML 后未经清洗进入 DOM；检索高亮相信远端返回 HTML。另一个切片组件已经使用 DOMPurify，证明项目存在正确能力，却没有形成权威 seam。

## 已核验证据

- `web/components/knowledge/ResourcePreviewContent.tsx:308-317`：`srcDoc` 使用 `sandbox="allow-scripts allow-same-origin"`。
- `web/components/knowledge/ResourcePreviewContent.tsx:341-348`：Mammoth 结果直接 `dangerouslySetInnerHTML`，注释错误声称已清洗。
- `node_modules/mammoth/README.md:84-85,146-147,528-535`：库明确声明不执行 sanitisation。
- `web/src/pages/agent-panel/components/RetrievalTestPanel.tsx:438-444`：远端高亮 HTML 未清洗进入 DOM。
- `web/src/pages/agent-panel/components/ChunkDetailSheet.tsx:234-243`：相邻路径已使用 DOMPurify，当前规则不一致。

## 架构诊断

“内容类型”被用来决定 UI 组件，却没有先决定 trust class。每个页面自行选择 iframe、dangerouslySetInnerHTML 或 sanitizer，安全 implementation 泄漏到调用方，locality 极差。

## 目标方向

建立 Content Rendering Module：

- 先标记内容来源、信任等级和允许能力，再选择纯文本、严格 sanitizer、隔离文档域或下载。
- 默认把用户文件、RAG/provider 返回和转换器结果视为不可信。
- HTML allowlist 只保留业务需要的结构/高亮标签；删除事件属性、脚本、危险 URL、表单、嵌入和样式逃逸。
- 需要主动内容时使用独立 origin/严格 CSP 与 postMessage 协议；不能组合 `allow-scripts` + `allow-same-origin`。
- sanitizer 版本、策略 ID 和命中原因可测试、可观测；不允许页面直接调用 `dangerouslySetInnerHTML`。

## 紧急处置与分期

1. 立即去掉 HTML script 能力；Docx/高亮统一经过现有 DOMPurify 严格策略。
2. 收敛成一个渲染 interface，迁移所有 `dangerouslySetInnerHTML`/`srcDoc` 调用。
3. 为文档预览建立独立 origin 或服务端转换为安全中间表示。
4. 增加静态规则，未引用权威 sanitizer 的危险渲染不能进入主分支。

## 验收

- 覆盖 script、onerror、javascript/data URL、SVG、iframe、CSS URL、base 标签、表单和 DOM clobbering payload。
- 清洗不破坏业务允许的 `<em>` 高亮、表格和图片；策略变更有视觉/安全回归集。
- 浏览器 CSP 报告和 sanitizer 拒绝计数可观测，但不记录完整敏感文档。

## 非目标

“内容来自 RAGFlow”不是可信证明：RAGFlow 的输入本身来自租户文档。类型系统的 `string` 也不能表达已清洗；需要显式的安全边界类型或封装组件。
