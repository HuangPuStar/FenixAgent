# Chat 前端界面

> 状态：收敛文档（2026-08-06 修订）。原"Agent 接口"文档中的传输层、协议与数据流描述已由 `19-yjs-chat-streaming.md`（实现基线）完整覆盖，本文档仅保留前端 UI 层的用户能力与组件地图。
> 定位：前端交互式 Chat 的**服务端架构、Y.Doc 协议与数据流**见 `docs/arch/19-yjs-chat-streaming.md`；实例与编排域（spawn / 生命周期）见 `docs/arch/20-orchestration-management.md`；文件信道见 `docs/arch/12-files.md`。
> 约定：描述与代码一致的真实架构；组件路径以相对路径引用。

## 前端能力

前端 ChatPanel / ArtifactsPanel 为用户提供以下交互能力：

| 能力 | 承载组件 | 说明 |
|------|---------|------|
| 流式对话 | ChatPanel | 实时逐字渲染 Agent 回复，支持 Markdown / 代码块高亮 |
| 工具调用可视化 | ChatPanel | 展示工具名、参数、执行进度和结果 |
| 权限审批 | ChatPanel 弹窗 | Agent 执行敏感操作前弹出 ask/allow/deny 三态选择；数据来自 Session Doc `pendingPermissions`（CAS 解析，见 19 号 §8.1） |
| 反问交互 | ChatPanel | Agent 向用户提问时展示问题，用户补全后继续 |
| 产出物浏览 | ArtifactsPanel | 查看 Agent 生成的文件、代码、图片等产出物，支持实时刷新 |
| 工作区文件管理 | ArtifactsPanel / FilePicker | 浏览工作区目录树、上传文件供 Agent 读取、下载生成的文件；HTTP 侧经 `/web/environments/:id/fs/*`（见 12-files.md） |
| 会话切换 | AgentSidebar | 列出历史会话、切换继续对话 |
| Agent 状态感知 | 状态栏 | 显示连接状态、Agent `capabilities`、当前模型等运行时信息 |

## 组件地图

前端只建立**一条** WebSocket 连接：ChatPanel 挂载时通过 `createYjsWs()` / `buildYjsUrl()`（`web/src/yjs/yjs-ws.ts`）连接 `/acp/yjs/:agentId`，所有 Agent 交互（会话、消息、权限、状态）经 YJS CRDT 增量同步完成，不再有独立的 relay / JSON-RPC 通道。

| 组件 | 文件 | 职责 |
|------|------|------|
| ChatPanel | `web/src/pages/agent-panel/ChatPanel.tsx` | 创建 YJS WS 连接、管理连接状态（connecting/connected/error）、监听 `agent:reconnect` 事件重建连接 |
| ACPMain | `web/components/ACPMain.tsx` | 会话引导 bootstrap：等待 Agent `capabilities` 后列出会话并选择/新建；sessions 增量可能分多次到达，用防抖（300ms）等待列表稳定后再执行引导 |
| ChatInterface | `web/components/ChatInterface.tsx` | 核心中枢——注册所有 ACP handler，消费 Chat Doc / Session Doc 渲染 `ThreadEntry[]`，管理 isLoading / errorMessage / todoItems 状态 |
| AgentSidebar | `web/src/pages/agent-panel/AgentSidebar.tsx` | 会话列表与切换 |
| ArtifactsPanel | `web/src/pages/agent-panel/ArtifactsPanel.tsx` | 产出物与文件浏览 |
| FilePicker | `web/components/chat/FilePickerPanel.tsx` / `web/src/components/FilePickerDialog.tsx` | 工作区文件选择与上传 |

## 权威边界

| 关注点 | 权威文档 |
|--------|---------|
| 传输层（`/acp/yjs` WS、配额、背压、断链） | [19-yjs-chat-streaming](./19-yjs-chat-streaming.md) |
| Y.Doc schema、Turn 状态机、Action/Ack 协议 | [19-yjs-chat-streaming](./19-yjs-chat-streaming.md) |
| 实例 spawn / 生命周期 / 编排域 | [20-orchestration-management](./20-orchestration-management.md) |
| 文件操作信道（file-ws、条件请求、变更事件） | [12-files](./12-files.md) |
