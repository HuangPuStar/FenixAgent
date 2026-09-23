# 前端开发规范

> **版本**：v3.0.19 | **最后更新**：2026-09-23 | **维护者**：前端团队
>
> **最近变更**：
> - v3.0.19 (2026-09-23)：§4.8 超限文件收口**批次三（workflow 包）**——把 workflow 包三个超限生产文件按职责拆开，拆完每个文件 ≤ 500 行（最大 481），全仓超限生产文件由 8 个降到 5 个。① 节点配置卡片 `workflow/components/NodeConfigCard.tsx`（1180）按「卡片壳 / 字段原语 / 按类型分区 / 纯模型 / 下游引用确认」切：壳（233：开始节点分支、基本信息与高级配置两区块、按 `nodeType` 分发、三个弹窗挂载点）+ `node-config-fields.tsx`（91：`BlockField` / `InlineField` / `CollapsibleGroup` 三种字段外形）+ `expand-field-dialog.tsx`（50：展开编辑弹窗，整卡共用一实例）+ `node-config-script-sections.tsx`（146：shell / python）+ `node-config-resource-sections.tsx`（234：agent / api / audit / workflow / loop）+ `node-config-transform-section.tsx`（60：数据变换，输出改名同步下游表达式）+ `node-config-custom-tool-section.tsx`（287：custom 工具与 Slurm 专属字段）+ `node-config-end-section.tsx`（128：出口节点的对外 API 契约说明）+ `node-config-model.ts`（71：工具输入分组、outputs 预填口径，纯函数）+ `node-output-refs-model.ts`（76：下游引用数 / 改名 / 置删除位，纯函数）+ `use-node-output-ref-guard.ts`（114：确认弹窗与 `Promise<boolean>` 的编排）+ `node-output-ref-dialogs.tsx`（93：两个确认弹窗）。**§4.8 已裁定的三容器分叉未动**（`NodeConfigPopover` / `NodeConfigSheet` / `NodeConfigCard` 仍各自手写），`NodeConfigPopover` 的零消费状态原样保留、未在本轮处置；把 outputs 声明块抽成区块（五处逐字相同）与三个字段原语落位，均在上面的文件头写了理由。② 编辑器 `workflow/WorkflowEditor.tsx`（1077）拆成壳 481 + `components/workflow-editor-canvas.tsx`（151：徽标 + ReactFlow 配置 + 两块画布内浮层）+ `components/workflow-editor-canvas-panels.tsx`（248：节点面板与工具栏）+ `components/workflow-editor-bottom-actions.tsx`（184：文件导入导出 / 元数据 / 运行记录开关 / 版本指示器 / 发布 / 刷新草稿）+ `components/workflow-editor-overlays.tsx`（144：两个 Sheet + 运行参数对话框 + 两个确认弹窗，渲染顺序照旧）+ `hooks/use-workflow-draft.ts`（173：草稿加载与版本预览）、`hooks/use-workflow-editor-events.ts`（110：SSE、保存 / dry-run 提示、调试快捷键）、`hooks/use-workflow-node-interactions.ts`（85：节点点选 / 移动 / 删除）、`hooks/use-workflow-run-params.ts`（49：运行参数入口）、`hooks/use-workflow-custom-tools.ts`（37：工具注册表）。③ 运行域 `workflow/hooks/useWorkflowRun.ts`（569）拆成编排 388 + `hooks/use-workflow-run-transport.ts`（139：2s 轮询 / 待审批 / 节点输出）+ `hooks/use-workflow-run-lifecycle.ts`（208：运行 / 取消 / 审批 / 重跑）+ `run-canvas-model.ts`（119：快照落画布与乐观标记，纯函数）；运行回放 effect 收进编排层（与传输层 `loadRunData` 的差别：不推 `pushWorkflowRunStatus`）。④ **手写取数的处置**：原记 6 处里 **1 处收口**（custom 工具列表，状态只有一个写入点，改 `useRequest` + `onError` 保留原日志），其余 5 处经拆分仍不成立、保持手写（理由与新的文件位置写在 §3.6 末条）。⑤ 状态归属不变：所有 useState 仍在组件顶层，`dryRunResult` 从运行 hook 提到编辑器（原先为了声明顺序造了一个 ref 中转，随手写取数口径一并去掉），`useWorkflowRun` 的返回面同步去掉 `dryRunResult` / `setDryRunResult`（唯一消费方已不再取用）；`useRequest` 的配置项范例清单不新增条目。纯结构重构：DOM 结构、类名、i18n key、请求与事件顺序未动，R7 的文案口径原样保留；同批更新 `trigger-panel.test.tsx`（触发器 Sheet 已移到浮层模块）与 `package-error-text-echo.test.ts` 的豁免路径（dry-run 的 `issues[].message` 随提示层落到 `use-workflow-editor-events.ts`），`workflow-browser-surface.test.ts` 的可达面清单补 4 条新共享件。
> - v3.0.18 (2026-09-23)：§4.8 超限文件收口**批次二（knowledge 包）**——把 knowledge 包两个超限生产文件按职责拆开，拆完每个文件 ≤ 500 行（最大 339），全仓超限生产文件由 10 个降到 8 个（最大仍是 1251）。① 知识库页面 `knowledge/pages/agent-panel/pages/AgentKnowledgeBasesPage.tsx`（1243）按「页面 / 数据编排 / 传输适配」切：壳（301：路由 `?kbId=` 的读写、加载骨架与无权限两个整页态、工作区与各弹窗装配）+ `use-knowledge-base-detail.ts`（332：**详情与资源域**——详情与资源列表、上传与同名覆盖、启用开关、资源删除、重新解析与两段「等解析完成」轮询）+ `use-knowledge-base-catalog.ts`（339：**列表与建档域**——列表与表单元数据、创建 / 更新 / 删除、RAGFlow 未关联知识库的导入）+ `knowledge-base-detail-view.tsx`（250：详情头部 + 三 Tab 的叶子渲染）+ `knowledge-base-form-dialog.tsx`（264：创建 / 编辑表单与解析配置区）+ `knowledge-confirm-dialogs.tsx`（120：删库 / 删资源 / 覆盖上传 / 重解析四处确认）+ `knowledge-import-dialog.tsx`（143：导入的两段式弹窗）+ `knowledge-reparse-error.ts`（38：重新解析的错误码 → 字典键，纯函数）。两个域之间不反向读取内部状态：**删掉当前选中项**与**更新成功后的头部同步**都由调用方经回调转交（`onKnowledgeBaseDeleted` / `onKnowledgeBaseUpdated`），删除路径上「清空 `?kbId=` 与清空详情同批落下」的行为不变（否则会有一帧同时渲染选择提示与旧详情）；表单字段仍是 6 个独立 `useState`（不改成对象态），弹窗 props 逐个显式传入。② 资源预览 `knowledge/components/knowledge/ResourcePreviewContent.tsx`（570）按 §3.5 三层切：`resource-preview-model.ts`（142：类别判据 / Office 子类型 / 视频 MIME / CSV 与二维数组整形，纯函数）+ `use-resource-preview.ts`（111：正文取数与 Office 两步探测的编排，含「换资源即重置」的 `resourceId` 重触发）+ 壳（177：按类别分发渲染）+ `resource-preview-placeholders.tsx`（77：骨架 / 失败占位 / 下载兜底）+ `spreadsheet-preview.tsx`（146：xlsx / csv 表格预览与截断口径）。纯结构重构（DOM 结构、类名、i18n key、请求与事件顺序未动），R2 的 `rehype-sanitize` 与显式 DOMPurify 白名单、R7 的错误文案口径均原样保留；`getFileCategory` 的导出口随 `resource-preview-model.ts` 落位、形状不变。同批更新 `knowledge-browser-surface.test.ts` 的可达面清单与计数（28 → 39），并删掉原文件末尾那行已无宿主的 `/** 解析方法卡片选择器 */` 注释。§4.8 的超限清单、计数与统计命令按实测重写。
> - v3.0.17 (2026-09-23)：§4.8 超限文件收口**批次一（500–560 行带）**——实测 20 个生产文件超 500 行，本轮拆掉 9 个、删掉 1 个死文件，剩 10 个（最大 1251）留给后续批次。① 宿主输出面板 `shell/ArtifactsPanel.tsx`（504）按数据域拆成 `use-artifacts-sites.ts`（224：站点列表 / 绑定解绑 / 选中态 / 挂载弹窗）、`use-artifacts-files.ts`（172：tab LRU、diff 角标、拖拽上传、预览事件）与壳（251：模式切换 + 渲染装配）；角标的累加开关原是与 `topMode` 逐点同步的 `userPickedSiteRef`，改为由 `isFilesMode` 派生（写入点一一对应，行为不变）。② `model-management/agent-models-dialogs.tsx`（501）→ Provider 编辑器 `provider-editor-dialog.tsx`（228）+ 共用外壳 `editor-form-dialog.tsx`（69）+ 模型侧三个弹窗（221），消费方 `AgentModelsPage` 改按各自模块导入。③ `agent-config/AgentFormDialog.tsx`（501）→ 容器（130：Sheet / portal 与焦点交接）+ `agent-editor-body.tsx`（387：表单状态、保存流程、三处确认弹窗）。④ `ui-components/chat/shell/ACPMain.tsx`（528）→ `internal/use-acp-session-bootstrap.ts`（240：300ms 防抖选最近会话、延迟 `activeSessionId` 进入、切换失败高亮回退）+ 布局壳（371）。⑤ `agent-runtime/use-chat-state.ts`（511）→ `chat-state-derivation.ts`（429：token 倒序扫描 + meta 子树级缓存，零 React 依赖）+ 订阅 hook（107），由原路径再导出 `computeTokenSnapshot` / `computeMetaSnapshot`。⑥ `web-runtime/chat/structured-to-thread.ts`（537）→ `chat-doc-to-structured.ts`（373：Chat Doc → `StructuredMessage` 的增量派生与失效观察者），入口（179）改用再导出，`exports` 子路径的形状不变。⑦ `knowledge/KnowledgeGraphPanel.tsx`（512）→ `knowledge-graph-spec.ts`（173：G6 配置的纯构建）+ `use-knowledge-graph-canvas.ts`（89：实例生命周期 / 惰性加载 / fitView）+ 面板（306）。⑧ `knowledge/RetrievalTestPanel.tsx`（527）→ `retrieval-search-payload.ts`（73：请求体组装与 meta_filter JSON 解析，纯函数）+ `retrieval-chunk-card.tsx`（84：结果卡片与高亮清洗）+ 面板（429）。⑨ `knowledge/EmbeddingModelManager.tsx`（551）→ `embedding-model-rows.tsx`（183：供应商 / 实例两级行）+ `add-embedding-provider-dialog.tsx`（210：两步提交）+ 壳体（189）。⑩ `workflow/components/NodeConfigPanel.tsx`（557）**直接删除**：全仓零引用、文件头已标 `@deprecated`（替代品 `NodeConfigCard` / `NodeConfigPopover` / `WorkflowMetaCard` 均在用），按原则 10 不留死模块——把死代码拆成两个死模块不是收口。纯结构重构（DOM 结构、类名、i18n key、请求与事件顺序未动），同批更新 5 处**按文件路径断言**的守卫：`sanitize-html.test.ts` 的高亮宿主清单改指 `retrieval-chunk-card.tsx`、`package-error-text-echo.test.ts` 的豁免条目改指 `add-embedding-provider-dialog.tsx`、agent-config 两个编辑器守卫把扫描集合扩到 `agent-editor-body.tsx`、`knowledge-browser-surface.test.ts` 的可达面计数 22 → 28。§4.8 的清单、计数与统计命令同批按实测重写。
> - v3.0.16 (2026-09-23)：§5.9「域模块路径仍普遍回显服务端 `err.message`」**批次二（收尾）**——其余 11 个包（workflow / knowledge / mcp / sandbox / skill / identity / memory / prod-view / model-management / observer / plugin-market）全部按批次一的形态收口：**UI 层不再回显原始 message，各包字典补稳定文案**（判定「Chat 的 `publicErrorText` 不可提炼为通用能力」的理由见 v3.0.15 条目，本轮沿用、未推翻）。① **修法与统计**：实测括号配对口径（从每个 `toast.*(` 起做括号配对取整段实参，覆盖跨行与模板字符串形态）**84 个调用点 / 28 文件 → 8 个 / 5 文件**，其中**修掉 76 处**：workflow 25（`WorkflowList` 4、`WorkflowVersions` 3、`WorkflowRuns` 1、`TriggerPanel` 3、`VersionPanel` 2、`VersionIndicator` 2、`useWorkflowRun` 6、`useWorkflowPersistence` 5、`WorkflowEditor` 1）、knowledge 16（`AgentKnowledgeBasesPage` 10、`EmbeddingModelManager` 5、`RetrievalTestPanel` 1）、mcp 6（`AgentMcpPage` 5、`agent-mcp-dialog` 1）、sandbox 6（`use-sandbox-dashboard` 3、`RemoteSandboxPanel` 2、`ClusterPanel` 1）、skill 6（`AgentSkillsPage`）、identity 4（`AgentOrganizationsPage` 3、`OrgContext` 1）、memory 4（`DocumentsView` 3、`MentalModelsView` 1）、prod-view 3、model-management 2、observer 2、plugin-market 2；单行口径 `grep -rn "toast\.error" apps/web/src packages/*/*/web packages/*/web --include=*.ts --include=*.tsx | grep -c "\.message"` 同步由 **80 行 / 28 文件降到 5 行 / 4 文件**。② **保留回显的 8 处（逐条写明理由，并由新守卫钉住处数）**：① mcp 的 `testUrl` 探测结果 `{ reachable, protocol, message }` 与 knowledge 的厂商 Key 校验结果 `{ success, message }` 是服务端**为展示设计**的字段（自带「非 MCP 协议 / 连接失败」等中文兜底），不是错误信封，去掉等于删掉唯一的连接诊断；② `WorkflowEditor` 里 dry-run 的 `issues[].message` 是**成功响应**里的逐节点校验诊断，标题已由 `t("editor.validate_fail", { count })` 承载且每项带稳定 `code`；③ workflow 的 YAML 导入失败来自**本地** `yamlToFlow`（js-yaml 的 `YAMLException`，描述用户自己刚提交的那份文本、带行列号），不属服务端错误，收窄成「导入失败」会让用户无从定位；④ sandbox 的 `feedback.message` 是本地 `ClusterActionFeedback` 用 `t()` 拼出来的文案（`formatHealthCheckResult`），本身就是字典文案，只是字面上匹配 `.message`。③ **字典改动（en/zh 同批对称）**：失败键一律**去掉 `{{message}}` 槽位**——workflow 的 `list/versions/runs.load_failed`、mcp 的 6 个 `*With`（`loadListFailedWith` / `operationFailedWith` / `deleteFailedWith` / `saveFailedWith` / `inspectFailedWith` / `testFailedWith`，其无后缀兄弟就是同一句话）、skill 的 5 个（含一直是死键的 `toast.operationFailed`）、plugin-market 的 `loadListFailedWith` / `actionFailedWith`、model-management 的 8 个、prod-view 的 `loadError`、identity 的 `orgSwitchFailed`（槽位本来就没人插值）；新增键只补「删掉原文后缺的那句话」：workflow 的 `editor.{approve_failed, cancel_run_failed}` 与三处 `*_load_failed_hint`（失败块在删掉原文后需要一句可执行的说明）、mcp 的 `testFailedRequest`、skill 的 `importFailed`、knowledge 的 `toast.{listUnassociatedFailed, importFailed, toggleResourceFailed}`、prod-view 的 `saveFailed` / `deleteFailed`（顶层与 `panel` 两组，两套外壳各自注入）。**唯一保留槽位且收的是映射后文案**的是 model-management 的 `testDialog.testError`：它的入参是包内自持的 `useProviderTestErrorText()` 输出（码→文案映射，v3.0.15 已登记的既有先例），本轮把这个 helper 的两条兜底分支（非 `ApiError`、以及未登记的 `code`）由 `error.message` 改成 `t("unknownError")`，槽位从此只可能收到字典文案。④ **顺带收口的非 `toast` 回显面（同一缺陷、同批修掉）**：workflow 的 3 处页面级 `EmptyState` 标题（去 `{{error}}` 槽位 + 补 `*_load_failed_hint`）与 `VersionPanel`/`VersionIndicator`/`TriggerPanel` 失败块的说明、`AgentProdViewsPage` 与 `ModelGateway` 概览页的失败标题、`AgentKnowledgeBasesPage` 的 `detailError`（它渲染进失败块）、model-management 的 `errorMessage()` 帮助函数（**已删除**，8 个调用点改上屏字典文案，其中 `ALREADY_EXISTS` 仍按稳定 `code` 分流给可执行的改名提示）。⑤ **诊断上下文**：新增 36 行 `console.error`（此前「只上屏、不落日志」的位置：知识库 5 处、skill 3 处、prod-view 3 处、model-management 6 处、sandbox 5 处、observer 2 处、mcp 1 处等），**原有日志一律保留**——被替换的只是面向用户的文案。⑥ **测试**：新增 `apps/web/src/__tests__/package-error-text-echo.test.ts` 作为跨包回归守卫——按括号配对取每个 `toast.*(` 的整段实参，断言除**逐条登记理由**的 8 处豁免外不得出现 `.message`，并**同时钉住豁免清单的处数**（多一处、少一处都失败，避免豁免清单变成垃圾桶）；`workflow-list-load-state` / `workflow-versions-a11y` / `prod-view-list-states` 三个既有用例的失败态断言由「包含 `加载失败: 服务器内部错误`」改为「包含 `加载失败` 且**不含**服务端原文」；skill 的字典基线由 78 下调到实际 74（删 5 个 `*With`、补 1 个）。⑦ **仍未收口**：knowledge 的 `KnowledgeLoadFailure` 会把服务端 message 作为失败块说明**有意**展示（组件注释写明「排障上下文」，`knowledge-panel-load-failure-states.test.tsx` 还钉着 `boom` / `检索服务不可用` 断言），与本轮口径冲突，改动涉及 4 个调用点与 5 条既有断言，留待单独裁定；model-management 的 `loadProvidersError` / `loadModelConfigError` / `batchDeleteError` / `modelSubrow.testModel.error` 是**全仓零引用**的既有死键（仍带 `{{message}}` 槽位），本轮按「不删除无关死代码」留下并登记。
> - v3.0.15 (2026-09-23)：§5.9「域模块路径仍普遍回显服务端 `err.message`」**批次一**——宿主 `apps/web/src` 与 `resources/{task,agent-config}` 三个范围全部收口（23 个调用点，见下），其余 10 个包留下轮。① **先判定「有没有可复用的统一落点」，结论是没有**：Chat 域的 `publicErrorText` 依赖 ACP `PublicError.type`——那是 `@fenix/chat-channel` 的 `PUBLIC_ERROR_MESSAGES` **封闭登记表**里的取值，且 `message` 被 `isPublicError` 用作 wire 帧完整性校验、服务端恒取 `.en`；web 侧的错误形状是 `{ code: ErrorCode; message: string }`，而 `ErrorCode = KnownErrorCode | (string & {})` 是**开放集**（后端业务码原样透传），没有可穷举的登记表，回退语义也正好相反（Chat 的兜底恰好是「服务端产出的英文安全摘要」，web 侧兜底必须是字典文案，否则就是本批要修的泄露）。两者只是「从错误对象里取一句用户可读的话」这一步长得像，**不是同一个能力**，因此不提炼进 `@fenix/web-runtime`、也不新造通用映射器；按 §9.3 落到「UI 层不再回显原始 message + 各包字典补稳定文案」的形态（包内已有的同类先例：knowledge 的 `getReparseErrorMessage`、model-management 的 `useProviderTestErrorText`，都是各包自持的码→文案映射）。② **修法与统计**：宿主 11 处（`FileTreeTab` 5、`use-agent-sidebar-tree` 4、`use-file-uploads` 1、`ArtifactsPanel` 1）、`resources/task` 8 处（`AgentTasksPage` 7、`ExecutionLogTable` 1）、`resources/agent-config` 8 处（`AgentSitesPage` 5、`use-agent-editor` 2、`AgentFormDialog` 1）+ 2 处无 `toast` 命中但同类的落点（`SiteFrame`、`agent-sites-catalog` 的失败块说明）。**旧快照的「32 个文件、102 处」是单行口径**：实测全仓单行形态 102 行 / 34 文件 → 80 行 / 28 文件（`grep -rn "toast\.error" apps/web/src packages/*/*/web packages/*/web --include=*.ts --include=*.tsx | grep -c "\.message"`）；**括号配对扫描（含跨行调用，模板字符串未被旧口径统计）为 106 个调用点 / 34 文件 → 83 / 28**。两个口径在本轮范围内都是 **0**。③ **字典改动（en/zh 同批）**：失败键一律**去掉 `{{message}}` 槽位**——把原始 message 塞回槽位与直接回显等价，槽位留着就是给下一次回显留门（`enterInstanceFailed` / `restartFailed` / `stopInstanceFailed` / `deleteFailed` / `restartFailedSaved` / `siteFrame.loadFailed` / `loadState.failed` / `save.errorGeneric`）；`siteDeployment.errors` 删掉三个 `*With` 变体（`*With` 与其无后缀兄弟是同一句话的两种写法，改后前者成死键）并补 `delete` / `rotate`；新增 `siteDeployment.errors.loadHint`、`editor.loadFailedHint`（失败块的**说明**在删掉 raw message 后需要一句可执行的话）；task 新增 5 个 mutation 文案键（`toast.loadFailed` / `toggleFailed` / `triggerFailed` / `deleteFailed` / `clearLogsFailed`），其中 `toast.saveFailed` 是**既有死键转正**；agent-config 的 `unknownError` 因唯一消费点被本批改掉而删除。**唯一保留 `{{message}}` 的是 `fileTree.uploadPartialIndeterminate`**：它的槽位改成收 `t("fileTree.uploadFailed")` 这个**稳定文案**，而不是 `error.message`——「部分文件可能已上传、数量未知」那句必须跟在失败原因后面，拆成两个 key 反而拼不回去。④ **两处行为改动（非纯文案）**：`AgentSitesPage.openCreator` 把「创建者智能体未激活」从 `throw new Error(t(...))` 改成**返回值分支**——它与 `envApi.list()` 的 `ApiError` 原先共用一个 `catch`，而 `instanceof Error` 对两者都为真，无法在不丢可执行文案的前提下分流；`use-agent-editor` 的读失败把原始 error 换成 `editor.loadFailedHint`（`loadError.message` 是 `AgentFormDialog` 的说明来源，所以必须在这一侧收敛），另外两个来源 `editor.missingTarget` / `editor.loadRequired` 本来就是字典文案，通道不变。⑤ **诊断上下文**：本批给 6 处「此前只上屏、不落日志」的失败补了 `console.error`（下载、上传、任务日志、Agent 编辑器读失败、站点删除/重签、站点跳创建者），原有 `console.error` 全部保留——被替换的只是面向用户的文案。⑥ **测试**：`task-list-states.test.tsx` 的失败态断言由「包含 `任务加载失败：boom`」改为「包含 `任务加载失败` 且**不含** `boom`」，另新增一例用 `toast.error` 入参钉住 mutation 分支（`启停切换失败只上屏字典文案`，`sonner` 替身改为可记录）；新增 `agent-config/web/__tests__/agent-sites-error-text.test.tsx`（失败块不回显 `error.message` + `role="alert"` + 重试仍可及）。**该用例的断言刻意不依赖译文命中**：`bun test packages/` 在同一进程跑完全部文件，别处对 `react-i18next` 的模块替身会让本文件的 `t()` 退回键回显（单独跑渲染译文、整包跑渲染键，2026-09-23 实测），因此对「取的是哪个键」用 `键|译文` 双形态匹配、对「不回显原始 message」用无条件断言；本包零容忍 `mock.module`（`agent-config-source-migration.test.ts`），故用**真实 i18next + 夹具资源**而不是替身。
> - v3.0.14 (2026-09-23)：§3.6 手写取数**批次二（收尾）**——规范原记的最后两处全部落地，该节偏离条目改为「已消解 + 残留 6 处同类形态（非本轮范围）」。① **workflow 三处面板**：`components/` 下 `TriggerPanel` / `VersionIndicator` / `VersionPanel` 的 `useCallback` + `useEffect` + `setState` 取数改由 `useRequest` 派生三态，重试复用 `refresh`，条件取数 `ready: !!workflowId` 替代「`!workflowId` 提前 return」；失败补 `role="alert"` 持久失败块（字典新增 `editor.trigger_retry`，en/zh 键集 434 → **435**）——此前失败只剩 toast、列表回落成「暂无触发器 / 暂无发布版本」，等于把故障说成「确实没有数据」（§3.4 禁止）。`VersionPanel` 的详情与版本列表**各自一份 `useRequest`**：改造前 `Promise.allSettled` 刻意让「某一项失败不影响另一项」，合并成一份会让任一失败把两份数据一起丢，比改造前更差。`VersionIndicator` 保留「弹层打开才取」（`ready: !!workflowId && open`，`ready: false` 时连 `refresh()` 都被 ahooks 在 `onBefore` 拦下）。**语义差异已记账**：改造前 `!workflowId` 时 `loading` 初始化成 `true` 后无人复位，面板会永久停在 spinner；现在不发请求、落空态。② **轮询改用 `pollingInterval`**：`WorkflowList.tsx` 的手写 `setInterval(pollList, 15_000)` 删除，按 §3.4 的样板补 `pollingInterval: 15_000` + `refreshDeps: [organizationId]` + `ready: !!organizationId`（组织 id 经 `useOrgSession()` 契约取，§1.6 T7）；旧实现每个 tick 发**两次**请求（`pollList` 自己取一次并丢弃结果，再 `refresh()` 重取一次），现为一次。**ahooks 3.9.7 轮询语义已核对源码并在代码注释里写明**：`pollingWhenHidden` 默认 `true`（标签页隐藏时继续轮询）、`pollingErrorRetryCount` 默认 `-1`（失败不中断轮询链）、每轮是「上一笔结束再 `setTimeout` 排下一笔」（不堆积请求）、卸载时 `useUnmount` → `cancel()` → `onCancel` 停轮询。**第二条语义差异**：组织未解析出来时不发请求（`ready`），解析窗口内用 `pending` 维持骨架屏（否则会闪出「暂无工作流」这个「已经问过服务端」的空态）；无组织的账号落空态，与 §5.9 已登记的「组织上下文失败被当成无组织」同源。既有的 `workflow-list-load-state.test.tsx` 同批补 `OrgSessionProvider`。③ **取消一律用 `AbortSignal`**：`KnowledgeGraphPanel` 的手写 `requestId` 令牌删除——令牌只能丢弃迟到的结果，连接仍在服务端跑完；改用 `useRequest` + `request()` 的 `signal`，并在服务内每次请求前 abort 上一笔、卸载时 abort。域模块同批补信号透传：`kbApi.getGraph(params, options?)`、`workflowDefApi` 的 `list` / `get` / `getVersions` / `listTriggers`（新增可选 `WorkflowRequestOptions.signal`，返回 `ApiResponse` 的契约不变，§5.4）。404（尚未生成图谱）仍在服务内归一成 `null` 落空态，「没有图谱」不是失败。④ **测试**：新增 `workflow/web/__tests__/workflow-data-fetching.test.tsx`（9 例，走**真实 `request()`**、只桩 `globalThis.fetch`：无组织 id 不发请求、组织就绪后每 15s 轮询一次（`bun:test` 假定时器推进 15s）、切组织重查且旧请求被 abort、触发器失败块 + 重试后渲染数据、换 workflowId 时后发胜出、版本列表失败块 + 重试、详情失败不影响列表、弹层未打开不取数、弹层内失败块 + 重试）与 `knowledge/web/__tests__/knowledge-graph-data-fetching.test.tsx`（4 例：失败块 + 重试后放行空态、换知识库取消旧请求、404 落空态、成功渲染节点 / 关系计数）。`VersionIndicator` 的弹层内容受 §11.2 的 Portal 限制，按同批 `ConfirmDialog` / `Sheet` 的先例改用 Popover 替身。另订正 `trigger-panel.test.tsx` 的「无硬编码中文」守卫：它逐行筛 `//`，会把 `/** */` 块注释正文误判成用户可见文案（该文件本批起两种注释都用），改为显式跟踪块注释区间。
> - v3.0.13 (2026-09-23)：§3.6 手写取数批次一——`packages/resources/memory/web/pages/hindsight/**` 的 **8 处**（`MemoriesPage` 状态、`DocumentsView` 文档列表、`MentalModelsView` 列表、`MemoryDetailPanel` / `MemoryDetailModal` 详情、`EntitiesView` 列表 + 详情 + 图谱、`DataView` 图谱）全部改用 `useRequest`，并一并收口同子树的 1 处同类变体（`MemoryDetailModal`：只在 `useEffect` 里内联取数、无 `useCallback`）——**实测 9 处，规范原记 8 处**，故 §3.6 的偏离条目按 9 处改写；workflow 与 knowledge 两处**原样保留**给后续批次。① **失败语义**：`hindsightApi` 在域内 `unwrap()`（§5.9），失败抛 `ApiError`，`useRequest` 的 `error` 分支才真正接得住 4xx/5xx；三态一律由 `error` / `data` / `loading` 派生，`catch` + `setState` 的三件套与配套 `useEffect` 全删。② **失败不得映射成 empty**：`DocumentsView` 此前失败只剩 toast、列表回落成「暂无文档」，本批补 `role="alert"` 失败块 + 重试（字典新增 `documents.retry`，en/zh 键集 211 → **212**，`memory-i18n` 的规模下限不变）；`MemoriesPage` 的状态失败若不分支会落进「未配置」空态，同样由失败块接管。③ **失败不得残留旧数据**：`useRequest` 失败时保留上一次成功的数据，两份「详情」组件若直接消费会把**上一条记忆的正文**挂在新的标题下——故失败时显式回落到行摘要（`MemoryDetailPanel`）或让失败分支优先（`MemoryDetailModal`），与改造前 `setFullMemory(null)` 同形。④ **条件取数**：详情用 `ready: !!id` + `refreshDeps: [id]`（关闭 / 无 id 时不发，`ready: false` 连 `refresh()` 也拦得住——弹窗的重试按钮因此不受影响），图谱用 `ready: viewMode === "relations"`，`DataView` 的观察类型整合状态用 `ready: !!data && factType === "observation"` 表达「图谱成功后才取」的前置语义（不再嵌套 `try/catch`）。**语义差异已记账**：`ready` 是「此刻该不该请求」而非「取过一次就缓存住」，故实体图谱在「切到列表再切回关系视图」时会重新取一次（旧实现取到一次即不再取）——图谱本是随时间变化的快照，此处接受刷新。⑤ **依赖**：`packages/resources/memory/package.json` 与 `bun.lock` 同批登记 `ahooks: ^3.9.7`，浏览器可达面白名单（`memory-browser-surface.test.ts`）补一行（未收录即测试变红，见 §11.2）。⑥ **测试**：新增 `memory/web/__tests__/hindsight-data-fetching.test.tsx`（6 例，走**真实 `request()`**、只桩 `globalThis.fetch`：状态失败块 + 重试撤销、文档列表失败块 + 重试后渲染真实数据行、详情乱序到达时后发不被先发覆盖、详情失败不展示上一条正文、弹窗关闭不取数、图谱失败不并发取整合状态）；radix `Portal` 在 happy-dom 下挂不上的实测结论补进 §11.2，弹窗内断言因此落在共用失败块的 `MemoryDetailPanel` 上。
> - v3.0.12 (2026-09-23)：§7.3 错误边界批次——该节前两条**全部落地**，只留「无上报通道」一条。① **统一降级 UI**：新增 `@fenix/ui-components/ui/error-fallback`（`ErrorFallback`；导出面同批补 `web/index.ts`、`package.json` 的 `exports` 与 `barrel-exports.test.ts` 清单）。它的 props 只有 `resetErrorBoundary`（另有可选 `message` / `variant`）——**刻意不接收 `error`**，§7.2 的「降级 UI 不得渲染 `error.message`」因此由类型保证而不是靠 review；文案取包内字典新增的 `errors.renderFailed` / `errors.retry`（`i18n-barrel.test.ts` 基线 272 → **274**）；容器形态沿用 §2.5 `Spinner` 的 `panel` / `screen` 两档词汇。本组件**不依赖 `react-error-boundary`**（该依赖会顺着包出口进所有资源包的浏览器可达面，白名单逐包登记见 §11.2），边界机制留在调用方。② **§7.1 放置矩阵落地五处**：`__root.tsx`（根布局，边界裹在 `RootComponent` 外，`screen` 形态）、`agent/_panel.tsx`（布局路由，边界放在 `Suspense` **外**——懒加载代码块被拒时 `Suspense` 接不住；§2.5 的壳形态原样保留）、`ChatPanel` / `ArtifactsPanel` / `AgentSidebar`（三处均在**导出处**裹边界再渲染同名 `*View` 本体：面板有多个 `return` 出口，取数与运行时 hook 的抛错同样归边界管，故不逐出口加）。五处 `onError` 一律 `console.error`（§7.1 已豁免其补用户可见反馈），**不叠 `toast.error`**（§7.2 末条）。③ **`FileViewerErrorBoundary`**：降级 UI 改用统一 `ErrorFallback` 并补上此前缺失的重试出口（清 `hasError` 重新挂载 `FileViewer`），`error.message` 只进 `componentDidCatch` 的 `console.error`，从未被读过的 `filePath` prop 删除。该节原并列的「中文兜底文案未走 `t()`」属**订正**——`fileTree.preview.componentError` 在 v3.0.10 批次已并入包内字典。④ **测试**：`ui-components/web/__tests__/error-fallback.test.tsx`（4 例：字典文案与 `role="alert"`、重试回调、`message` 覆盖、`variant` 容器形态）与宿主 `apps/web/src/__tests__/error-boundary-fallback.test.tsx`（2 例：真实 `ErrorBoundary` 下抛错渲染降级 UI 且不含 `error.message`、点重试后子树重新渲染）；DOM 用例按 §11.2 自建 happy-dom Window 并**成对注入** `HTMLElement` / `customElements`。§11.3 补一行登记「放置矩阵未自动化」。
> - v3.0.11 (2026-09-23)：§6.5 安全偏离收口批次，该节登记的四条**全部落地**（第 5 条错误文案回显属 §5.9，未动）。① **最大 XSS 面**：`ui-components/web/chat/primitives/iframe-preview.tsx` 两处 iframe 去掉 `allow-same-origin`（与 `allow-scripts` 同时开启时，同源相对地址——正是这条链路的一等来源——可在帧内摘掉自己的 sandbox、读写父页面 DOM 与 sessionStorage），新增模块内 `isSafeIframeSrc` 协议白名单（放行 `http:` / `https:` / 无协议相对地址 / `data:`，拒绝 `javascript:` / `vbscript:` / `file:` / `blob:` / 未知 scheme；匹配前先剥 ASCII 控制符与空格以堵 `java\nscript:` 这类绕过，与 `micromark-util-sanitize-uri` 同口径判定「首个 `:` 在 `/`、`?`、`#` 之后不算协议」），并把 `sandbox` 从透传属性里剔除——此前模型自带的 `sandbox` 会覆盖组件固定值、等于白改；协议不合规的 `src` 整块不渲染。同批发现并修掉**未登记**的同类命中：`knowledge/.../ResourcePreviewContent.tsx` 的 HTML 预览用 `srcDoc` + `allow-scripts` + `allow-same-origin`，而 `srcdoc` 文档继承父页面源（§6.1 已规定 UGC 与 Agent 输出同等不可信），已去掉 `allow-same-origin`。② **第二条 Markdown 渲染链**：`memory/web/pages/hindsight/components/CompactMarkdown.tsx` 复核实测零消费者（全仓除自身与其守卫用例无任何引用），按「删除优于兼容」连同同名 `CompactMarkdown.css` 删除，`react-markdown` / `remark-gfm` 一并从该包 `dependencies` 移除（包内已无其它消费者），原「无消费者的 CompactMarkdown 未进入浏览器图」用例随文件失去对象而删除，包 README 已知项第 2 条改写为处置记录。③ **knowledge 预览 Markdown**：`ResourcePreviewContent.tsx` 的 `react-markdown` 补 `rehype-sanitize`（GitHub 默认 schema，新增依赖 `rehype-sanitize@^6.0.0`；react-markdown 本身不渲染原始 HTML，这层补的是白名单外的标签、危险协议与事件属性），`knowledge-browser-surface.test.ts` 白名单与「遍历有效性自检」计数（21 → **22**，新增 `lib/sanitize-html.ts`）同批更新。④ **3 处 `dangerouslySetInnerHTML` 的 DOMPurify 默认配置**：抽成 `knowledge/web/lib/sanitize-html.ts` 的两份显式白名单——`sanitizeHighlightHtml` 取最小集（`em` / `span` / `br` + `class`，对齐后端 schema 里「含 `<em>` 标签的 HTML」的契约），`sanitizeRichHtml` 覆盖结构富文本（段落 / 标题 / 列表 / 表格 / 内联图 / 链接，去掉表单、内联 SVG 与 MathML、iframe、媒体与样式表；保留 `data:` 内联图与 `class`，后者不承担阻断 Tailwind 类名注入的职责），三处调用点全部改走 helper、不再直连 `DOMPurify`。**测试侧**：新增 `iframe-preview-sandbox.test.tsx`（6 例：SSR 断言合法来源的 sandbox 取值、相对地址仍可用、危险协议整块不渲染、模型传入的 `sandbox` 不生效，末例用源码断言覆盖弹窗内取不到的第二处 iframe）与 `sanitize-html.test.ts`（6 例：两份白名单的内容与接线）；后者的**运行时行为断言在本环境做不了**——DOMPurify 3.4.11 与 happy-dom 20 实测两处不兼容（`lookupGetter(Node.prototype,'nodeName')` 在 happy-dom 下取到空串使所有节点被当成白名单外、且其 NodeIterator 在首次节点移除后中止），真实浏览器走规范实现不受影响，结论写在测试文件头并登记到 §11.2。§10.1 的非页面级计数因删掉 `CompactMarkdown.css`（27 行、配 `.tsx` 兄弟）就地重跑该节命令：伴随表 68 → **67 份** / 3857 → **3830 行**（配 `.tsx` 兄弟 64 → **63** 份、配 `.ts` 4 份不变），其余三类与 §10 单列项无变化。
> - v3.0.10 (2026-09-23)：§9.4 硬编码用户可见文案的收口批次——该节登记的**五处现存命中全部改走各包字典**：`agent-config/AgentSitesCard.tsx`（6 处中文，另含兜底英文 `Unknown Site`；失败态同时由「比对中文前缀」改为 `missing-attribute` / `load-failed` 枚举，否则文案本地化后判定失效）、`knowledge/ChunkDetailSheet.tsx`（复用既有 `preview.loadError`，不新增同义键）、`task/TasksPanel.tsx`、`task/TaskForm.tsx`（3 处）、`ui-components/FileViewerPreview.tsx`（内置 `zhCNMessages` 与错误边界提示改由包内字典按当前语言取值，`locale` 不再固定 `zh-CN`；`messages` / `locale` 保留为覆盖端口）。`ui-components` 的 `html-plugin.ts`（插件直接操作 DOM、不在 React 树内）与 `preview-source.ts`（纯逻辑模块不得 import UI i18n，见 §9.3）两处**有意保留**的硬编码随之登记到该包 README「已知限制」第 12 / 13 条，`html-plugin.ts` 文件头原先「见 README」的悬空引用改为指向该条；同表三处「第 N 条」交叉引用（`message.tsx`、`FileViewerPreview.tsx` 两处）原本整体 +1 错位，一并订正。§9.4 与 §11.3 的包内 i18n 测试计数 13 → **14** 就地重测（`plugin-market-i18n.test.ts` 随插件市场模块入库；`ui-components` 的字典守卫名为 `i18n-barrel.test.ts`，不在该 glob 内，§11.3 一并写明）。
> - v3.0.9 (2026-09-23)：目录索引统一批次（`f73f9265` 把 `components/agent-catalog-index` 的视觉默认值全部下沉到组件 CSS，五页目录改成同一套）后的文档对账。§4.1 该原语的一条按用户裁定重写并**作废**旧口径「共享结构、字号 / 内边距 / 行高 / 圆角 / 选中配色留各页刻度」——现在默认值全在共享组件、五页渲染同一组计算值、页面覆盖归零（各页 30 余条目录规则随之下沉删除），页面只保留独有语义（知识库行尾删除按钮的外壳与不可用态、组织页角色三态图标着色，以及知识库 ≤760px 隐藏与组织页 ≤900px 横置两处布局行为），并写明不再留各页刻度的原因。§10.1 的两行计数就地重测并把测量点从 `5626bb1a` 推到 **`f73f9265`**：资源侧页面级 2636 → **2416** 行（12 份不变；`agent-knowledge.css` 331→268、`agent-models.css` 330→278、`agent-mcp.css` 132→34、`agent-skills.css` 83→76），宿主页面级 5 份 / 1811 行不变，类别 ③ 伴随表 3792 → **3857** 行（68 份不变，64 份配 `.tsx` + 4 份配 `.ts`；两处变化是 `agent-catalog-index.css` 199→299 与 `agent-organizations-workspace.css` 92→57），token 入口 781 + 272 行、第三方覆盖表 43 行、chat 模块表 3 份 / 148 行均按同一命令复核无变化。
> - v3.0.8 (2026-09-23)：目录栏收敛批次（「左侧目录 + 右侧内容」面板的目录栏收成一套共享构件集，并删掉 `components/WorkbenchPanel`）后的文档对账。§4.1 补登本批下沉的 `components/agent-catalog-index`（技能库 / MCP / 模型库 / 知识库 / 组织管理五页改用），并记 `components/agent-master-detail-workspace` **不在**该小节的「去重批次」口径内——它早于该批次（2026-09-20 的 `e8c73280` 前置落地），本批只是把记忆页从已删除的 `components/WorkbenchPanel` 切到它。子路径数与 barrel 行数改为实测值（156→**158** 条 `exports` 子路径、160→**161** 行 barrel；本批删 `./components/WorkbenchPanel`、增 `./components/agent-catalog-index`，条数净 0）。§10.1 的两行计数就地写明口径并重测（宿主页面级 5 份 / 1811 行、资源侧 12 份 / 2636 行；类别 ③ 伴随表 68 份 / 3792 行；token 入口 781 + 272 行），该节附带可原样复跑的统计命令——v3.0.5 / v3.0.7 变更行里的「页面级 9 → 8 个 / 2496 → 1983 行」与「伴随表 66 → 67 份 / 3348 → 3391 行」都是在前一次记下的数字上做加减得来的（起点 66 是提交信息里的新增文件数，行数没有实测支撑），与实测不符，已随之作废。
> - v3.0.7 (2026-09-23)：组织管理页（`packages/platform/identity/.../agent-organizations.css`，513 行）整片转换为 Tailwind 工具类并删除该表——页面级样式表再少一张；唯一无法用工具类表达的部分（≤900px 断点组：非标准断点 + 必须压过库内未分层的列定义）下沉为同目录同名的伴随表 `agent-organizations-workspace.css`（43 行，类别 ③）。§10.1 计数按此同步：资源侧页面级 9 → **8** 个 / 2496 → **1983** 行，类别 ③ 伴随表 66 → **67** 份 / 3348 → **3391** 行。字号档位映射（含 13px 根字号下的实测偏差）见 `agent-organizations-workspace.tsx` 文件头注释。
> - v3.0.6 (2026-09-23)：§2.5 删去「极简（无 `Suspense`）」这一壳形态（原例 `_panel/agents.tsx`），改为「不许有无 `Suspense` 的极简壳」并说明原因：缺边界的懒加载会冒泡到 `_panel.tsx` 为壳自身备的整屏 `Spinner variant="screen"`，把整个 WebShell 卸载重建（用户视为「整页刷新」）。`_panel/agents.tsx` 同批补上 `Suspense` + `PanelRouteFallback`，接线形态回到「标准」。
> - v3.0.5 (2026-09-23)：Web 样式禁止行为门禁（`bun run check:web-style`）接入后，§10 新增**类别 ③「深层样式伴随表」**——与源文件同目录同名的 `.css`，承载无法用扁平工具类表达的选择器嵌套／复合表达式值／无标准变体的媒体查询，并给出三条约束（严格同名同目录、优先沿用源选择器名、不包 `@layer` 且逐处确认胜负关系）；「新增 `.css` 的落位」由「只用前两种」放宽为「只用前三类」。§10.1 的页面级 `.css` 计数按实测口径重写（资源侧 14 → **9** 个 / 3370 → **2496** 行；token 入口与新增伴随表同步实测）。规则口径与存量清理过程见 `forbidden-code-patterns.md`。
> - v3.0.4 (2026-09-22)：前端去重批次（约 65 个 commit）后的文档对账。§4.1 补登本轮新下沉的原语（`config/AdminKeyGate`、`config/LabeledField`、`ui/status-dot`、`components/ClosableTabPill`、`lib/clipboard`、`lib/format`、`chat/view/PublicErrorCard`、`chat/panels/chat-interaction-region`、`chat/timeline/tool-json-block`），并把「空态 / 失败 / 无权限刻意共用一个骨架」与「无权限不给重试、失败给重试」写进该节的口径——**不要新建第二个空态/失败组件**；子路径数与 barrel 行数改为实测值（145→**156** 条 `exports` 子路径、151→**160** 行 barrel）。§4.8 新增「刻意分叉 / 刻意不进库」四条冻结项（三种节点配置容器、cytoscape 与自绘 canvas 两套图谱、红描边危险按钮、形态未定型包内共享件）。`MasterKeyGate` 全量订正为 `@fenix/ui-components/config/AdminKeyGate` + `@fenix/web-runtime/hooks/use-admin-key-gate`（§2.3、§6.3 与 `docs/arch/21-observability-observer-service.md`）。§5.6 / §5.9 删去已随 `ac642962` 删除的 `workflow/web/api/workflows.ts`，§4.8 的文件规模快照（16→**17** 个超 500 行、400–499 区间 27→**25**）与 §10.1 的页面级 `.css` 计数按实测口径重写。
> - v3.0.3 (2026-09-22)：§2.5 的加载壳口径改写——原「三种壳形态都合规」**作废**（它把逐字复制的圆环类名固化成规范），路由 `Suspense` fallback 与整块加载提示一律改用 `Spinner`（`@fenix/ui-components/ui/spinner`），并补 `variant` / `size` / `label` 的选择口径；§2.7 登记存量未迁移位置。
> - v3.0.2 (2026-09-22)：把「失败必须有用户可见反馈」从隐含口径写成**可 review 的规则**（§5.8 新增：三条件判据 + 三类必然豁免 + `/login`、`/admin` 下无 `Toaster` 的坑）。据此做了一轮全量处理：4 处原生 `confirm()` 全部迁 `ConfirmDialog`（删除 §6.5 对应偏离项），逐点复核全仓 `console.error` 并补齐缺失反馈，未动的残留登记到 §5.9。§11.2 补「`react-i18next` 替身必须返回稳定 `t`」——该替身缺陷会让测试陷入反复拉取且生产不复现。
> - v3.0.1 (2026-09-22)：精简第 1 章与第 10 章——原 §1.1 应用根 / §1.2 宿主源码目录 / §1.3 包边界与引用纪律，以及原 §10.1～§10.5，改写为几段说明与规则列表，只保留可据以 review 的硬规则；§1 子节重编号为 §1.1 装配产物与构建、§1.2 路径别名纪律、§1.3 现状偏离。同步移除 `packages/supaflow/web` 与 `e2e/` 的排除项（两者已从仓库移除），并补充"新增 `.css` 的落位"与"禁止 `@apply`"两条纪律。
> - v3.0.0 (2026-09-22)：按 CE/EE 1.6 / 1.7 收口后的**代码事实**全面重写。删除全部 target / transitional 标记与 `docs/need-to-change/*` 引用（该目录已删除），规范只描述**当前不变量**；每章新增「现状偏离」记录规则尚未落地的已知位置；新增适用范围声明（§0.1）、装配产物（§1.1）、侧栏装配（§2.6）、iframe 沙箱（§6.2）、实时通道登记（§8.1）、CSS 文件边界（§10）。
> - v2.0.0 (2026-09-22)：按 CE/EE 任务 1.6 T11e 收口后的架构校订。
> - v1.0.0 (2026-06-30)：初始版本。

本文档面向 FenixAgent 主控制台前端开发，约束目录组织、包边界、路由与导航、状态管理、组件规范、API 调用、安全规范、错误边界、实时通信、i18n 国际化和样式体系。规则冲突时以本文档、`CLAUDE.md` 与 `CONTRIBUTING.md` 为准；三者不一致时以本文档为准，并同批修正另外两处。

## 0. 使用约定

### 0.1 适用范围

**覆盖**：`apps/web/**`（宿主应用）与 `packages/**/web/**`（各 owner 包的 web 面）。

**不在管辖内**——读者 grep 到这些目录里的写法时，不要当成本规范的反例，也不要照抄：

| 目录 | 是什么 | 为什么排除 |
|------|--------|-----------|
| `ui-sandbox/` | 独立 Vite 设计沙盘（端口 5174，Hash 路由，全 Mock），自带 `bun.lock`，**不在 bun workspace 内** | 设计稿验证环境，不是产品代码，不参与 `precheck` |
| `packages/**/src/server/**`、`packages/chat-channel/src/server.ts` | 服务端能力 | 由后端规范约束（见 `backend-development.md`） |

### 0.2 规则与现状

本文档只写**当前规则**——即代码已按此实现、可以据以 review 的不变量。每章末尾的 **「现状偏离」** 只做一件事：记录该章规则**尚未落地**的已知位置，让读者能区分「规则要求什么」与「现在做到哪」。

**偏离不是许可**。不要因为某处已经违规就照抄它的写法；新代码按规则写。

> 历史上本文档用 `current` / `target` / `transitional` 三态标记配合 `docs/need-to-change/<n>` 编号跟踪在途项。该目录已于 2026-09-22 删除，三态标记与编号引用一并移除；未落地事项改为在对应章节按**具体文件位置**登记。
>
> 偏离清单是**快照**，不是持久账本：修复后请顺手删掉对应条目，不要让它变成"历史记录"。

## 1. 目录结构与包边界

`apps/web` 是本版本**唯一的前端构建入口**（React 19 + Vite + TanStack Router，挂在 `/ctrl`），只提供应用壳——路由、Provider、侧栏装配与宿主专有页面；业务能力按**资源归属**分布在 `packages/**`，各包经 `package.json` 的 `exports` 暴露 web 面。宿主 `apps/web/src/` 的分工：`routes/` 路由壳 · `pages/` 宿主专有页面 · `shell/` 应用壳与侧栏装配 · `api/` 宿主专有域 · `components/` · `hooks/` · `lib/` · `i18n/` 装配 · `types/` · `__tests__/`。UI 原语、请求基建、组织会话契约、资源域 API / 页面 / 字典、共享域类型一律由包提供，宿主不留副本。

`apps/web/` 的入口约定：`index.html` 是 Vite 唯一 HTML input（挂 `src/main.tsx`）；`main.tsx` 是唯一启动入口（装 polyfill → `loadAppBrand()` → `createRouter({ routeTree, basepath: "/ctrl" })`）；`src/index.css` 是 Tailwind v4 入口（token 与 `@source` 扫描范围，见 §10）；`fenix.module.ts` 是 `kind: "web-shell"` 的装配描述符，**只允许 `import type`**；`src/routeTree.gen.ts` 是**入库的生成产物，严禁手改**；`src/App.tsx` **不是 React 组件**，只导出 `parseConfigView(pathname)` 纯函数。

**路径前缀三处必须一致**：`vite.config.ts` 的 `base: "/ctrl/"`、`main.tsx` 的 `basepath: "/ctrl"`、服务端 `staticPlugin` 的 `prefix: "/ctrl"`。

三条硬规则：

- **引用一律经对方 `exports`**：禁止深引 `@fenix/<pkg>/src/*` 或 `@fenix/<pkg>/web/src/*`（`package-no-internal-imports` 阻断，见 §11.2）。`web/src/**` 是包内实现路径、不是域模块出口——它当前存在于 `sandbox` / `agent-config` / `model-management` / `knowledge` / `machine` 五个包（历史差异），新增包一律用 `web/api/`。
- **组件源码必须落在 `<pkg>/web/` 下**：宿主 Tailwind 的 `@source` 只扫 `packages/**/web/**`，放到 `packages/<pkg>/components/` 的组件其工具类会被**静默裁剪**（§10）。同一个理由让 `web/` 成为浏览器安全边界的判据目录（§11.2）。
- **导出面按包外真实消费点收敛**：未出现第二个消费者前不导出（内部视图的 props 形状不是对外契约）；确需跨包少量复用时才单开窄口，并在 `exports` 显式声明。

**归属按资源落位**：接口对应哪张表、哪个 owner，域模块就放在那个包。宿主 `apps/web/src/api/` 只收**无资源包归属**的宿主专有域——`branding` / `fs` / `instances` / `peri-task-details` / `helpers`（后者是 UUID 工具，不含 HTTP）。

**包的 `./web` 出口形状不统一**，改包前先看它的 `exports`：

- 标准三件套 `./web` + `./web/contribution` + `./web/i18n`：`resources/*` 的 8 个包（agent-config / knowledge / mcp / memory / model-management / skill / task / workflow）与 `platform/identity`，合计 9 个，与 `ce.json` 的 `web` 列表等长。
- 只有 `./web`、无 contribution：`machine` / `observer` / `prod-view` / `sandbox` / `channel`——有 web 面但不在 CE 的 web profile 里。
- 不走 `web` 前缀：`ui-components`（根 barrel + 158 条 `exports` 子路径，按需深链优先）、`web-runtime`（`./api/request`、`./contexts/org-session`、`./types/config`…）、`agent-runtime`（web 面仅 `./web/api/environments` 一条窄口，浏览器不得依赖其反向 `export *` 的服务端根入口）、`chat-channel`（无 web 面，根入口必须浏览器安全，见 §8.6）。

### 1.1 装配产物与构建

| 环节 | 事实 |
|------|------|
| 路由树 | `apps/web/vite.config.ts` 的 `TanStackRouterVite` 插件在 dev/build 时生成 `src/routeTree.gen.ts`；**没有独立生成脚本**，改路由后必须跑一次 `bun run dev:web` 或 `build:web` 才会重生 |
| 导航装配 | `scripts/generate-web-contributions.ts` 读 `deploy/assembly/ce.json` 的 `web` 列表，产出 `apps/generated/web-contributions.ts`；`bun run generate:web-contributions --check` 进 CI |
| 模块注册 | `scripts/generate-module-registry.ts` 产出 `apps/generated/module-registry.ts`，由服务端 bootstrap 消费 |
| 产物保管 | `apps/generated/` **入库**，`biome.json` 排除格式化。它是浏览器 bundle 的**静态依赖**（`shell-navigation.ts` 直接 import），所以换部署 profile 必须重跑 `build:web`——产物本身入库是为了让构建可复现与可 diff，不是让 profile 免于重构建 |
| 构建命令 | `bun run build:web` = `vite build --config apps/web/vite.config.ts`；生产开 `sourcemap: true` |
| 静态挂载 | `apps/server/src/plugins/static.ts` 从 `apps/web/dist/` 挂载；SPA fallback 依赖 `onError({ as: "global" })` + 显式 `set.status = 200` + 注册在 `errorPlugin` 之前，改这块前先读该文件注释 |
| chunk 分组 | `manualChunks` 分 10 组（shiki / mermaid / motion / vendor / ai-sdk / qr / radix-ui / tanstack-router / tanstack / hookform），改名或合并会影响缓存与首屏 |
| 部署变量 | 打包部署必须设 `RCS_APPLICATION_ROOT`（未设时回落到源码根），Docker build 阶段还必须 `COPY apps/generated` |

### 1.2 路径别名纪律

别名只保留**宿主自有**目标（指向 `apps/web/src/**` 与 `apps/server/src/**`）。**禁止新增指向 `packages/**` 的别名**——跨包引用一律经各包 `exports`。

仓库里共有三张 `paths` / `alias` 表，改动前必须分清哪张对谁生效：`apps/web/vite.config.ts` 的 `resolve.alias`（构建期解析，8 条前缀式键）、根 `tsconfig.json` 的 `paths`（前端类型检查 + **dependency-cruiser 的判定基准**，8 条 `*` 模式键）、`tsconfig.base.json` 的 `paths`（服务端与包，12 条 `@fenix/*` → `packages/**/src/**`）。**`apps/web` 看不到第三张表的条目**——`tsconfig` 的 `paths` 是整体替换而非合并，已用 `tsc -p apps/web/tsconfig.json --showConfig` 验证。

纪律：

- vite 表与根 `paths` 表**必须逐条对应**。键写法不同（前缀 vs `*` 模式）无法机械对账，删改时必须同批改两张表；只改一张会产生最难查的一类问题——门禁能解析、生产构建解析不到。
- `@/src/i18n/locales` 必须排在 `@/src/i18n` 之前（vite 按声明顺序取首个匹配），否则字典目录会被 i18n 单例吃掉。
- 包内自建别名表（`acp-link` / `agent-runtime` / `chat-channel` / `agent-config` / `ui-components`（tsconfig 与 vite 两张）/ `web-runtime`，共 6 个包）只服务包自身，不要指望宿主别名在包内生效。

### 1.3 现状偏离

- **`apps/web/src/api/helpers.ts` 零生产消费方**（仅别名声明与测试引用），是事实死代码。
- **浏览器安全入口守卫未覆盖全部带 web 面的包**：13 份 `web/__tests__/*-browser-surface.test.ts` 全在 `packages/resources/*`；`platform/identity` 有完整 `./web` 面但无守卫，`ui-components` / `web-runtime` / `agent-runtime` 的 web 面同样无守卫（当前只作为别人导入图里的共享基础设施被间接断言）。
- **`apps/web/src/types/index.ts` 仍持有 channel 域类型**（`ChannelProviderInfo` / `ChannelInfo` / `ChannelBinding` 等），而 channel 已有 `@fenix/resource-channel/web`；归属待裁定。

## 2. 路由与导航

使用 TanStack Router（file-based routing）：`@tanstack/react-router` ^1.170、`@tanstack/router-plugin` ^1.168。`apps/web/src/routes/` 下的文件由 Vite 插件映射为 URL，产物 `src/routeTree.gen.ts` **入库且严禁手改**（`biome.json` 已排除其格式化）。应用挂在 `/ctrl` 前缀下（`main.tsx` 的 `basepath` 与 `vite.config.ts` 的 `base` 必须同时改）。

### 2.1 文件命名约定

| 语法 | 含义 | 真实示例 |
|------|------|----------|
| `_panel` | pathless 布局片段（不贡献 URL 段） | `agent/_panel.tsx` → `/agent`，`_panel/` 下 23 个路由文件共享它 |
| `$param` | 动态路径参数 | `_panel/chat.$agentId.tsx` → `/agent/chat/$agentId` |
| `_` 后缀（动态段） | 分隔相邻动态参数 | `chat.$agentId_.$sessionId.tsx` → `chat/$agentId/$sessionId` |
| `_` 后缀（静态段） | 阻止后续段成为前一段的子路由 | `workflow_.$id.edit.tsx` → `/agent/workflow/$id/edit`（否则 `$id` 会挂到 `workflow.tsx` 下） |

**`_panel` 的边界要记清**：它只管 `/agent/<面板页>` 与 `/agent/chat/*`。`/agent/$agentId` 与 `/agent/$agentId/$sessionId` 是 **rootRoute 的兄弟**，不受 `_panel` 布局包裹——它们只有 `beforeLoad` + `throw redirect` 的兼容旧 URL 重定向桩，**不声明 `component`**（redirect 在渲染前抛出，桩永远不渲染任何东西）。

### 2.2 路由参数

```tsx
const { agentId } = Route.useParams();              // 路由壳内
const search = useSearch({ strict: false }) as { runId?: string };  // 宿主未声明 validateSearch，必须断言
```

包内页面需要读宿主动态段时，用带 `from` 的形式——此时**宿主的 route id 成为跨包契约**，改宿主路由必须同步搜跨包引用：

```tsx
// packages/resources/prod-view/web/pages/prod-view/ProdViewPage.tsx
const { prodViewId } = useParams({ from: "/view/$prodViewId" }) as { prodViewId: string };
```

`useSearch({ strict: false })` 的断言**不做运行时校验**：新增查询参数时要自己兜底默认值。

### 2.3 鉴权与重定向

**全局守卫只有一处**，在 `apps/web/src/routes/__root.tsx`，用 `useEffect` + `navigate` 实现（不是 `beforeLoad`）：

- 会话未就绪 → 渲染 spinner；未登录且非 `/login` 非 `/admin` → 渲染 `null` 并跳 `/login`；已登录访问 `/login` → 跳 `/agent`。
- `/admin` **豁免 better-auth 会话**，由页面内 `AdminKeyGate`（`@fenix/ui-components/config/AdminKeyGate` 配 `@fenix/web-runtime/hooks/use-admin-key-gate`）把关（见 §6.3）。

**路由壳内**的重定向一律用 `beforeLoad` + `throw redirect`：

```tsx
// apps/web/src/routes/agent/_panel/index.tsx
export const Route = createFileRoute("/agent/_panel/")({
  beforeLoad: () => { throw redirect({ to: "/agent/home" }); },
});
```

### 2.4 导航

```tsx
import { useNavigate, Link } from "@tanstack/react-router";

const navigate = useNavigate();
void navigate({ to: "/agent/home" });
void navigate({ to: "/agent/chat/$agentId", params: { agentId } });
void navigate({ to: "/agent/workflow/$id/edit", params: { id }, search: { runId } });

<Link to="/agent/home">Home</Link>
```

**禁止** `window.location.href` / `window.location.replace` / `window.location.reload` / `window.history.pushState`。`window.location` 只允许**读取**（`pathname` / `search` / `host` / `protocol` / `origin`），当前合规用法集中在拼 WebSocket URL 与分享链接。

### 2.5 懒加载与路由壳

路由壳只做懒加载与边界，页面实现放 owner 包：

```tsx
// apps/web/src/routes/agent/_panel/models.tsx
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const Page = lazy(() => import("@fenix/model-management/web").then((m) => ({ default: m.AgentModelsPage })));

export const Route = createFileRoute("/agent/_panel/models")({
  component: () => (
    <Suspense fallback={<Spinner variant="panel" />}>
      <Page />
    </Suspense>
  ),
});
```

**加载提示一律用 `Spinner`**：路由 `Suspense` fallback 与页面内整块加载提示都走它，**不要手写圆环类名**。组件在 `@fenix/ui-components/ui/spinner`（深链优先，也可从包根 barrel 取），属 §4.1 的 `ui/*` 基础原语，不是业务组件。

`variant` 决定容器形态，三选一，**不要用 `className` 复刻**：

| `variant` | 容器 | 用在哪 |
|-----------|------|--------|
| `panel` | `flex flex-1`，撑满父级剩余空间 | 路由 `Suspense` fallback、`_panel/*` 内容区、tab 内容区 |
| `screen` | `flex h-screen` | 整屏等待：`__root.tsx` 的会话加载分支、全屏路由壳 |
| `inline`（组件默认） | `inline-flex`，跟随内容流 | 按钮内联、卡片/表单局部；**外边距由调用方 `className` 给** |

`size` 四档：`xs` 14px（按钮内联）· `sm` 24px（小面板、标签页内容区）· `md` 32px（默认，面板级内容区）· `lg` 40px（整屏等待）。环径只在这四档里选，不要在 `className` 里另写 `size-*` / `h-* w-*`。

环色跟随容器文字色（组件兜底 `text-brand`，即默认就是品牌色）：**落在填充按钮之类的有色底上时传 `className="text-current"`** 跟随该处前景色——不要去调用点重写环的 `border-*` 类名。

**`label` 的有无同时决定读屏行为**（三者互斥，按场景选一）：

- **有可见文案** → 传 `label`，组件渲染在环下方并自带 `role="status"`；不要再自己包一层 `<p role="status">`。
- **只有读屏文案** → `label={<span className="sr-only">{t("loading")}</span>}`。
- **纯装饰的转圈**（旁边已有可见文案）→ **不传** `label`；整块对读屏隐藏（`aria-hidden`），念一个空的加载区只是噪音。

```tsx
// 整屏等待（apps/web/src/routes/__root.tsx 的会话加载分支）：有可见文案
// t 来自 useTranslation("common")，"connecting" = 正在连接控制面板…
<Spinner variant="screen" size="lg" label={t("connecting")} />

// 面板 fallback：只有读屏文案
<Spinner variant="panel" label={<span className="sr-only">{t("loading")}</span>} />
```

> **原「三种壳形态都合规」的判断作废**。它把「加载提示长什么样」也划成自由项：三种写法并列合规、示例直接给出那串圆环类名，于是**复制粘贴被写成了规范**——同一段类名散到 21 个路由壳与多张业务页面，尺寸、容器、文案各写各的（`admin/{logs,people,sandbox}.tsx` 只剩一行文字、连指示器都没有；`workflow_.$id.edit.tsx` 把 lucide `Loader` 图标按圆环类名渲染，与环形边框叠成双圈）。加载提示不再有第二个写法。**壳的接线形态只有下面两种**——那是结构选择，与加载提示无关：

| 形态 | 例子 | 说明 |
|------|------|------|
| 标准 | 多数 `_panel/*.tsx` | 单懒组件 + `Suspense` |
| **组合根端口注入** | `_panel/organizations.tsx` | `Promise.all([import("@fenix/identity/web"), import("@fenix/resource-machine/web")])`，把 `machine.registryApi` 作为端口传给页面。跨包装配是壳的职责 |

> **不许有「无 `Suspense` 的极简壳」**（v3.0.3 曾把 `_panel/agents.tsx` 列为合规的第三种形态，已作废）：懒加载挂起时若本壳没有边界，React 会一路冒泡到最近的上层边界——`_panel.tsx` 为壳自身代码块准备的**整屏** `Spinner variant="screen"`。后果是整个 WebShell（侧栏、聊天保活）被卸载重建，用户看到的是「切换进这个页面时整页刷新一次」。页面内的 `loading` 只覆盖**取数**，接不住**代码块加载**，因此「页面自身已处理加载态」不构成省掉边界的理由。边界与壳一一对应，每个 `lazy` 壳都必须自带。

**壳里可以有接线，但不做取数**：tab 状态、创建回调、端口注入属壳；数据获取必须在页面或域模块内完成（`workflow.tsx`、`workflow_.$id.versions.tsx`、`view/$prodViewId.tsx` 是当前较重的壳，改动前先看它们的接线方式）。

**禁止**用相对路径穿透到包内文件（如 `import("../../../pages/agent-panel/pages/X")`）——那是包内实现，须经包 `exports` 进入。

### 2.6 侧栏装配

导航项由**各资源包**声明，Shell 只做装配与渲染。契约 `WebNavigationItem` 定义在 `@fenix/web-runtime/shell/contribution`：

| 字段 | 类型 | 语义 |
|------|------|------|
| `id` | `string` | 唯一标识，**同时是路由目标**（Shell 组装为 `/agent/<id>`）与运行时裁剪键 |
| `groupId` | `string` | 所属分组；分组定义与组间顺序归 Shell |
| `order` | `number` | 组内排序键，**组内必须唯一**；约定 10 步长递增 |
| `labelKey` | `string` | 文案 key，owner 是贡献方本包 |
| `ns` | `string` | `labelKey` 所属命名空间 |
| `icon` | `LucideIcon` | 组件随项贡献 |

一份完整声明（`packages/resources/skill/web/contribution.ts`）：

```ts
import type { WebAppContribution } from "@fenix/web-runtime/shell/contribution";
import { Settings } from "lucide-react";
import { SKILL_NS } from "./i18n/namespace";

export const webContribution: WebAppContribution = {
  navigation: [{ id: "skills", groupId: "config", order: 30, ns: SKILL_NS, labelKey: "nav.skills", icon: Settings }],
};
```

**装配链**（改任一段前先走一遍这条链）：

```
deploy/assembly/ce.json 的 web 列表（9 个包）
  → bun run generate:web-contributions
    → apps/generated/web-contributions.ts
      → apps/web/src/shell/shell-navigation.ts 的 assembleNavGroups()
        → use-shell-navigation.ts（翻译 + 按 hiddenTabs 裁剪）
          → ShellNavigation.tsx → AgentSidebar.tsx
```

- **分组与组间顺序由 Shell 持有**（`shell-navigation.ts` 的 `SHELL_NAV_GROUPS`），资源包只声明自己属于哪一组、组内排第几。
- **装配期直接抛错**：未知 `groupId`、同组内 `order` 重复。不会静默丢项——加分组必须同时改 `SHELL_NAV_GROUPS` 与宿主 `sidebar` 字典的 `navGroup*`。
- **`hiddenTabs`**：来自 `GET /web/sidebar-config`，服务端值源是 `APP_HIDDEN_SIDEBAR_TABS`（逗号分隔，刻意不校验 id 是否已知）。前端**只删项**，不改序、不改分组；取不到时按"无隐藏项"处理。
- **`activeNav` 由 pathname 手算**（`DefaultAppShell.tsx`）：`/agent/home` 取 `home`，chat 路径取 `null`，其余取路径首段。新增页面时若不高亮，先核对这里的推导。

**新增一个控制台页面的完整步骤**：

1. 页面实现落 `packages/<pkg>/web/pages/`，从包根 `web/index.ts` 导出。
2. 包字典补 `nav.<id>`：`packages/<pkg>/web/i18n/locales/{en,zh}/<ns>.json`。
3. 包内 `web/contribution.ts` 的 `navigation` 加一项（`order` 用 10 步长、组内唯一）。
4. 宿主建路由壳 `apps/web/src/routes/agent/_panel/<id>.tsx`（`id` 必须与路由文件同名，否则点进去 404）。
5. `bun run generate:web-contributions`，然后跑门禁。

新增**新包**时还要：`packages/<pkg>/fenix.module.ts` 补 `web.contribution` 说明符 → `package.json` 补 `./web`、`./web/contribution`、`./web/i18n` → `deploy/assembly/ce.json` 的 `web` 数组加模块 id → `bun run generate:module-registry` → `apps/web/src/i18n/index.ts` 登记该包 NS 与 resources（见 §9.2）。

### 2.7 现状偏离

- **`/admin` 有第二张硬编码导航表**（`apps/web/src/routes/admin.tsx` 的 `NAV_ITEMS`），完全绕过 contribution 装配。它是有意保留（观察面板独立于会话体系）还是待收敛，尚无裁定；新增 `/admin` 页面时按现有形态加项。
- **导航 `id` 与路由文件之间没有一致性检查**：`shell-navigation.test.ts` 只断言与迁移前快照一致、装配失败条件与裁剪语义。`id` 打错成不存在的路由，装配照样通过、点击后 404。
- **`router.invalidate()` 全仓零使用**。`CLAUDE.md` 把它列为允许的导航手段，但没有任何真实范例——不要把它当成既有做法照写。
- **`CLAUDE.md` 的「Sidebar 导航项必须提供 `to`」与实现不符**：`ShellNavigation.tsx` 用 `<button onClick={onNavigate(item.id)}>`，路由目标由 `id` 拼装，没有 `to`。以本文档为准，`CLAUDE.md` 待同步。
- **三个页面有路由但无导航项**（`_panel/dashboard.tsx`、`channels.tsx`、`views.tsx`），只能靠输入 URL 到达。是刻意保留深链入口还是迁移遗漏，无记录。
- **`DefaultAppShell.tsx` 用 `navigate({ to: \`/agent/${pageId}\` as never })`** 绕过 TanStack 类型检查，是反面样例，不要照抄。
- **按钮 / 行内的「图标转圈」尚未收敛**：`Spinner` 管的是**独立成块的环形指示**，而 `Loader2` / `LoaderCircle` / `Loader` + `animate-spin` 这类**图标转圈**（约 25 处，如 `ui-components/web/chat/shell/ChatHeader.tsx`、`ui-components/web/chat/timeline/SubAgentPanel.tsx`、`resources/agent-config/web/components/agent-panel/MountSiteDialog.tsx`）是另一种视觉形态，两者是否合并尚无裁定；存量尺寸（`h-4 w-4` / `size-3.5` / `h-[18px] w-[18px]`）与间距（`mr-2`）也各写各的。当前口径：**按钮内联**的加载提示优先用 `Spinner size="xs"`（环，落在填充底上传 `className="text-current"` 跟随前景色）；若沿用图标转圈，在 `Button` 内不要再写 `h-* w-*`——`Button` 的 `[&_svg:not([class*='size-'])]:size-4` 会统一成 16px，写了反而与其它按钮图标不一致。收敛完成前不要新增第二套写法。

## 3. 状态管理

使用 **React Context + `useState`/`useCallback`**，不引入 Zustand / Jotai / Redux / TanStack Query（当前零依赖，`bun.lock` 里出现的同类包均为传递依赖）。数据获取统一走 ahooks `useRequest`（见 §3.4）。

### 3.1 Provider 装配

装配在 `apps/web/src/routes/__root.tsx`，**是四分支条件树，不是一条线形链**：

| 分支 | 渲染 |
|------|------|
| 会话加载中 | `<ThemeProvider>` + spinner |
| 未登录、非 `/login` 非 `/admin` | `null`（靠 §2.3 的 effect 跳转） |
| 未登录、`/login` 或 `/admin` | `<ThemeProvider><Outlet /></ThemeProvider>`——**无 OrgProvider、无 Toaster** |
| 已登录 | `<ThemeProvider><OrgProvider><Outlet /><Toaster richColors closeButton position="top-right" /></OrgProvider></ThemeProvider>` |

两个后果必须记住：**在 `/login` 与 `/admin` 下调用 `useOrgSession()` 会抛错**；这两条路径上 `toast` 无处落地。

**不是 Provider 的两个全局能力**（不要给它们补 Provider）：

- i18n 走 `initReactI18next` 单例（`apps/web/src/i18n/index.ts`），无 `I18nextProvider`。
- 主题走 `@fenix/ui-components/lib/theme` 的 `ThemeProvider`。

### 3.2 主题（全局强制亮色）

**本程序只有亮色一种外观**：不读 `localStorage`、不监听 `prefers-color-scheme`、也没有任何主题切换入口。系统/浏览器处于深色偏好时同样渲染亮色。

实现只有一份：`packages/ui-components/web/lib/theme.tsx`，导出 `ThemeProvider` / `useTheme()`；`useTheme` 在 Provider 外抛错，不静默回落。Provider 现在的职责是给需要布尔判定的消费方（canvas / SVG 渲染器，如 `memory/hindsight/components/`）提供恒为 `"light"` 的 `resolvedTheme`，并在挂载时清掉 `documentElement` 上残留的 `dark` 类（兜「上一版本写过」与「扩展脚本塞类」两类外部来源）。它**不再有参数**，宿主 `apps/web/src/routes/__root.tsx` 的三处挂载点与 demo 都直接写 `<ThemeProvider>`。

深色要能生效必须同时满足三件事，而第一件在当前没有任何生产者：

1. 某段代码给 `<html>` 或某个祖先加上 `.dark` 类——当前仓库无任何此类代码；
2. `apps/web/src/index.css` 的 `.dark` token 块随之生效（该块及其派生规则，如 `shell/agent-panel.css` 的 `:root.dark`，都保留着；在无法触发的前提下属死代码而非风险）；
3. `color-scheme` 被固定为 `light`——由 `apps/web/index.html` 的 `<meta name="color-scheme" content="light">` 与 `index.css` 的 `:root { color-scheme: light }` 两处共同保证：后者覆盖样式表生效之后的常规取值，前者覆盖「样式表生效之前」的窗口（缺了它，系统深色偏好下首帧会按深色画布绘制，即首屏闪深色）。

**不要在任何调用点补第二份主题实现。**

### 3.3 组织与会话上下文

**契约与实现分离**：

- **契约**在 `packages/web-runtime/web/contexts/org-session.tsx`，只声明资源包真正需要的粒度：`organizationId` / `userId` / `isOwner` / `pending`。全字段可空可假，**消费方必须自己处理未就绪态**。
- **实现**方是身份包的 `OrgProvider`（`@fenix/identity/web`）——取数、切换与请求头注入属于身份域，不下沉到 `web-runtime`。

契约放在中性的 `web-runtime` 的原因：资源包需要组织上下文判断资源归属，但依赖矩阵禁止 `resources` 依赖具体平台实现。因此 `OrgSessionContext` **只能有一个 `createContext` 站点**——出现第二份会让资源包永远读到 `null`，而现象只是"权限判定全体失效"，很难从界面反推。

Context 必须用守卫 hook 消灭 `undefined` 判断，且**不静默回落默认值**：

```tsx
export function useOrgSession(): OrgSession {
  const ctx = useContext(OrgSessionContext);
  if (!ctx) throw new Error("useOrgSession must be used within OrgSessionProvider（由身份的 OrgProvider 挂载）");
  return ctx;
}
```

**组织身份只有两种合法读法**：

| 读法 | 允许的消费方 |
|------|-------------|
| `useOrgSession()` | **资源包唯一允许**的读法（返回契约投影的 4 个字段） |
| `useOrg()`（身份包的富上下文） | 仅宿主 shell 与身份包自身；资源包不得依赖平台实现 |

**禁止绕过上下文读取组织身份**（`localStorage.getItem("active_org_id")`），也禁止自行拼 `?active_org_id=`。这类写法会制造"UI 显示 A、请求操作 B"的 split-brain。当前偏离见 §3.6。

**请求头注入由身份域持有**：`OrgContext.tsx` 通过 `installFetchInterceptor()` monkey-patch `window.fetch`，每次请求现场读取 `localStorage` 注入 `X-Active-Org-Id`；服务端解析优先级见 `CLAUDE.md`。域模块**不得**自己读组织 id 拼 URL 或头——那会绕过这套机制。

**切换组织的唯一入口**是身份包 `OrgContext.tsx` 的 `switchOrg`（`packages/platform/identity/web/contexts/OrgContext.tsx`）；宿主 `AgentSidebar` 只是调用方（关菜单后 `await switchOrg(orgId)`）。它的序列是：快照当前值 → 乐观更新 state → 写 `localStorage` → `await orgApi.setActive()` → `navigate({ to: "/agent/home", replace: true })`；失败时回滚 `localStorage` 与 state 并 `toast.error`。注意客户端可见快照在服务端确认前已变更，一致性依赖切换后的 replace 导航重建组件。

### 3.4 数据获取

统一用 ahooks **`useRequest`**；禁止手写 `useCallback` + `useEffect` + `setState` 组合管理数据获取。当前全仓 `from "ahooks"` 只导入 `useRequest` 一个 hook。

```tsx
import { useRequest } from "ahooks";
import { taskV2Api } from "@fenix/resource-task/web";
import { unwrap } from "@fenix/web-runtime/api/request";

// 查询：自动管理 loading / error / data 三态
const { data, loading, error, refresh } = useRequest(() => unwrap(taskV2Api.list()));

// 变更：manual 模式，手动触发
const { run: createTask, loading: creating } = useRequest(
  async (body: TaskV2CreateBody) => unwrap(taskV2Api.create(body)),
  {
    manual: true,
    onSuccess: () => {
      refresh();
      toast.success(t("toast.saved"));
    },
    onError: (err) => {
      console.error("创建任务失败", err);
      toast.error(err.message);
    },
  },
);
```

> **必须 `unwrap()` 或显式判断 `success`**：域模块返回 `ApiResponse`，`request()` 对 HTTP / 业务失败**返回 `{ success: false }` 而不 throw**，而 `useRequest` 的 `error` / `onError` 只理解 rejected Promise——直接 `await` 会把 4xx/5xx 当成成功，继续推进 loading/empty 状态。详见 §5.2。

**真实使用的配置项**（按出现频次；只列有真实范例的）：

| 配置 | 用途 | 范例 |
|------|------|------|
| `refreshDeps` | 依赖变化自动重查 | `WorkflowVersions.tsx`（`[workflowId]`）、`AgentTasksPage.tsx`（`[page, debouncedKeyword, typeFilter]`） |
| `ready` | 条件请求（前置数据未就绪时不发） | `FileTreeTab.tsx`、`ChatArea.tsx`、`MountSiteDialog.tsx` |
| `manual` | mutation / 手动触发 | `AgentTasksPage.tsx` 的 toggle、`WorkflowList.tsx` 的创建 |
| `pollingInterval` | 轮询 | `use-agent-sidebar-tree.ts`（15s）、`AdminObserverPage.tsx` |
| `loadingDelay` | 抑制骨架闪烁 | `use-agent-sidebar-tree.ts`（300ms） |
| `onSuccess` / `onError` | 反馈与刷新 | 普遍 |

**租户作用域轮询必须把组织 id 纳入 `refreshDeps` 并配 `ready`**（样板：`use-agent-sidebar-tree.ts` 的 `pollingInterval: 15_000, refreshDeps: [orgId], ready: !!orgId`）。不要用共享的 `intervalRef` 手写 `setInterval` 跨资源复用轮询。

**跨组件刷新**用 `@fenix/web-runtime/lib/config-events` 的事件总线（`dispatchConfigChange` / `useConfigChangeListener`）——这是当前主力机制，例如侧栏在配置变更后刷新。`useRequest` 的 `cacheKey` 全仓 1 处（`use-shell-navigation.ts` 的 `"sidebar-config"`）、`cancel()` 1 个文件（`AdminModelGatewayPage.tsx`，用于组件卸载时取消在途请求），`cache.mutate` / `debounceWait` / `retryCount` **当前没有任何使用范例**；需要时先确认 ahooks 行为并在 code review 中说明，不要凭文档想象它的语义。

**取消**：需要主动取消时用 `request()` 的 `signal` 选项传 `AbortSignal`（产品侧现有用法集中在文件读写、上传与文件树）。**不要依赖 `useRequest` 替你取消**——它的并发语义随版本变化，长轮询与"后发请求覆盖先发结果"的场景必须显式持有信号并在 cleanup 里 abort。

**Loading / Empty / Error 三态**：

```tsx
if (loading) return <Skeleton className="h-32 w-full" />;
if (error) {
  return (
    <EmptyState
      icon={<TriangleAlert />}
      title={t("loadState.failed", { message: error.message })}
      tone="danger"
      role="alert"
      action={{ label: t("common.retry"), onClick: refresh }}
    />
  );
}
if (!data?.length) return <EmptyState icon={<FolderOpen />} title={t("empty.title")} />;
```

**失败不得映射成 empty 或成功**——这是最容易通过 review 的静默缺陷。

### 3.5 Hooks 约定

- **落点跟随归属**：宿主 `apps/web/src/hooks/` 只放无域归属的 hook（当前仅 `use-task-views`，它是 Y.Doc 投影、不发请求）；有明确归属的 hook 放在它服务的目录旁（`shell/use-*.ts`、`pages/agent-panel/use-*.ts`、`components/agent-panel/use-*.ts`）。包内 hook 放 `<pkg>/web/hooks/`。
- **命名**：文件名 kebab-case 的 `use-<domain>-<noun>.ts`，导出 camelCase。
- **三层分工**：纯模型（`*-model.ts`，纯函数）↔ 编排 hook（数据与副作用）↔ 渲染组件（JSX）。样板是 `shell/agent-sidebar-tree-model.ts` + `use-agent-sidebar-tree.ts` + `AgentSidebarTree.tsx`；拆页面时优先按这三层切，而不是按行数切。
- **`useRef` 稳定引用**：事件订阅类 hook 用 `useRef` 持有稳定回调，避免 `useEffect` 反复订阅/取消。
- **表单用 react-hook-form + zod**，不手写 `useState` 管理表单状态。命名：`formSchema` / `FormValues` / `form`。
- **Chat 状态 hook 有归属**：`useChatState` / `useSessionState` 在 `packages/agent-runtime/web/hooks/`；`useChatPageVisible` 与 `ChatPageVisibleContext` 在 `packages/web-runtime/web/hooks/use-page-visible.ts`（该文件**没有** `usePageVisible` 导出）。宿主不要在 `src/hooks/` 复制包内实现。

### 3.6 现状偏离

- **组织身份被绕过读取的 2 处生产点**：`apps/web/src/components/agent-panel/use-file-tree-events.ts`（拼 `/web/file-events` 的 WS query）、`packages/agent-runtime/web/yjs/yjs-ws.ts`（拼 `/acp/yjs/*` 的 `active_org_id`）。两处都直接 `localStorage.getItem("active_org_id")`。WS 无法带自定义头，收口需要契约化的组织参数传递方式，属已知缺口。
- ~~**主题强制浅色 + 存在第二份主题实现**~~ 已消解（2026-09-23）：全站改为全局强制亮色，宿主与包内两份实现合一，见 §3.2。
- ~~**手写取数（`useCallback` + `useEffect` + `useState`）的现行违规**~~ **批次二已消解**（2026-09-23）：批次一（`packages/resources/memory/web/pages/hindsight/**`，实测 9 处）见 v3.0.13；批次二收掉规范原记的**最后两处**——`packages/resources/workflow/web/pages/workflow/components/` 的 3 处（`TriggerPanel` / `VersionIndicator` / `VersionPanel`，三态改由 `error` / `data` / `loading` 派生、重试复用 `refresh`、条件取数用 `ready: !!workflowId`，失败补 `role="alert"` 失败块），以及 `WorkflowList.tsx` 的手写 `setInterval(pollList, 15_000)`（改 `pollingInterval: 15_000` + `refreshDeps: [organizationId]` + `ready: !!organizationId`）；`packages/resources/knowledge/web/pages/agent-panel/KnowledgeGraphPanel.tsx` 的手写 `requestId` 令牌删除，改用 `useRequest` + `request()` 的 `signal`（域模块 `kbApi.getGraph` 同批补 `signal` 透传）。**同子树复查后仍残留的同类形态（5 处，2026-09-23 批次三拆分后重新清点）**：批次三把 workflow 编辑器与运行域按「状态归属 / 传输适配 / 纯模型」拆开，原记的 6 处里 **1 处已收口**——custom 工具列表移到 `hooks/use-workflow-custom-tools.ts`，它的 `customTools` 全仓只有那一个写入点，直接换成 `useRequest`（+ `onError` 保留原日志）不会产生第二个所有者；**其余 5 处经拆分后仍不成立，保持手写**：草稿加载在 `hooks/use-workflow-draft.ts`（`loadDraft` / `handlePreviewVersion` / `handleBackToDraft` 三个入口都写同一份 `wfData`，换 `useRequest` 会让请求内部再持一份，除非引入本仓零先例的 `mutate`）、运行回放在 `hooks/useWorkflowRun.ts`、轮询与待审批与节点输出在 `hooks/use-workflow-run-transport.ts`——这四处读写的是 `runSnapshot` / `runEvents` / `runApprovals` / `selectedNodeOutput`，它们由 `WorkflowEditor` 顶层持有、`RunStatusPanel` 也直接写（三处共用 `resetRunView` 整组复位），换 `useRequest` 同样造出第二个所有者；轮询另有两条 `useRequest` 表达不了/不该依赖的语义：退出运行视图与重跑时要**同步**停掉定时器（不能让上一个 run 的结果回写），以及 §3.4 明确要求的「不要依赖 `useRequest` 替你取消」。`WorkflowEditor.tsx` 的其余 effect 属 DOM 测量、事件登记与渲染同步，不属违规；拆分后它们分布在 `hooks/use-workflow-editor-events.ts`（SSE 订阅、提示、调试快捷键）与编辑器壳（工作流切换复位、`meta.params` 同步）。
- **组织切换不是原子转换**：`localStorage` 先于服务端确认写入（见 §3.3）。失败回滚已实现，但切换瞬间存在"本地快照已变、服务端未确认"的窗口。
- **`useRequest` 的多数配置项缺少范例**：`cacheKey` 全仓 1 处（`use-shell-navigation.ts` 的 `"sidebar-config"`）、`cancel()` 1 个文件（`AdminModelGatewayPage.tsx`，在组件卸载路径上取消在途请求）；`cache.mutate` / `debounceWait` / `retryCount` 零使用。需要时先确认 ahooks 语义并在 code review 中说明，不要凭文档想象。

## 4. 组件规范

### 4.1 组件归属

**已有组件禁止重复开发**。`packages/ui-components` 是唯一来源：

- 基础 UI 原语：`@fenix/ui-components/ui/<name>`（含 `chat/**` 下的聊天基元，均逐文件子路径）。
- 通用业务组件：`@fenix/ui-components/config/<name>`。
- 无渲染工具：`@fenix/ui-components/lib/<name>`；不可归入 `ui/` 或 `config/` 的共享件：`components/<name>`。
- 该包**有根出口**（`@fenix/ui-components`，161 行 barrel），也存在 158 条 `exports` 子路径（口径：`package.json` 的 `exports` 键数，含根出口 `.` 与样式表 `./styles.css` 两条非组件条目）。**按需深链优先**；根出口适合一次取多个组件的场景。新增/删除组件时必须同批改 `web/index.ts` 与 `package.json` 的 `exports`——两者的不一致会让"深链可用、整包导入不可用"，由 `web/__tests__/barrel-exports.test.ts` 的显式名单守护。

**归属由消费者集合决定**：出现第二个包消费时就下沉到 `ui-components`，而不是在消费方各留一份；只有一个消费者时留在原处，不做推测性抽象。

`config/` 下当前 9 个组件的真实契约：

| 组件 | 用途 | 关键 props |
|------|------|-----------|
| `FormDialog` | 通用表单对话框 | `open` / `onOpenChange` / `title` / `children` / `formConfig?` / `onSubmit?` / `submitLabel?` / `cancelLabel?` / `loading?` / `disabled?` / `hideSubmit?` / `width?`（默认 `sm:max-w-lg`） |
| `ConfirmDialog` | 危险操作确认 | `open` / `onOpenChange` / **`title`（必填）** / **`description`（必填）** / `onConfirm` / `variant?: "default" \| "destructive"` / `confirmLabel?` / `cancelLabel?` / `loading?` |
| `EmptyState` | 内联状态块：空态 / 无匹配 / 读取失败 / 无权限共用一个组件 | `title` / `description?` / `icon?` / `action?: { label, onClick, icon?, disabled? }` / `tone?: "neutral" \| "danger"` / 其余 `<div>` 属性透传（`role`、`className` 等） |
| `StatusBadge` | 状态徽标 | `status` / `label?`（覆盖 i18n `statusBadge.<status>`）/ `tone?: "success" \| "info" \| "warning" \| "danger" \| "neutral"` / `toneMap?`（业务状态词表 → 色调）/ `indicator?: "none" \| "dot" \| "pulse"` |
| `ScopeFilterBar` | 配置型目录页的「搜索框 + 作用域过滤条」 | `query` / `onQueryChange` / `placeholder` / `searchLabel` / `scopes: { value, label, count? }[]` / `scope` / `onScopeChange` / `scopeGroupLabel` / 其余 `<div>` 属性透传 |
| `DataTable` | TanStack Table 封装（含搜索/选择/分页/展开） | `columns` / `data` / `searchable` / `selectable` / `actions` / `expandableRow` / `rowKey` / `pageSize` |
| `BatchActionBar` | 批量操作条 | 见包内实现 |
| `AdminKeyGate` | 系统 Master Key 输入门（纯展示，受控） | `unlocked` / `onUnlock(key)` / **`title`（必填）** / **`description`（必填）** / **`inputPlaceholder`（必填）** / **`submitLabel`（必填）** / `error?: string \| null` / `children`（解锁后渲染）；不取数、不 import `web-runtime`，状态机见 `@fenix/web-runtime/hooks/use-admin-key-gate` |
| `LabeledField` | 表单字段名与控件的关联包装 | `label` / `hint?` / `htmlFor?`（不传＝隐式关联：`<label>` 包裹单个可标记控件；传＝显式关联，children 与独立 `<label htmlFor>` 同层）/ 其余 `<div>` 属性透传 |

> `StatusBadge` 只收语义（色调），不收色值：业务状态词表经 `toneMap` 注入，配色（含 dark 变体）留在包内。
> 需要在包外判定色调时用 `getStatusTone(status, toneMap)`，不要复刻配色类。
> `EmptyState` 同样只收语义：`tone` 默认 `neutral`（确实没有数据、筛选后没有匹配），`danger` 用于读取失败、无权限；持久错误再补 `role="alert"`。图标不传尺寸类时沿用 lucide 默认的 24px（组件只负责居中与配色），颜色一律不要手写——配色（含 dark 变体）归 `tone` 管。
> 它**不自带 Card 外壳**：容器（卡片、边框、外边距）由调用方给——面板内联直接用，需要卡片形态时把 `<EmptyState>` 放进调用方的 `Card` / `CardContent`。默认内边距是 `py-10`，紧一点的场景用 `className` 覆盖（如 `className="py-8"`）。
> `ScopeFilterBar` **不接 i18n**：文案（`placeholder` / `searchLabel` / `scopeGroupLabel` 与每个 `label`）全由 props 传入，key 与语言资源只留在调用方——库内组件自带命名空间会把两边的 key 绑死，同一处文案在两侧各留一份。它也不认识业务作用域（不知道「组织 / 公开」是什么），只把受控的 `query` / `scope` 渲染成统一形态。
> **空态 / 失败 / 无权限刻意共用一个骨架**（2026-09-22 冻结）：不要新建第二个「空态组件」或「加载失败组件」——三套语义的结构相同，差别只在措辞与「要不要给重试」。判据：**无权限不给重试**（401/403 重试只会重复被拒，该做的是重新登录或找管理员），**失败给重试**。

**2026-09-22 起去重批次新下沉共享库的原语**（逐个实测存在，下列名字即 `exports` 子路径或具名导出）：

- `ui/status-dot`（`StatusDot` / `StatusDotTone`）：状态圆点收敛为唯一原语，页面级圆点 CSS 随之删除。
- `ui/spinner`（`Spinner`）：独立成块的加载圆环（§2.5），不再手写圆环类名。
- `components/ClosableTabPill`（`ClosableTabPill`）：可关闭的页签药丸。
- `components/agent-catalog-index`（`AgentCatalogIndex` / `AgentCatalogIndexNav` / `AgentCatalogIndexItem` / `AgentCatalogIndexIcon` / `AgentCatalogIndexCopy` / `AgentCatalogIndexMeta` / `AgentCatalogIndexArrow`）：主从面板左侧目录栏的共享构件集——容器 + 目录 + 行 + 图标 / 文案 / 尾注 / 箭头四个槽位件；技能库 / MCP / 模型库 / 知识库 / 组织管理五页改用。**默认值全在这一份组件里**（`f73f9265` 起）：容器内边距与底色、头部几何、行距、行高、圆角、三态配色、图标盒、字号、尾注与箭头都由 `agent-catalog-index.css` 给，五页渲染出同一组计算值，**页面覆盖归零**——各页此前为目录写的 30 余条规则（MCP 12 条、模型库 10 条、技能库 1 条、知识库的目录骨架与两条头部覆盖、组织页 3 条）已同批删除。**页面仍可覆盖，但只保留页面独有的语义**：知识库行尾删除按钮的外壳与不可用态（`shell` + `trailing`）、组织页行首图标的角色三态色（落在工具类上——共享图标盒刻意不声明 `color`），以及两处布局行为——知识库 ≤760px 隐藏目录、组织页 ≤900px 目录横置（`stripOnNarrow`）。**为什么不再留各页刻度**：「共享结构、字号 / 内边距 / 行高 / 圆角 / 选中配色留各页刻度」只统一了结构，同一组件在两页之间观感不成一套（12px 与 9.75px 两套刻度并存）；而共享 CSS 未分层，页面想改就得靠更高特异性去抢（`data-slot` 钩子正是为此存在的），偏差只能靠逐页纠偏收拾——本批顺带修掉的条目标题字重、三态配色落点、三页目录 hover 不可见、模型库尾注列缺规则四处即属此类。目录现在只有一个该改的地方：**改共享 CSS，不要再在页面里长出一份**。
- `lib/clipboard`（`copyTextToClipboard`）与 `lib/format`（`formatDate` / `formatDateTime` / `formatClockTime`）：无渲染的跨包工具，复制与时间展示口径不再各包一份。
- `chat/view/PublicErrorCard`、`chat/panels/chat-interaction-region`（`ChatInteractionRegion` / `ChatInteractionStack`）、`chat/timeline/tool-json-block`（`ToolJsonBlock`）：聊天域的错误卡、交互区与工具 JSON 块骨架。

> `components/agent-master-detail-workspace`（主从壳）**不在上列**：它早于去重批次（2026-09-20 的 `e8c73280` 前置落地）即已入库，不是该批次新下沉的原语。本批动的是它的消费者——记忆页从已删除的 `components/WorkbenchPanel` 切到它；主从壳现有六个消费者（技能库 / MCP / 模型库 / 知识库 / 组织管理 + 记忆页），前五个的目录栏由上面的 `agent-catalog-index` 供给。

### 4.2 Dialog 状态管理

三个关联 `useState` 控制新增/编辑/删除：

```tsx
const [dialogOpen, setDialogOpen] = useState(false);
const [editingItem, setEditingItem] = useState<Item | null>(null);  // null = 创建
const [confirmOpen, setConfirmOpen] = useState(false);
const [deleteTarget, setDeleteTarget] = useState<Item | null>(null);
```

- **创建**：清空编辑状态 → `setDialogOpen(true)`
- **编辑**：填充表单 → `setDialogOpen(true)`
- **`onOpenChange`** 回调中清理状态：`if (!open) resetState()`

### 4.3 表单提交

使用 **react-hook-form + zod**（`zod/v4`）配合 `FormDialog`，禁止手动 `useState` + 手写校验。

**`FormDialog` 在内部创建 `useForm`**，页面不持有 form 实例；把 schema 与提交函数经 `formConfig` 传入，子组件用 `useFormContext()` 绑定字段：

```tsx
// 页面：packages/resources/task/web/pages/agent-panel/pages/AgentTasksPage.tsx
<FormDialog
  key={`${editingTask?.id ?? "create"}-${formResetKey}`}   // key 变化 = 强制重挂载，重置内部 useForm
  open={dialogOpen}
  onOpenChange={setDialogOpen}
  title={editingTask ? t("dialog.editTitle", { name: editingTask.name }) : t("dialog.createTitle")}
  width="sm:max-w-2xl"
  formConfig={formConfig}
  loading={saving}
>
  <TaskForm agents={agents} isEditing={!!editingTask} initialType={editingTask?.type ?? "http"} />
</FormDialog>

// 表单字段：packages/resources/task/web/pages/agent-panel/components/TaskForm.tsx
export function TaskForm({ agents, isEditing, initialType = "http" }: TaskFormProps) {
  const { register, formState: { errors } } = useFormContext<TaskFormValues>();
  // ... 字段直接 register / Controller，错误从 formState.errors 取
}
```

规则：

- **重置表单靠 `key`**，不要在 `onOpenChange` 里手工 `reset()`——内部 `useForm` 的生命周期由 `key` 控制。
- `formConfig.onFormSubmit` 的入参类型是 `Record<string, unknown>`；调用方按域类型收窄后再用，不要在包内引入域类型。
- **`onSubmit` 与 `formConfig` 互斥**：传了 `formConfig` 时 `onSubmit` 被忽略；不传 `formConfig` 的 `onSubmit` 只做 `preventDefault` + 回调，**不做校验**——无校验需求才用它。
- `schema` / `defaultValues` / `onFormSubmit` 三者要同时在 `formConfig` 里给出。

### 4.4 组件声明与类型

- **业务页面与业务组件统一用 `function` 声明**：`export function AgentSkillsPage() {...}`。这条与 `ui-components` 的既有形态一致，不需要为它开例外。
- **例外只针对 `chat/primitives/*`**：该目录沿用上游写法使用箭头函数组件（`ui/*` 仍然是 `function` 声明）。不要把这个例外扩散到业务代码。
- props 类型用顶部 `interface` 或内联类型，不用匿名对象字面量散落多处。
- **禁止 `as any`**。手写生产代码当前只有 `lib/clipboard-polyfill.ts`、`lib/random-uuid-polyfill.ts` 两处（浏览器 API 垫片）与 `FormDialog.tsx` 一处带 `biome-ignore` + 原因的行级例外。生成产物（`routeTree.gen.ts`，36 处）与测试不计入——生成文件另有豁免口径（见 §4.7）。第三方类型缺陷用最小范围收窄，不要扩散。
- **`React.memo` 的 comparator 必须与调用方 prop 稳定性一致**：`ChatView` / `EntryRenderer` / `MessageResponse` 有显式 comparator，改动它们的 props 时同步更新 comparator 与相关渲染测试，否则会出现"消息不更新"或"整表重渲染"两类反向故障（见 §8.5）。

### 4.5 类型定义

| 场景 | 位置 |
|------|------|
| 只在该页面使用的类型 | 页面文件内联（组件函数上方） |
| 资源域类型 | 跟随域模块定义在 owner 包的 `web/api/<domain>.ts`，经包 `exports` 按消费点导出 |
| 跨资源包共享的域类型 | `@fenix/web-runtime/types/config`（`AgentInfo` / `ProviderInfo` / `SkillInfo` / `ModelEntry` 等，6 个资源包共用） |
| 只服务宿主页面、无资源包归属的类型 | `apps/web/src/types/` |

- **边界转换**：协议 DTO、领域对象与视图模型在边界处独立转换，不做跨层共享可变结构。前端类型必须对应后端真实返回，**禁止声明后端不存在的"幻影字段"**。
- 域内类型优先跟随域模块；只有当**第二个包**也需要它时才上提到 `types/config`——上提后它就是跨包契约，改动需要同步搜全部消费方。
- 契约漂移没有编译期保护：`request<T>()` 的泛型是断言而非校验。改后端响应时必须同批改前端类型，别指望类型检查发现。

### 4.6 文件结构

import 顺序由 Biome 的 import-sort 统一（`precheck` 会跑），实际形态是**字母序分组**，包内相对导入放最后。人工组织时按此语义分组：

```tsx
// 1. React / 框架
import { lazy, Suspense, useCallback, useEffect, useState } from "react";

// 2. 路由
import { Link, useNavigate } from "@tanstack/react-router";

// 3. 第三方库（含 @fenix/ui-components 的基础 UI）
import { Bot, Plus, Search, Trash2 } from "lucide-react";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";

// 4. 跨包能力（经各包 exports，不用别名）
import { taskV2Api } from "@fenix/resource-task/web";
import { TASKS_V2_NS } from "@fenix/resource-task/web/i18n";
import { unwrap } from "@fenix/web-runtime/api/request";

// 5. 本包 / 本目录相对导入
import { TaskForm } from "./components/TaskForm";

// 6. 类型（按需，用 import type）
import type { TaskV2Info } from "@fenix/resource-task/web";

export function AgentTasksPage() {
  const { t } = useTranslation(TASKS_V2_NS);
}
```

### 4.7 文件规模与模块拆分

- **单个文件不得超过 500 行**。接近上限时应重构模块边界，而不是继续追加；生成文件豁免（如 `routeTree.gen.ts`）。
- 拆分按**职责**切，不按行数切：一个文件对应一个稳定职责与对外形状。"页面 + 数据编排 + 传输适配"挤在一个文件里是超限的常见成因；成功样本见 `packages/resources/task/web/pages/agent-panel/`——`TasksPanel.tsx`（壳）+ `pages/AgentTasksPage.tsx`（页面）+ `pages/agent-tasks-registry.tsx`（列与动作登记）+ `pages/agent-task-runtime-board.tsx`（运行态看板）+ `pages/agent-tasks-utils.ts`（纯工具）+ `components/`（表单与对话框）。
- 收益判据是耦合而非行数：拆出的模块若仍需反向读取原文件内部状态，说明缝切错了——应先抽状态归属，再拆渲染。
- 上传/预览/文件树等重型交互按 §3.5 的三层拆分（纯模型 / 编排 hook / 渲染组件）。

### 4.8 现状偏离

- **5 个生产文件超 500 行**（2026-09-23 §4.8 批次三收口后实测，从大到小）：`model-management/web/pages/admin/AdminModelGatewayPage.tsx` 1251、`memory/hindsight/components/Constellation.tsx` 978、`memory/hindsight/components/DataView.tsx` 955、`memory/hindsight/components/Graph2d.tsx` 713、`agent-config/web/pages/agent-panel/pages/AgentHomePage.tsx` 675。400–499 行区间另有 29 个（口径：`apps/web/src` + `packages/**/web/**`，排除测试、生成文件与服务端路径，行数是文件总行数；统计命令：`(find apps/web/src -name '*.ts' -o -name '*.tsx' | grep -v __tests__ | grep -v routeTree.gen; find packages -path '*/web/*' \( -name '*.ts' -o -name '*.tsx' \) | grep -v __tests__ | grep -v '/src/server/' | grep -v '/src/routes/web/') | xargs wc -l | awk '$1>500'`）。两批已消掉的超限文件：批次一（v3.0.17）是 500–560 行带那 10 个——9 个按职责拆分、1 个（`workflow/components/NodeConfigPanel.tsx`，557 行）经核实全仓零引用且文件头已标 `@deprecated`，按 CLAUDE.md 原则 10 直接删除（不把死代码拆成多个死模块）；批次二（v3.0.18）是 knowledge 包残留的 2 个——`AgentKnowledgeBasesPage.tsx`（1243 → 壳 301 + 两个域 hook + 详情视图 + 三个弹窗族 + 错误码映射）、`ResourcePreviewContent.tsx`（570 → 纯模型 / 取数 hook / 渲染壳 / 占位件 / 表格预览，最大 177）；批次三（v3.0.19）是 workflow 包的 3 个——`NodeConfigCard.tsx`（1180 → 壳 233 + 字段原语 / 五个按类型的分区 / 纯模型 / 下游引用确认，最大 287）、`WorkflowEditor.tsx`（1077 → 壳 481 + 画布与其浮层 / 右下角动作组 / 浮层族 / 六个 hook，最大 248）、`hooks/useWorkflowRun.ts`（569 → 编排 388 + 传输层 139 + 生命周期命令 208 + 画布运行标记纯模型 119）。**剩下的 5 个留给后续批次**，其中 `memory/hindsight` 占 3 个（该包的两套图谱属已裁定的刻意分叉，拆分只动外围，见本节末条）。`WorkflowEditor.tsx` 与 `useWorkflowRun.ts` 的取数 effect 已按「先抽状态归属、再拆传输适配」拆开，但**仍保留手写**（判断与理由见 §3.6 末条）。
- **2 个 config 组件生产零消费**：`DataTable` / `BatchActionBar` 目前只有包内测试与 demo 引用。`EmptyState` 早已不是零消费——2026-09-22 重写为内联状态块后，它已是本仓页面状态块的统一实现：实测 `grep -rln 'from "@fenix/ui-components/config/EmptyState"' packages apps` 命中 **37 个生产文件**（workflow 的 `WorkflowList.tsx` / `WorkflowRuns.tsx` / `WorkflowVersions.tsx`，observer 的 `AdminObserverPage.tsx`（此前的同名本地实现已删除），task 的 `TasksPanel.tsx` / `components/ExecutionLogTable.tsx`，agent-config 的 `pages/agent-sites-catalog.tsx`（空态与失败态，`542772c7`），以及 knowledge / memory / mcp / model-management / prod-view / channel / skill / identity 各包的页面与状态块；原记的 `task/components/TaskLogDialog.tsx` 已不直接消费它，日志弹窗经 `ExecutionLogTable` 间接复用）。收口前先确认包内 API 是否够用（`StatusBadge` 已在 2026-09 泛化后接入 task / workflow / prod-view 三处生产消费方，不再是零消费）。
- **`task` 包的域类型未从包出口导出**：`TaskV2Info` 的权威定义在服务端 zod schema，web 侧页面用相对路径 `from "../../../api/tasks-v2"` 取，未过 `@fenix/resource-task/web`。与 §4.5 的"经包 exports 导出"不一致，新增类型不要照抄这种取法。
- **刻意分叉（已裁定，不要以"去重"为由重开）**：`workflow/pages/workflow/components/` 的三种节点配置容器 `NodeConfigPopover`（浮层）/ `NodeConfigSheet`（侧栏）/ `NodeConfigCard`（卡片）服务不同交互场景——props 解构块虽 17 行逐字相同，合并会把差异藏进参数。2026-09-22 的两次收敛（`524127a7` / `6095073b`）都按此口径留手写并登记。
- **刻意分叉（已裁定）：`memory/hindsight/components/` 的两套图谱**——`Graph2d.tsx`（Cytoscape.js）与 `Constellation.tsx`（自绘 canvas）的图形逻辑不做归一，只收敛它们外围的重复（可视化高度读取、暗色判定、加载块）。两者的渲染模型不同，抽公共层只会得到一层薄转发。
- **刻意不进库：红描边危险按钮**——`sandbox/web/src/pages/admin/components/RowDeleteButton.tsx` 的 `size="sm"` + `variant="outline"` + 红描边类串全仓只有本包在用（同包另有一处 `InstanceDetailDialog` 的 clearOverride 配方相同）；其余包的红按钮要么是 `ghost` + `text-destructive`、要么是无描边实心 `destructive`，换上红描边会单独改变这一颗按钮的视觉权重。按"抽象延迟到第二个真实用例"的既有口径留在包内，理由与复核结论写在文件头注释里（`94a0c020`）。
- **刻意不上移：形态未定型、第二个真实用例仍在本包内的共享件**——如 sandbox 的 `JsonPreview`（管理面板四处 JSON 展示块收敛而来），先用包内共享件而不是进 `ui-components`。这与"归属由消费者集合决定"是同一条口径，不是遗漏。

## 5. API 建模层

前端对后端的 HTTP 调用统一经 `@fenix/web-runtime/api/request` 的 `request<T>()`；域模块按**资源归属**定义在 owner 包的 `web/api/` 下。

### 5.1 分层与归属

| 层 | 位置 | 职责 | 引用方式 |
|----|------|------|----------|
| 请求基建 | `packages/web-runtime/web/api/request.ts` | credentials、序列化、超时、合并外部信号、错误标准化 | `@fenix/web-runtime/api/request` |
| 域模块 | `packages/<group>/<pkg>/web/api/<domain>.ts` | URL 拼装、请求/响应序列化、域内类型 | `@fenix/<pkg>/web` |
| 宿主专有域 | `apps/web/src/api/<domain>.ts` | 只服务宿主、无资源包归属的接口 | `@/src/api/<domain>` |
| 组件 | — | 调用域模块 → 处理结果 → 更新 UI | — |

- **归属判据**：接口对应哪张表、哪个 owner，域模块就放在那个包（见 §1）。
- **请求基建不做组织头注入**：租户身份靠 `credentials: "include"` 携带的 better-auth 会话 cookie，以及身份包 fetch 拦截器注入的 `X-Active-Org-Id`（见 §3.3）。域模块不要自己拼组织参数。
- **组件负责**：调用域模块 → 处理结果 → 更新 UI。不写 `fetch`、不拼后端 URL。
- **窄口**：默认经包根 `./web` 出口；确需跨包少量复用时单开（现仅 `@fenix/agent-runtime/web/api/environments`），须在该包 `exports` 显式声明，且导出文件必须是浏览器安全入口。

### 5.2 共享请求基建契约

实现见 `packages/web-runtime/web/api/request.ts`。**本节只描述契约，不复制实现**——实现会变，契约才是约束。

#### 导出面

| 导出 | 作用 |
|------|------|
| `request<T>(url, options)` | 统一请求函数，返回 `Promise<ApiResponse<T>>` |
| `unwrap<T>(resp)` | 解包 `ApiResponse`：成功返回 `data`，失败抛 `ApiError` |
| `ApiError` | 统一错误类，字段为 **`message` / `code` / `data`** |
| `ApiResponse<T>` | `{ success, data?, error?: { code, message, data? } }` |
| `PaginatedResponse<T>` | `{ items, total, page?, pageSize? }`——`page`/`pageSize` 可选，并非所有分页端点都返回 |
| `ErrorCode` | `KnownErrorCode \| (string & {})`，兼容后端透传的自定义业务错误码 |
| `WRITE_TIMEOUT_MS` / `UPLOAD_TIMEOUT_MS` | 均为 120s，与后端 file_op / upload 对齐 |

`RequestOptions` 与 `NetworkError` **不是导出符号**：调用方无法对 request 层做类型标注，也无法用 `instanceof` 区分网络类错误，只能判 `error.code === "NETWORK_ERROR"`。`ApiError` **没有 `status` 字段**——HTTP 状态码在这一层已丢失，需要按状态码分支时只能靠 `code`。

#### `RequestOptions` 字段

| 字段 | 语义 |
|------|------|
| `params` | 路径参数 `:id` 插值 |
| `query` | 查询参数自动拼装 |
| `body` | 普通对象走 JSON，`FormData` / `Blob` 直传 |
| `timeout` | 超时 ms，默认 30000 |
| `signal` | 外部取消信号，与内部超时信号合并 |
| `opId` | 文件写操作幂等 ID，透传 `x-file-op-id`（`docs/arch/12-files.md` §7.2）；重试须复用同一 opId，服务端据此去重 |
| `bearerToken` | 注入 `Authorization: Bearer`（如系统 Master Key，`docs/arch/21` §5） |
| `headers` | 请求头透传（如 `If-None-Match` 条件请求） |

> **`headers` 当前会覆盖内部注入头**（`content-type` / `x-file-op-id` / `authorization`）：实现里 `...init` 在合并后的 `headers` 之后展开，而 `headers` 未被从 `init` 中解构排除。现有测试覆盖不到这一路径，生产代码也暂时没有调用方传 `headers`。**在修好之前不要依赖二者的合并语义**；修法是先把 `headers` 从 `init` 解构排除，再与内部头合并。

#### 失败语义

**这是最容易踩的一条**：

- `request()` 对 HTTP 失败（4xx/5xx）与业务失败（`success === false`）**返回 `{ success: false, error }`，不 throw**。
- `unwrap()` 负责把失败转成 `throw ApiError`。
- 因此**直接 `await request()` 并依赖 `catch` / `onError` 的代码会把 4xx/5xx 当成成功**——`useRequest` 的 `error` / `onError` 只理解 rejected Promise。

**强制要求**：调用方必须 `unwrap()` 或显式判断 `success` 后再使用数据；不得省略解包，也不得新增依赖 `catch` 的调用点。

```tsx
// ❌ 4xx/5xx 会被当成成功，loading/empty 状态继续推进
try { const data = await taskV2Api.list(); } catch { /* 永远不会走到 */ }

// ✅
const data = await unwrap(taskV2Api.list());
// ✅ 需要拿 Result 时显式判断
const res = await taskV2Api.list();
if (!res.success) { /* 处理 res.error */ }
```

#### 其它约定

- **超时下限**：写操作的请求超时不得短于后端（file_op 60s / upload 120s），否则慢写会被前端提前掐断；需要区分时用 `WRITE_TIMEOUT_MS` / `UPLOAD_TIMEOUT_MS`。
- **错误码归一化**：后端用 snake_case 类型名（`not_found`、`validation_error`、`remote_error`），部分模块直接透传 `ErrorCode` 常量——`request()` 统一归一化，未提供时按 HTTP status 兜底映射（401/403 → `UNAUTHORIZED`、404 → `NOT_FOUND`、422 → `VALIDATION_ERROR`、≥500 → `SERVER_ERROR`）。
- **错误记录但不弹 UI**：`request()` 用 `console.error` 记录失败，**不调 `toast`**——UI 反馈是组件职责（见 §5.8）。

### 5.3 非标准响应与非 REST 传输

**每个例外点都必须登记在下面这张表里。** 表格分两类，性质不同，不要混用：

- **能力缺口**：`request()` 的实现缺失（blob / 流 / 进度 / 响应头 / 304）。修法是**给 `request()` 补能力**，不是在调用点继续手写；补完后这些点整体退回 `request()` + `unwrap()`。
- **协议例外**：传输面本身不经 `request()`（WebSocket、SSE、第三方客户端库），补能力后也不应改写。

| 形态 | 命中点 | 收口方式 | 类别 |
|------|--------|----------|------|
| 无业务载荷的成功响应 | knowledge `knowledge-models.ts`（`{ ok: true }`）、prod-view `prod-views.ts`（`{ ok: boolean }`） | `request<{ ok: boolean }>()` 原样返回 | 协议例外（不套 `data` 信封） |
| 业务体自带判别字段 | model-management `providers.ts`（`ModelTestResult{ok, content}`） | 原样保留 | 协议例外 |
| 裸响应体（无 `data` 字段） | identity `web/lib/password-crypto.ts` 取登录加密公钥、宿主 `pages/login-transport.ts` 取 `{ signupAllowed }` | `request<T>()` 后显式判 `success` 再取值 | 协议例外 |
| 二进制 / 文本 / PDF 读 | knowledge `web/api/knowledge-bases.ts` | 裸 `fetch` + 域内 `buildResourceReadError()` 归一为 `ApiError` | 能力缺口 |
| 二进制下载（Blob） | 宿主 `api/fs.ts`（文件 / ZIP）、skill `web/api/skills.ts`（`download`） | 裸 `fetch` / `XHR`，域模块把成功响应收成 `Blob` 交回调用方、失败归一为 `ApiError`（code 与 `unwrap()` 同源），不让组件看到原始 `Response` | 能力缺口 |
| 文本流下载 | observer `web/api/system-logs.ts`（`downloadSystemLog`） | 裸 `fetch` + `buildDownloadError()`；成功只回 `Blob`，建锚点与 `revokeObjectURL` 归调用方 | 能力缺口 |
| 文本 / 流式读（Bearer 鉴权） | sandbox `web/src/api/system-sandbox.ts`（toml、诊断文本、命令 SSE） | 裸 `fetch` + `buildStreamError()`；`executeCommand` 返回原始 `Response` 由调用方消费流。三处只带 `Authorization: Bearer`——`/api/system/*` 的守卫只读该头（`apps/server/src/plugins/system-api-auth.ts`），不送 cookie | 能力缺口 |
| 上传进度 | 宿主 `api/fs.ts`（`uploadFiles`） | `XMLHttpRequest`（进度 / 超时 / abort / `x-file-op-id` / 错误归一全自建） | 能力缺口 |
| 条件请求（`If-None-Match` → 304 + 读回 `ETag`） | 宿主 `api/fs.ts`（`revalidateWorkspaceTree`） | 裸 `fetch`；返回判别式结果而非抛错（304 不是失败） | 能力缺口 |
| WebSocket | `/acp/yjs/*`（§8）、`/web/file-events`（文件树事件） | 不走 `request()`；两条通道的登记见 §8.1 | 协议例外 |
| SSE | workflow `web/api/workflow-sse.ts`（`EventSource` + `withCredentials`） | 不走 `request()`；每个 workflowId 一条独立连接，前端以 `?fromSeqNum=` 续传（服务端另接受 `Last-Event-ID` 头） | 协议例外 |
| better-auth 客户端 | identity `web/lib/auth-client.ts`（`authClient.*`）及其 `/api/auth/sign-up/phone` | 传输由库内 `createFetch` 持有。库内核路由一律用客户端方法；自定义路由（无客户端方法）保留手写请求 | 协议例外 |
| 本地 blob / 预览源读取 | `ui-components/web/components/preview/html-plugin.ts`、`chat/primitives/internal/prompt-input-file.ts` | 读的是本地 blob URL，**不是后端调用**，不属本节管辖 | 不适用 |

**新增例外点的登记要求**：在提交里写明命中点、为何不能走 `request()`、失败归一函数、成功返回值形状，以及能力补齐后的回退动作。

### 5.4 域模块标准模式

域模块从 `@fenix/web-runtime/api/request` 取 `request` 与类型，**返回 `ApiResponse` 交给消费方解包**：

```ts
// packages/resources/task/web/api/tasks-v2.ts —— 节选，实际还有 update / toggle / trigger / logs / clearLogs
import type { PaginatedResponse } from "@fenix/web-runtime/api/request";
import { request } from "@fenix/web-runtime/api/request";

export interface TaskV2Info { /* 域内类型跟随模块定义，不散落到宿主 */ }

export const taskV2Api = {
  /** 分页列表 */
  list: (query?: { page?: number; pageSize?: number; keyword?: string }) =>
    request<PaginatedResponse<TaskV2Info>>("/web/tasks/v2", { query }),

  /** 获取单个 */
  get: (id: string) => request<TaskV2Info>("/web/tasks/v2/:id", { params: { id } }),

  /** 创建 */
  create: (body: TaskV2CreateBody) =>
    request<TaskV2Info>("/web/tasks/v2", { method: "POST", body }),

  /** 删除 */
  del: (id: string) => request<void>("/web/tasks/v2/:id", { method: "DELETE", params: { id } }),
};
```

三点可复现的模式：**文件头注释说明域与例外** + **域内类型与模块同文件** + **单一具名对象导出、不在模块内做 UI 反馈**。

**解包归属要一次性决定**：新增模块**按上面的模式返回 `ApiResponse`**，不要在域模块内提前解包。当前仓库存在两类历史写法（见 §5.9），混用会让调用方无法从签名判断拿到的是数据还是 Result——新增代码不要扩大这个面。

### 5.5 域模块命名与组织

| 规则 | 说明 | 示例 |
|------|------|------|
| 文件名 kebab-case | 与资源域一致 | `knowledge-bases.ts`、`workflow-defs.ts` |
| 导出对象 camelCase + `Api` 后缀 | 避免与类型名冲突 | `taskV2Api`、`mcpApi`、`kbApi` |
| 位置跟随 owner 包 | `packages/<group>/<pkg>/web/api/` | `packages/resources/skill/web/api/skills.ts` |
| 由包 `./web` 出口转出 | 导出面按包外真实消费点收敛 | `export * from "./api/tasks-v2"` |
| 非 REST 传输与域模块同层 | 不塞进 `request()` | `workflow-sse.ts` |
| 请求头在同一个文件里组装 | 鉴权头的选择属于域模块 | `system-sandbox.ts` 的 `adminOptions()` |

### 5.6 域模块一览

| owner 包 | 域模块 | 说明 |
|----------|--------|------|
| `@fenix/web-runtime` | `web/api/request.ts` | 请求基建（非域模块） |
| `@fenix/agent-runtime` | `environments.ts` | 环境与实例；**窄口** `@fenix/agent-runtime/web/api/environments` |
| `@fenix/identity` | `api-keys.ts`、`organizations.ts` | API Key 与组织 |
| `@fenix/agent-config` | `agents.ts`、`sites.ts`、`web/src/api/sidebar-config.ts` | Agent 配置、站点、侧栏配置 |
| `@fenix/model-management` | `providers.ts`、`models.ts`、`model-gateway.ts` | Provider、模型、模型网关 |
| `@fenix/resource-skill` | `skills.ts` | Skill 元数据与内容 |
| `@fenix/resource-mcp` | `mcp.ts` | MCP server |
| `@fenix/resource-knowledge` | `knowledge-bases.ts`、`knowledge-models.ts` | 知识库与嵌入模型 |
| `@fenix/resource-task` | `tasks-v2.ts` | 定时任务（v2） |
| `@fenix/resource-workflow` | `workflow-defs.ts`、`workflow-engine.ts`、`workflow-sse.ts` | 工作流定义、引擎、SSE |
| `@fenix/resource-channel` | `channels.ts` | IM 通道 |
| `@fenix/resource-machine` | `registry.ts` | 机器注册表 |
| `@fenix/resource-memory` | `hindsight.ts` | 记忆 |
| `@fenix/resource-observer` | `observer.ts`、`system-logs.ts`、`system-people-tree.ts` | 观察面板与系统日志 |
| `@fenix/resource-prod-view` | `prod-views.ts` | 生产视图 |
| `@fenix/resource-sandbox` | `web/src/api/{sandbox-pools,system-organizations,system-sandbox}.ts` | 沙箱与系统组织 |
| 宿主 `apps/web/src/api/` | `branding.ts`、`fs.ts`、`instances.ts`、`peri-task-details.ts`、`helpers.ts` | 宿主专有域（无资源包归属） |

按 owner 归属维护，**不记录接口数量**（会漂）。新增域模块时同步本表；删除模块时同步删行。

### 5.7 组件中使用

组件不直接 `await` 域模块，统一交给 ahooks `useRequest`，并用 `unwrap()` 解包：

```tsx
import { useRequest } from "ahooks";
import { taskV2Api } from "@fenix/resource-task/web";
import { unwrap } from "@fenix/web-runtime/api/request";

// 查询：自动管理 loading / error / data，组件挂载时自动执行
const { data, loading, error, refresh } = useRequest(() =>
  unwrap(taskV2Api.list({ page: 1, pageSize: 20 })),
);

// 变更：manual 模式，手动触发，成功后刷新列表
const { run: saveTask, loading: saving } = useRequest(
  async (body: TaskV2CreateBody) => unwrap(taskV2Api.create(body)),
  {
    manual: true,
    onSuccess: () => { refresh(); toast.success(t("toast.saved")); },
    onError: (err) => { console.error("保存失败", err); toast.error(err.message); },
  },
);
```

### 5.8 禁止事项

- **禁止**在组件中直接写 `fetch` / `XMLHttpRequest`，或在 `useEffect` 中裸调 `fetch`（能力缺口见 §5.3，须登记后由域模块承载）
- **禁止**在组件中拼装后端 URL（含 WebSocket URL——见 §8.1）
- **禁止**在域模块中重复定义 `request()`——统一从 `@fenix/web-runtime/api/request` import
- **禁止**在 API 模块内调用 `toast.error`（UI 层职责，错误由组件 `onError` 处理）
- **禁止**新增 `/v1`、`/v2` 历史前缀（由 `frontend-no-legacy-api-prefix` 规则阻断，见 §11.2）
- **禁止**绕过包 `exports` 深引 `@fenix/<pkg>/src/*`、`@fenix/<pkg>/web/src/*`
- **禁止**直接 `await` 域模块并依赖 `catch`（必须解包，见 §5.2）
- **禁止**把失败静默映射成 empty 或成功状态
- **禁止**在用户可感知失败的位置只写 `console.error` 而不给用户可见反馈。判据是三条**同时**成立：① 位置在组件 / 页面 / hook 的 `catch` 或异步失败分支里；② 失败由用户操作触发，或使用户正在看的内容不可用；③ 同作用域（同一函数内）没有别的用户可见反馈（`toast` / 内联错误态 / 降级 UI）。

这条规则**没有门禁，只能人工 review**：`console.error` 是诊断信号，天然合法，工具无法区分"记录了"与"只记录了"。三类位置**必然豁免**，不需要也不该补提示：

| 豁免 | 理由 |
|------|------|
| 域模块与请求基建 | 模块内禁止 UI 反馈（见上一条与 §5.2 的 `request()` 契约） |
| ErrorBoundary 的 `onError` | 降级 UI 本身就是用户可见反馈（§7.1） |
| 后台触发路径（轮询、WS/SSE 回调、定时器、订阅） | 失败不改变用户此刻在做的事，弹提示属噪声 |

补反馈时用 `toast.error(t("<key>"))`，**保留原有 `console.error`**（它承载诊断上下文）；`packages/ui-components/**` 内部不直接调宿主 `toast`，只经 `onNotice` / `onError` 端口抛出文案。`/login` 与 `/admin` 下没有 `Toaster`（§3.1），这两条路径上的失败必须用内联错误态——在那里 `toast.error` 是静默 no-op。

### 5.9 现状偏离

- **`headers` 覆盖内部头的实现缺陷**（§5.2）：文档过去把"内部头不会被覆盖"写成已实现，实际相反。
- **实现与注释不一致的三处**（以代码为准，不要以注释为承诺）：① `request()` 的 catch 注释承诺"网络错误/超时自动重试 1 次并复用同一 opId"，**实现里没有第二次执行**；② 超时定时器在收到响应头后即清除，**不覆盖 body 消费**，慢 `json()` / `text()` 不受超时约束；③ `anySignal` 合并后的监听器在请求成功后不移除，会挂在调用方的 `signal` 上直到其 abort。
- **两处"失败被吞掉"的已知残留**（§5.8 判据命中，补法需改对外契约或属后台路径，2026-09-22 全量复核时未动）：① `platform/identity/web/contexts/OrgContext.tsx` 的 `refreshOrgs` 失败只 `console.error`，组织页会按"无组织"渲染（落到 `noOrgs` 空态、无失败态）——要补持久失败态必须扩 `OrgContextValue`；② `agent-config/web/components/agent-panel/SiteFrame.tsx` 的挂载二维码在后台预生成，失败只留 `console.error`，分享弹层会停在永久 spinner（补法建议在弹层内落"最近一次生成失败"静态态，而不是 toast——弹层可能在失败之后才被打开）。
- **解包归属存在两代写法**：9 个模块在域内 `unwrap()`（宿主 `fs.ts` / `peri-task-details.ts`、`model-gateway`、`observer`、`system-logs`、`system-people-tree`、`hindsight`、sandbox 的 `system-organizations` / `system-sandbox`），另有 3 个 blob 家族模块（`knowledge-bases`、`skills`、`system-sandbox` 的部分方法）在域内抛错。注意 `system-sandbox` 同时属于两组，去重后**合计 11 个模块的对外签名是数据或抛错，不是 Result**，与 §5.4 的"新增返回 `ApiResponse`"并存。
- **5 个模块用函数式导出而非 `*Api` 对象**：`model-gateway.ts`（12 个具名函数）、`observer.ts`、`system-logs.ts`、`system-people-tree.ts`、`system-organizations.ts`。与 §5.5 的命名规则不符。
- **`workflow/web/api/workflows.ts` 已删除**（`ac642962`，2026-09-22）：它是迁移期留下的第二份 `workflow-defs` 客户端，`WorkflowDefItem` / `WorkflowVersionItem` / `VersionYamlResponse` 与 `ENDPOINT` 常量同 `api/workflow-defs.ts` 逐字重复，导出的 `workflowApi` 全仓零引用（消费方一直用 `workflowDefApi`）。按"删除优于兼容"未留 shim 与别名，入口的三个 API client 是 `workflowDefApi` / `workflowEngineApi` / `customToolsApi`。**不要再以"补齐第二份客户端"为由重建**。
- **`frontend-no-legacy-api-prefix` 规则只识别裸 `request(...)` 调用**：写成成员调用（`this.request("/v1/...")`）或裸 `fetch("/v1/...")` 会绕过。当前控制台代码无 `/v1`、`/v2` 命中，但不要依赖这条规则做全量保证。
- **域模块与页面的失败提示曾普遍回显服务端 `err.message`**（**两个批次均已收口，只剩 8 处登记了理由的豁免**）：宿主 `apps/web/src` 与 `resources/{task,agent-config}` 于 v3.0.15 收口（23 个调用点，判定「不提炼通用映射器」的理由见 v3.0.15 条目）；其余 11 个包于 v3.0.16 收口。实测两个口径（2026-09-23 复测，命令照抄即可复现）：
  - **单行口径**（旧快照的「32 个文件、102 处」就是它）：`grep -rn "toast\.error" apps/web/src packages/*/*/web packages/*/web --include=*.ts --include=*.tsx | grep -c "\.message"` → **102 行 / 34 文件 → 80 行 / 28 文件 → 5 行 / 4 文件**。它只认「`toast.error` 与 `.message` 同行」，跨行调用与经 `t()` 插值回显都不计。
  - **括号配对口径**（从每个 `toast.*(` 起做括号配对，取整段实参再判是否含 `.message`，覆盖跨行与模板字符串形态）：**106 个调用点 / 34 文件 → 84 / 28 → 8 / 5**（其中 3 处是模板字符串形态）；两个中间数字相差 1 是口径本身造成的——上一轮记的 83 只取 `toast.error(`，本轮按全部 `toast.*` 复测为 84，差的正是 `toast.success(feedback.message)` 这类非 `error` 调用。
  - **保留回显的 8 处**（每处都要在改动时重新确认理由，处数由下面的守卫钉住）：① mcp 的 `testUrl` 探测结果 `{ reachable, protocol, message }`（`agent-mcp-dialog`，2 处）与 knowledge 的厂商 Key 校验结果 `{ success, message }`（`EmbeddingModelManager`，1 处）**是服务端为展示设计的字段**，自带「非 MCP 协议 / 连接失败」等中文兜底，不是错误信封——去掉等于删掉用户唯一的连接诊断；② `WorkflowEditor` 里 dry-run 的 `issues[].message`（1 处）是**成功响应**里的逐节点校验诊断，标题已由 `t("editor.validate_fail", { count })` 承载且每项带稳定 `code`；③ workflow 的 YAML 导入失败（`useWorkflowPersistence`，2 处）来自**本地** `yamlToFlow`（js-yaml 的 `YAMLException`，描述用户自己刚提交的那份文本、带行列号），不属服务端错误；④ sandbox 的 `feedback.message`（`use-sandbox-dashboard`，2 处）是本地 `ClusterActionFeedback` 用 `t()` 拼出来的文案（`formatHealthCheckResult`），本身就是字典文案，只是字面上匹配 `.message`。
  - **仍未收口**：`knowledge/web/pages/agent-panel/pages/agent-knowledge-load-failure.tsx` 会把服务端 message 作为失败块的说明**有意**展示（组件注释写明「服务端消息是排障上下文」，`knowledge-panel-load-failure-states.test.tsx` 还钉着 `boom` / `检索服务不可用` 断言）。它与 §9.3 的口径冲突，改动涉及 4 个调用点与 5 条既有断言，留待单独裁定；model-management 的 `loadProvidersError` / `loadModelConfigError` / `batchDeleteError` / `modelSubrow.testModel.error` 是**全仓零引用**的既有死键（仍带 `{{message}}` 槽位），按「不删除无关死代码」登记于此。
  - 与 §9.3「错误按稳定 code 映射文案」不一致的既有形态已登记，Chat 域另有更早的收敛（见 §6.5）。

## 6. 安全规范

前端安全是质量基线，以下规则**必须**遵守，违反需在 code review 中 block。

### 6.1 XSS 与不可信内容渲染

- **禁止** `dangerouslySetInnerHTML`，除非经过 DOMPurify 清洗。清洗即合规——**不需要**额外的批准注释，但需要在该行或函数上方写清**内容来源**（谁产生的、为什么可信）。
- 禁止直接拼接 HTML 字符串注入 DOM。
- 用户生成内容（UGC）与 **Agent / LLM 输出**同等对待：都是不可信输入。

```tsx
// ❌ 禁止
<div dangerouslySetInnerHTML={{ __html: userInput }} />

// ✅ 域模块内清洗，组件只接清洗后的值
import DOMPurify from "dompurify";
<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />
```

**Markdown 渲染**：以 `streamdown` 为唯一渲染器（`MessageResponse`，懒加载，经 `allowedTags` 白名单 + `urlTransform` 收口）。新增 Markdown 渲染场景时复用这条链路，不要另起一条。`streamdown` 之外的直接 `react-markdown` 用法当前只剩 `knowledge` 预览一处（`ResourcePreviewContent.tsx`，已接 `rehype-sanitize` 的 GitHub 默认 schema）——它的输入是用户上传的文件正文，且 `react-markdown` 不渲染原始 HTML，属可接受的最小偏离；`memory` 原先那条无人消费的 `CompactMarkdown.tsx` 已于 2026-09-23 删除（见 §6.5）。

### 6.2 iframe 沙箱

`allow-scripts` + `allow-same-origin` 同时开启时，iframe 内脚本可以读写父页面的 DOM 与存储——**等价于没有沙箱**。按来源分级：

| 来源 | 要求 | 当前实现 |
|------|------|----------|
| Markdown / Agent 输出里的 `<iframe>` | **必须**去掉 `allow-same-origin`，且对 `src` 做协议与域名校验 | 已收口（2026-09-23）：`ui-components` 的 `IframePreview` 两处 iframe 均为 `sandbox="allow-scripts allow-popups"`，`src` 过协议白名单（`http:` / `https:` / 相对地址 / `data:`），模型自带的 `sandbox` 被剔除 |
| 用户自己的站点（`siteUrl`、`SiteFrame`） | 可保留 `allow-same-origin`，但必须带 `referrerPolicy` | 已带 `referrerPolicy="no-referrer"`（`SiteFrame.tsx`、`AgentSitesCard.tsx`） |
| 同源文件预览（pdf / office 转 pdf） | 可用 `srcDoc` 或同源 URL，`sandbox` 可选 | 部分 iframe 无 `sandbox` 属性（同源，风险低）。**但知识库的 HTML 预览不算这一类**——它是用户上传的 UGC，`srcDoc` 且 `sandbox="allow-scripts"`（2026-09-23 去掉 `allow-same-origin`：`srcdoc` 继承父页面源，与 `allow-scripts` 组合即可自行摘掉 sandbox） |

新增 iframe 时必须显式写出 `sandbox` 属性并说明取值理由。

### 6.3 凭据与本地存储

- **禁止**将 API Key、Token、Secret 存入 `localStorage` 或 `sessionStorage`。
- 认证 Token 仅通过 HttpOnly Cookie 传输，前端不直接读写。
- 前端配置中出现的密钥占位符（如 `{env:RCS_SECRET_xxx}`）**不得**在前端代码中展开或替换。
- API Key 创建成功后仅展示一次，前端**不得**将明文 Key 持久化到任何本地存储。

**唯一的凭据类例外**（用户裁定保留，不得作为新代码先例）：

- 系统 Master Key 存 `sessionStorage`（键 `rcs_admin_master_key`）：实现见 `packages/web-runtime/web/lib/admin-key.ts`，写入点是 `@fenix/web-runtime/hooks/use-admin-key-gate` 的 `unlock()`（门组件为 `@fenix/ui-components/config/AdminKeyGate`，5 处消费：sandbox / observer ×3 / model-management），经 `request()` 的 `bearerToken` 注入 `Authorization`；401 时调用方经 `fail()` 清 key 回门。master key 不进 better-auth 会话体系，落在标签页 session 内换取"刷新免重输"；代价是同源脚本与 XSS 可直接读走该值，因此**只允许服务系统管理员页**（sandbox / observer / model-management 的 master key 门），不得用于普通用户凭据。XSS 面由 §6.1 与 §6.2 控制。
- **移除条件**：master key 改由服务端 HttpOnly Cookie 或仅内存态承载（接受刷新重输）后，删除 `admin-key.ts` 及其全部消费方，并同步删除本条登记。

**`localStorage` 的合法用途白名单**（除 master key 外一律非凭据）：

| 用途 | 键 / 位置 |
|------|-----------|
| UI 维度与布局偏好 | `ChatArea`、`artifacts-files-workspace` |
| 面板开合状态 | `wf-editor:chat-open`（workflow 编辑器）、`acp-sidebar-open`（chat panel） |
| 侧栏折叠状态 | `AgentSidebar`、`AgentSidebarTree` |
| 语言 | `rcs-lang`（i18n 检测器托管） |
| 主题 | 无（全局强制亮色，见 §3.2；`theme` 键已不再被读写） |
| 登录页偏好 | `apps/web/src/lib/auth-preference.ts` |
| 匿名 UUID | `apps/web/src/api/helpers.ts`（当前零消费） |

**组织 id 不在"便利"的范畴**：它决定请求归属哪租户，只允许经上下文读取（见 §3.3）。

### 6.4 敏感操作

- 删除、权限变更、组织转移等敏感操作**必须**经过二次确认，用 `ConfirmDialog` 且 `variant: "destructive"`。
- **禁止原生 `confirm()` / `window.confirm()`**：它阻塞主线程、无法本地化、样式不受控，且绕过 `ConfirmDialog` 的可访问性实现。
- 敏感操作的 API 调用**禁止**在 URL 中携带敏感参数（使用 POST body）。

### 6.5 现状偏离

2026-09-23 的收口批次已消掉前四条（`dangerouslySetInnerHTML` 的默认配置、第二条 Markdown 渲染链、Markdown iframe 的沙箱组合、knowledge 预览未接 sanitize），保留下面的已处置记录与仍未修的条目。

- ~~**3 处 `dangerouslySetInnerHTML` 全部经 DOMPurify，但都用默认配置**~~ **已收紧**：抽出 `knowledge/web/lib/sanitize-html.ts` 的两份显式白名单（`sanitizeHighlightHtml` / `sanitizeRichHtml`），三处调用点（`components/knowledge/ResourcePreviewContent.tsx` 的 docx 分支、`src/pages/agent-panel/components/{ChunkDetailSheet,RetrievalTestPanel}.tsx`）改走 helper，`knowledge/web/__tests__/sanitize-html.test.ts` 钉住白名单内容与接线。**保留的取舍**：`class` 仍在两份白名单里（RAGFlow / mammoth 用它表达表格与段落样式），因此不阻断 Tailwind 类名注入造成的 UI 伪装；要挡需另行裁定。
- ~~**存在 `streamdown` 之外的第二条 Markdown 渲染链**~~ **已删除**：`memory/web/pages/hindsight/components/CompactMarkdown.tsx` 零消费者坐实，连同同名 CSS 与 `react-markdown` / `remark-gfm` 依赖一并移除（2026-09-23）。
- ~~**最大 XSS 面未收口**~~ **已收口**：`ui-components/web/chat/primitives/iframe-preview.tsx` 的两处 iframe 去掉 `allow-same-origin`，并补 `src` 协议白名单与 `sandbox` 覆盖防护，测试见 `ui-components/web/__tests__/iframe-preview-sandbox.test.tsx`。`data:` 有意留在白名单里（其文档永远是 opaque origin，不与父页面同源），移除条件写在组件内 `ALLOWED_IFRAME_PROTOCOLS` 的注释里。
- ~~**knowledge 预览的 Markdown 走 `react-markdown` 且未接 `rehype-sanitize`**~~ **已补**：`ResourcePreviewContent.tsx` 的 `rehypePlugins` 接上 `rehype-sanitize`（GitHub 默认 schema）。**注意白名单外的差异**：schema 只放行 `http:` / `https:` 的 `src`，所以正文里 `data:` 内联图会被剥掉（与同级 docx 预览的 `data:` 内联图行为不同，后者走 `sanitizeRichHtml` 保留）。
- **错误文案回显**：Chat 域按稳定 `error.type` 映射字典（`public-error-text.ts` + 协议侧明确"不得使用原始异常文本"，并有 `public-error-i18n.test.ts` 守护）；域模块与页面的失败提示原普遍直接显示 `err.message`，现全仓已改为只上屏本包字典文案——宿主 `apps/web/src` 与 `resources/{task,agent-config}` 于 v3.0.15（§5.9 批次一，判定「Chat 的 `publicErrorText` 不可提炼为通用能力」的理由也在该条），其余 11 个包于 v3.0.16（批次二）。回归守卫是 `apps/web/src/__tests__/package-error-text-echo.test.ts`：它按括号配对取每个 `toast.*(` 的整段实参，除**逐条登记理由**的 8 处豁免外不得出现 `.message`，并同时钉住豁免清单的处数。**两类例外**：① 服务端为展示设计的字段（mcp 的 `testUrl` 探测结果、knowledge 的厂商 Key 校验结果、dry-run 的 `issues[].message`）与本地组合出的文案（sandbox 的 `ClusterActionFeedback.message`）保留回显，理由见 §5.9 的豁免清单；② `knowledge` 的 `KnowledgeLoadFailure` 仍把服务端 message 当失败块说明**有意**展示，与本条口径冲突，属待裁定项（位置与影响面见 §5.9）。
- **DOMPurify 的运行时行为在本仓测试环境里测不出来**（2026-09-23 实测）：DOMPurify 3.4.11 用 `lookupGetter(Node.prototype, 'nodeName' / 'nodeType')` 缓存跨 realm 取值器，而 happy-dom 20 把这两者的可访问实现放在子类原型上，直接调基类取值器得到空串；把这一点绕开之后，happy-dom 的 NodeIterator 又会在**首次节点移除后中止**遍历。两条都不影响真实浏览器，但意味着「渲染后的 HTML」类断言在 happy-dom 下测到的是桩行为——清洗相关用例只断言白名单与接线（见 §11.2）。

## 7. 错误边界

使用 ErrorBoundary 防止单个组件崩溃导致整个页面白屏。

### 7.1 放置规则

- **每个独立功能面板**各自包裹 ErrorBoundary，一个面板崩溃不影响其他面板。
- 顶层根布局需要兜底 ErrorBoundary。
- 路由段也应有边界；当前仓库**未使用** TanStack Router 的 `errorComponent` / `pendingComponent`（`__root.tsx` 只声明了 `notFoundComponent`），新增路由时按现有手段（ErrorBoundary 组件）包裹，不要假定框架层已经兜住。

**放置矩阵**（规则；当前落地情况见 §7.3）：

| 层级 | 包裹范围 | 位置 | 关键/非关键 |
|------|----------|------|------------|
| 根布局 | 整个应用 | `__root.tsx` 最外层 | 关键（兜底） |
| Agent 面板布局 | `_panel.tsx` 路由布局 | 包裹 `{children}` 出口 | 关键（Agent 页整体） |
| ChatPanel | 聊天交互面板 | `ChatPanel` 根组件 | 关键（核心功能） |
| ArtifactsPanel | 输出展示面板 | `ArtifactsPanel` 根组件 | 非关键（可降级） |
| Sidebar | 左侧导航 | `AgentSidebar` 根组件 | 非关键（可降级） |

```tsx
import { ErrorBoundary } from "react-error-boundary";

function ChatPanelFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div className="flex flex-col items-center gap-3 p-6">
      <p className="text-sm text-muted">{t("errors.panelCrashed")}</p>
      <Button variant="outline" onClick={resetErrorBoundary}>{t("common.retry")}</Button>
    </div>
  );
}

<ErrorBoundary FallbackComponent={ChatPanelFallback} onError={(err) => console.error("ChatPanel 崩溃", err)}>
  <ChatPanel />
</ErrorBoundary>
```

### 7.2 降级策略

- `FallbackComponent` 必须提供**重试按钮**（调用 `resetErrorBoundary`）。
- **降级 UI 不得渲染 `error.message`**——它可能含内部实现细节与后端文案。用固定的本地化文案，原始错误只进 `console.error`。
- 降级 UI 不应改变页面布局结构，避免级联布局崩溃。
- `onError` 必须 `console.error` 记录原始错误；关键/非关键面板都可收缩为最小化状态（如一条错误提示条）。
- 降级 UI 本身就是用户可见反馈，**不需要**额外 `toast.error`。

### 7.3 现状偏离

2026-09-23 的错误边界批次已消掉前两条（§7.1 的放置矩阵基本未落地、`FileViewerErrorBoundary` 回显 `error.message`），保留下面的处置记录与仍未修的条目。

- ~~**§7.1 的放置矩阵基本未落地**~~ **已落地**：新增统一降级 UI `@fenix/ui-components/ui/error-fallback`（`ErrorFallback`），`__root.tsx`、`agent/_panel.tsx`、`ChatPanel`、`ArtifactsPanel`、`AgentSidebar` 五处按矩阵逐行包裹。它的 props 只有 `resetErrorBoundary`（另有可选 `message` / `variant`），**刻意不接收 `error`**——§7.2 的「降级 UI 不得渲染 `error.message`」由此成为类型约束而不是 review 项；文案取包内字典新增的 `errors.renderFailed` / `errors.retry`，容器形态沿用 §2.5 `Spinner` 的 `panel` / `screen` 两档词汇。**本组件不依赖 `react-error-boundary`**：那会把该包外依赖带进所有资源包的浏览器可达面（§11.2 的白名单逐包登记），边界机制留在调用方，组件只收回调端口。五处落点的取法：根布局与布局路由用 `screen` 形态（崩溃时页面外壳已不可用），三个面板用 `panel` 形态；`_panel.tsx` 的边界在 `Suspense` **外**（懒加载代码块被拒时 `Suspense` 接不住），§2.5 的壳形态原样保留；三个面板的边界裹在**导出处**而不是某个 `return` 上——面板有多个出口，取数与运行时 hook 的抛错也要归边界管。五处 `onError` 一律 `console.error`（§7.1 已豁免其补用户可见反馈），**不叠 `toast.error`**（§7.2 末条）。
- ~~**`FileViewerErrorBoundary` 的降级 UI 直接渲染 `error.message`**（违反 §7.2）~~ **已收口**：降级 UI 改用统一 `ErrorFallback`（并补上此前缺失的重试出口——清 `hasError` 重新挂载 `FileViewer`），`error.message` 只进 `componentDidCatch` 的 `console.error`；从未被读过的 `filePath` prop 一并删除。原文并列的「中文兜底文案未走 `t()`」属**订正**：`fileTree.preview.componentError` 已在 v3.0.10 批次并入包内字典，本批次只剩「回显 message」一条真偏离。
- **所有边界只做 `console.error`，无任何上报通道**（未变，本轮不建——仓库里没有任何已存在的上报设施，先立一条通道反而是新造能力）。
- 降级链路的两条不变量有测试钉住：「抛错 → 渲染降级 UI 且不含 `error.message`」「点重试 → 边界重置并把子树重新渲染」见 `ui-components/web/__tests__/error-fallback.test.tsx`（组件契约）与 `apps/web/src/__tests__/error-boundary-fallback.test.tsx`（真实 `ErrorBoundary` 接线）。**仍是人工判断的部分**：新增页面 / 面板要不要按 §7.1 包裹，见 §11.3。

## 8. WebSocket / 实时通信

### 8.1 实时通道登记

前端与后端的实时连接**只有三条**，新增通道必须先在这里登记（路径、建连点、鉴权方式、重连策略）：

| 通道 | 路径 | 建连点 | 鉴权 | 重连 |
|------|------|--------|------|------|
| Chat 状态同步（Yjs） | `ws(s)://<host>/acp/yjs/:agentId` | `packages/agent-runtime/web/yjs/yjs-ws.ts` 的 `buildYjsUrl` → `@fenix/chat-channel` 的 `createYjsWsClient` | 会话 cookie + query `active_org_id`（**组织 id 直读 localStorage，见 §3.6**）；无 `Authorization` 头 | 指数退避，终态码不重连（§8.3） |
| 文件树事件 | `ws(s)://<host>/web/file-events` | `apps/web/src/components/agent-panel/use-file-tree-events.ts` | 同上 | 组件内自持 |
| Workflow 运行事件（SSE） | `/web/workflow/:id/events` | `packages/resources/workflow/web/api/workflow-sse.ts` | `withCredentials: true` | 每个 workflowId 一条独立 `EventSource`（禁止模块级单例）；前端以 `?fromSeqNum=` 续传，服务端另接受 `Last-Event-ID` 头 |

**不得在组件里拼装后端 URL**——通道二当前的 URL 拼装写在组件里，属已知偏离（§8.6）。

### 8.2 连接生命周期

- **建立**：`gateway.handleOpen` 认证 → `ensureRunning` → 打开 Chat Doc / Session Doc → **`relayReady = true` 之前发送初始快照** → `connect` 握手 → flush 缓冲消息。
- **前端建连守卫**：`use-chat-panel-runtime.ts` 在登录态 loading / failed 时早退，无 `sessionId` 不建连——**登录态未就绪不得建连**。
- **断开**：`handleClose` 释放连接级资源与 relay 引用计数；Agent 实例存活时重连后由 `handleOpen` 重新同步；`relay_closed`（实例断链）才销毁 Doc。
- **心跳**：前端每 30s 发 `{ type: "keep_alive" }`（仅页面可见时），服务端每 30s 下发 `keep_alive`。**服务端不再因客户端心跳超时而关闭连接**（客户端暂停心跳如页面冻结是被允许的）。`ping` / `pong` 属 acp-link 机器侧协议，不是前端聊天通道的心跳。

### 8.3 重连与终态码

客户端指数退避重连（1s → 2s → 4s → 8s → 16s → 30s），连续 6 次短连接（<30s）后停止（`chat-channel/src/transport/ws.ts` 的 `NO_RECONNECT_CODES` 与 `RECONNECT_DELAYS`）。**终态判定与 UI 语义的唯一来源是同一张策略表**：`chat-channel/src/transport/ws-close-codes.ts` 的 `WS_CLOSE_CODE_POLICY`（逐码两列 `stopReconnect` / `uiCode`，另有 `nonTerminalReason`）；`ws.ts` 的 `NO_RECONNECT_CODES` 与 `agent-runtime/web/yjs/yjs-ws.ts` 的 UI 语义视图都由它派生（2026-09-22 收敛，`88d59ff6`），**改行为只改这张表**。下表是它的可读视图：

| 关闭码 | 语义 | 前端行为 |
|--------|------|----------|
| 4001 | 实例空闲被回收（`instance_idle_reclaimed`） | 停自动重连；**切回前台时自动重连** |
| 4004 | 环境不可用（`environment_unavailable`） | 停自动重连，展示后手动恢复 |
| 4500 | 机器离线（`machine_unavailable`） | 停自动重连，手动重试 |
| 4501 | 客户端 keepalive 超时（`client_keepalive_timeout`） | 停自动重连；**切回前台时自动重连** |
| 4502 | spawn 永久拒绝（`spawn_rejected`，autoStart 关闭 / 并发上限等） | 停自动重连，按 `payload.code` 展示原因 |
| 4503 | 机器已被占用（`machine_already_connected`） | 停自动重连（`stopReconnect: true`）；`uiCode` 在策略表里**显式为 `null`**——缺口登记在该行，不是散落的遗漏（见下与 §8.6） |
| 1013 | 连接数超限（`too_many_connections`） | **不停自动重连**（`stopReconnect: false`，靠退避 + 短连接计数收敛）；只有 UI 语义是终态（`uiCode: "too_many_connections"`） |
| **1013（例外）** | 慢消费者追赶超时（close reason = `slow consumer resync timeout`） | **非终态**（`nonTerminalReason` 命中时 `uiCode` 取 `null`）：自动重连后走全量快照同步，不得展示"须手动恢复" |

**两个问题、两张视图、一张表**：传输层问的是"停不停自动重连"（`stopReconnect`），UI 层问的是"给用户什么语义"（`uiCode`），成员集合可以不同，所以 `WS_CLOSE_CODE_POLICY` 逐码登记两列、两个消费方各自派生自己的视图，`chat-channel/src/__tests__/ws-close-codes.test.ts` 把这两列与收敛前的字面量钉成基线（改表即同时改两层行为，两处基线测试必须一起过）。4503 的缺口在表内被显式登记（`uiCode: null`），见 §8.6。

**当前零调用点（按本仓「零消费导出保留 + 登记」的口径处置，不要顺手删）**：`getTerminalYjsWsErrorCode()`（`agent-runtime/web/yjs/yjs-ws.ts`）与可见性触发的自动重连规则 `shouldAutoReconnectOnVisible()`（`apps/web/src/pages/agent-panel/chat-visible-reconnect.ts`）在生产代码里都没有调用方——前者只剩包内用例逐码断言（`agent-runtime/web/__tests__/yjs-ws.test.ts`），后者只剩 `apps/web/src/__tests__/chat-visible-reconnect.test.ts`（该模块仍被 `use-chat-panel-runtime.ts:39` 取用其状态类型）。线上连接错误展示走服务端 `error` 帧 → `classifiedError` → `PublicErrorCard`（`use-chat-panel-runtime.ts:281`、`ChatPanel.tsx:120`），不经过这两个入口；是否重新接线或退场待裁定。

### 8.4 消息类型

| 类型 | 方向 | 说明 |
|------|------|------|
| `action`（commandId 信封） | 前端 → 后端 | 会话操作（send_prompt / cancel / load_session 等），`commandId` 幂等去重 + `accepted → committed` 两阶段 Ack |
| `keep_alive` | 双向 | 可见性标记与心跳 |
| Yjs 增量（`chat:` / `session:`） | 后端 → 前端 | 双 Doc 状态广播（消息时间线、会话元信息、权限、工具调用） |
| `action_ack` / `action_error` | 后端 → 前端 | 操作确认与稳定错误码 |
| `error` | 后端 → 前端 | 连接级错误（携带终态码对应 `payload.code`） |

**背压由服务端承担**：发送积压超过 64 KB 时服务端跳过该次发送，并在缓冲回落后**主动定向补发全量快照**（不需要客户端重连——`broadcaster.ts` 的注释明确写了不再依赖"下次重连"，属静默恢复）；持续滞后超过 30s 才 `close(1013, "slow consumer resync timeout")` 交回客户端重连路径。前端**不实现背压**，不要按"客户端要限流"的思路改代码。

### 8.5 前端 Chat 约束

以下约束共同保证刷新恢复、多标签页一致性与消息不重复，改动 Chat 相关代码前必须逐条确认：

1. **`rcsSessionId` 必须确定性生成**（`createDeterministicRcsSessionId`），不得用 `Date.now()` 或随机值——否则刷新后旧 Y.Doc 不可达。
2. **初始快照先于 `relayReady`**：服务端在 WebSocket open 时先发 Chat Doc 与 Session Doc 快照（前端侧是 state-vector 帧）。
3. **重连时必须恢复 `acpSessionId`**：服务端在 `handleOpen` 里读 Session Doc 的 `root.session.sessionId` 回填 `entry.acpSessionId`（`chat-channel/src/channel/gateway.ts`）——旧的 `chatMeta.activeSessionId` 字段已随 schema 重构删除，不要再引用。同一 ACP session 的 `load_session` 必须跳过 Agent 全量回放。
4. **`cwd` 由服务端 translator 注入**；Agent status 到达前不得发送 `list_sessions`。
5. **Doc 名固定为 `chat:{rcsSessionId}` / `session:{rcsSessionId}`**，广播必须按 `rcsSessionId` 隔离，禁止全局广播会话数据。
6. **用户消息只由后端写入 Y.Doc**。前端不得维护第二份 `localUserEntries` 之类的本地副本，否则 Agent 回显会造成双写。
7. **会话切换与内容清理走"换代"**：由 `DocManager.replaceProjection` 完成（`session-channel.ts` 调用）。**不要**使用 `chat-writer.ts` 的 `clearSessionDocContent`（零生产调用点，且 `docs/arch/19-yjs-chat-streaming.md` §4.2 明确禁止回到旧的清空流程），也不要用 destroy + recreate 制造异步竞态。`create_session` 同样必须先清空旧 Session Doc。
8. **同一 `instanceId + userId` 的多标签页共享一个 relay handle**；引用计数归零后才释放；切换 session 时同步同组客户端的 `acpSessionId`。
9. **连接上限与容量**：`YJS_MAX_CLIENTS` 默认 200，由 agent-runtime 模块声明并经 `AgentRuntimeModuleConfig.yjsMaxClients` 注入 chat-channel 装配（不要直读 env）。修改时必须保留限流、资源释放与单连接故障隔离。
10. **`ChatView` 与 `EntryRenderer` 使用 `React.memo`**，comparator 必须与调用方 prop 稳定性保持一致（`ChatView.tsx`、`EntryRenderer` 有显式逐 prop 比较，`MessageResponse` 比较 `children` + `envId`）。改动 props 时同步更新 comparator 与渲染测试。
11. **`@fenix/chat-channel` 根入口必须浏览器安全**：根入口只导出类型（`./types`）、schema、`public-error`、`chat-writer`、`yjs-store`、`protocol`、`transport`、`util`；服务端能力（channel 控制面、persist 持久化、state 聚合层）必须经 `@fenix/chat-channel/server` 导出。边界由 `packages/chat-channel/src/__tests__/chat-channel-browser-surface.test.ts` 静态走值导入图守护（`scripts/check-architecture.ts` 的 `browser-entry-server-import` 同时静态拦截 `@fenix/chat-channel/server`）。

> Chat 状态消费用 `useChatState` / `useSessionState`（`@fenix/agent-runtime` 根出口），Yjs URL 构造与客户端包装在 `packages/agent-runtime/web/yjs/yjs-ws.ts`。服务端生命周期见 `packages/chat-channel/src/channel/gateway.ts` 与 `docs/arch/19-yjs-chat-streaming.md`。

### 8.6 现状偏离

- **两条 WS 通道的组织 id 都直读 `localStorage`**（`yjs-ws.ts`、`use-file-tree-events.ts`），绕过组织上下文；WS 无法带自定义头，需要契约化的参数传递方式才能收口（同 §3.6）。
- **`/web/file-events` 的 URL 拼装写在组件里**（`use-file-tree-events.ts`），违反"不在组件中拼装后端 URL"。
- **前端零背压实现**：发送只判 `readyState`，依赖服务端 `close(1013)` 兜底。
- **`clearSessionDocContent` 仍在 `chat-writer.ts` 中导出并保留生产引用**：它零生产**调用**，但 chat-channel bootstrap 把 `prepareClearSessionSnapshot` 作为回调注入快照写入路径——删函数会打断生产编译，收口时要连引用一起清。
- **4503 的 UI 语义缺口（缺口本身已显式登记，本批不补）**：4503（`machine_already_connected`）在 `WS_CLOSE_CODE_POLICY` 里是 `stopReconnect: true` + `uiCode: null`（`chat-channel/src/transport/ws-close-codes.ts`），用户会看到"连接停了但没有任何提示"。**补齐 `uiCode` 是行为变化**（原先静默的路径会开始出现错误提示），必须单独一批、单独授权，不要以"消缺口"为由顺手补；裁定前保持 `null` 并在策略表注释里保留指向本节的位置（见 §8.3）。
- **`CLAUDE.md` 的 YJS/Chat 不变量第 7 条仍写"清理会话内容使用 `clearSessionDocContent`"**，与 `docs/arch/19-yjs-chat-streaming.md` 及当前实现冲突；以本文档 §8.5 第 7 条为准，`CLAUDE.md` 待同步。

## 9. i18n 国际化

技术栈：`i18next` + `react-i18next` + `i18next-browser-languagedetector`，经 `initReactI18next` 全局单例装配（**不是** Provider）。

### 9.1 使用

```tsx
import { useTranslation } from "react-i18next";
import { TASKS_V2_NS } from "@fenix/resource-task/web/i18n";

const { t } = useTranslation(TASKS_V2_NS);

t("title");                             // 扁平 key
t("form.name.label");                   // 点号分层
t("toast.saved", { name: item.name });  // 插值：双花括号
```

**插值必须用 `{{var}}`**。单花括号 `{var}` 会被 i18next 当作字面文本原样输出，是静默失败——界面上会出现裸露的 `{var}`。全仓仅 `model-management` 字典里 2 处 `{env:NAME}` 是**有意**的字面展示（配置占位符长相如此），除此之外不要引入单花括号。

### 9.2 命名空间与归属

命名空间与词条**归属 owner 包**，宿主只做装配：

```ts
// apps/web/src/i18n/index.ts —— 宿主只登记，不写域内词条
import { TASKS_V2_NS, tasksV2Resources } from "@fenix/resource-task/web/i18n";

const packageResources = { en: { ...tasksV2Resources.en, ... }, zh: { ... } };
const resources = { en: { ...hostResources.en, ...packageResources.en }, zh: { ... } };

i18n.use(initReactI18next).init({
  resources,
  ns: Object.keys(resources.en),   // ns 列表从已登记资源反推，不手写数组
  fallbackLng: "en",
  defaultNS: NS.COMMON,
  detection: { order: ["localStorage", "navigator"], lookupLocalStorage: "rcs-lang", caches: ["localStorage"] },
});
```

**新增命名空间的完整步骤**：

1. 在 owner 包内建 `packages/<group>/<pkg>/web/i18n/`，导出 `<DOMAIN>_NS` 与 `xxxResources`，经该包 `exports["./web/i18n"]` 公开。
2. **NS 常量与字典拆成两个模块**（`namespace.ts` 只持常量，`index.ts` 持资源）：`useTranslation(NS)` 不应把整份字典拉进模块图。
3. 宿主 `apps/web/src/i18n/index.ts` 的 import 与两张资源表里登记该包；`ns` 会自动派生。
4. 消费方从包出口取 NS：`import { TASKS_V2_NS } from "@fenix/resource-task/web/i18n"`，不写字面量。
5. 只有真正跨资源包共用的词条才进 `@fenix/web-runtime/i18n/namespace` 或 `@fenix/ui-components/i18n/namespace`。

> `@fenix/ui-components` 的 i18n 出口是 **`./i18n` 与 `./i18n/namespace`**（不是 `./web/i18n`），写后者会解析失败。原因见该包 `package.json` 的历史形态。

### 9.3 规则

- 禁止在 JSX 中硬编码用户可见字符串。
- 命名空间用包的 `NS` 常量，不写字符串字面量。
- 中文注释与 `console.log` 不受 i18n 限制。
- **en / zh 的 key 必须对称**；新增 key 时同批补齐两种语言，并同步包内 `web/__tests__/*-i18n.test.ts` 的基线。
- **日期、数字、相对时间必须取当前 locale**，不得在共享组件中固定 `zh-CN`。
- **API / domain 错误按稳定 error code 映射到 message key**；未知错误使用安全通用文案，**不展示 raw message**。Chat 域是样板（`public-error-text.ts` + 协议侧约束 + `public-error-i18n.test.ts`）。
- **纯逻辑模块与后端不得 import UI i18n 或图标依赖**（见 §10）。

### 9.4 现状偏离

- **全仓级 key 对称没有门禁**：资源包侧有 14 份 `packages/**/web/__tests__/*-i18n.test.ts`（覆盖"键集一致、占位符一致、`t()` 字面量键齐备、无越域泄漏"），宿主侧另有 `apps/web/src/__tests__/host-i18n.test.ts` 与 `public-error-i18n.test.ts`。覆盖面已不窄，但**跨包漏注册**仍无专门检查；`precheck` 也没有 i18n 步骤。
- **无 `i18nKey` 编译期类型**：没有 `CustomTypeOptions` 或键生成脚本，写错的 key 只有在运行时回退成字面量才被发现。
- **硬编码用户可见文案**：2026-09-23 的收口批次把 `agent-config/AgentSitesCard.tsx`（6 处）、`knowledge/ChunkDetailSheet.tsx`、`task/TasksPanel.tsx`、`task/TaskForm.tsx`（3 处）与 `ui-components/FileViewerPreview.tsx`（内置预览文案 + 错误边界提示）的文案全部改走各包字典（键分别落在 `agents` / `knowledge` / `tasksV2` / `uiComponents`）。剩下的两处是**有意保留**、且已登记的：`ui-components` 的 `html-plugin.ts`（标签「渲染预览」/「源码」与三条提示——插件直接操作 DOM、不在 React 树内）与 `preview-source.ts`（`文件预览加载失败 (<status>)`——纯逻辑模块不得 import UI i18n，见 §9.3）；两处接文案都要在契约上新增参数，影响范围与移除条件见该包 README「已知限制」第 12 / 13 条。
- **首屏静态加载全部语言与全部 namespace**，未按 route / feature 拆分懒加载。
- **语言切换没有 UI 组件**：检测、`rcs-lang` 持久化与 `fallbackLng` 都是宿主启动决策。

## 10. 样式

**默认用 Tailwind v4 工具类，别写 CSS。** 全部纪律就下面这些：

- **配置只在 CSS 里**：Tailwind v4 CSS-first，仓库没有 `tailwind.config.*`。token 写在 `@theme`，自定义工具类（`@utility`）**只在宿主** `apps/web/src/index.css`。
- **两个入口，两份副本**：宿主 `apps/web/src/index.css` 与包入口 `packages/ui-components/web/styles/theme.css`（经 `@fenix/ui-components/styles.css` 暴露）持有**逐字重复**的 token——含品牌色、`surface-0..3`、`text-bright/primary/secondary/muted/dim`、`status-*`、shadcn 语义族、布局变量（`--navbar-height` 等）与字体变量。改 token 必须同批改两份，**没有任何一致性测试兜底**。
- **`@source` 只扫 `packages/**/web/**`**：组件源码放错位置（如 `packages/<pkg>/components/`）其工具类**不会被生成**——症状是样式静默消失，不是报错。这条由 `scripts/__tests__/app-entry-paths.test.ts` 固化，也是 §1 那条硬规则的由来。
- **优先 token 类而不是 `dark:` 变体**：`dark:` 变体确实与 `.dark` token 块同源了（两个主题入口都已声明 `@custom-variant dark (&:where(.dark, .dark *))`，见 §3.2），但 `.dark` 在应用内无法被触发，写 `dark:` 等于写死一段不会生效的样式；仍应写 `bg-surface-1` / `text-muted`。
- **`cn()` 唯一来自 `@fenix/ui-components/lib/cn`**；宿主 `apps/web/src/lib/utils.ts` 的遗留副本与 `@/src/lib/utils` 别名已随 2026-09 去重删除，不要再建第二份。
- **独立 `.css` 文件只许四类**：① token 入口（`index.css`、`theme.css`）；② **第三方渲染覆盖表**，判据是第三方 DOM **没有 className 挂载点**且第三方 CSS **未分层**（当前唯一实例：`ui-components/web/components/preview/overrides.css`，它也是 `web/components/` 下**除类别 ③ 伴随表外**仅存的 `.css`）；③ **深层样式伴随表**——与源文件同目录、同名的 `.css`，承载**无法用扁平工具类表达**的选择器嵌套／复合表达式值／无标准变体的媒体查询（判据与口径见 `forbidden-code-patterns.md` §「存量清理结果」，门禁 `bun run check:web-style`）；④ 迁移未完成的历史页面级样式表——**不鼓励**，见下。
- **类别 ② 的三条约束**（照 `overrides.css` 文件头执行）：保留未分层、靠导入顺序取胜，**不要改写成工具类**；**拒绝 `!important`**（全仓现有 6 处 `!` 修饰工具类都属待清理遗留，不要增加）；覆盖选择器必须带第三方类名前缀（如 `ofv-*`）。
- **类别 ③ 的三条约束**：文件名与源文件严格同名同目录（`AgentEditorChrome.tsx` ↔ `AgentEditorChrome.css`），由持有该样式的模块顶部 `import` 引入；类名优先沿用源码注释里记录的**源选择器名**，否则用 `kebab-case` 语义名；**不包 `@layer`**（未分层才能压过 `@layer utilities`），但每处下沉都要逐条确认胜负关系没变——原写法若会被消费方 `className` 覆盖，就不能整条下沉。
- **新增 `.css` 的落位**：现有形态——`ui-components/web/chat/css/*.css`（3 份，模块级）、`web/styles/theme.css`（token）、**与源文件同目录同名的伴随表**（类别 ③）、以及与页面同目录的 `xxx.css`（历史遗留，类别 ④）。**新代码只用前三类**；确实必须写 CSS 时优先放组件同目录、命名与组件同名，不要新增页面级样式表。
- **图标**：通用图标只用 `lucide-react`，**禁止内联 SVG**；模型图标走 `<ModelIcon modelId size variant>`（`model-management/web/components/model-icon/ModelIcon.tsx`），**禁止直接 `import "@lobehub/icons"`**（`model-icon-boundary` 规则强制，见 §11.2）。**纯逻辑模块不得依赖 UI 图标包**（后端与纯逻辑测试也不得**间接**加载）——`@lobehub/icons` 依赖 `antd-style`，后者在模块加载期裸调 `matchMedia`，无 DOM 的 `bun test` 进程里加载即崩。
- **字体**：系统字体栈，**禁止外部字体链接与 `@font-face`**；`--font-sans` / `--font-display` / `--font-body` 三者同值，`--font-mono` 独立，均应用在 `html, body`。
- **禁止 `@apply`**（当前零使用，不要引入——它会把"工具类 vs CSS"变成第三种说不清的形态）。

### 10.1 现状偏离

- ~~**`dark:` 变体与 `.dark` 类不同源**~~ 已消解（2026-09-23）：两个主题入口都声明了 `@custom-variant dark (&:where(.dark, .dark *))`，`dark:` 变体与 `.dark` token 块同源；30 个文件里的 `dark:` 一律保留但在应用内不会命中（系统深色偏好不再能让它们生效）。全站强制亮色见 §3.2。
- **页面级 `.css` 大量残留且无登记**（实测于 `f73f9265`，2026-09-23；重跑下面那条命令即可复算）：宿主 `apps/web/src` **5 份 / 1811 行**（含 `shell/agent-panel.css` 677 行、`shell/artifacts-workspace.css` 376 行、`pages/auth-light-brand.css` 371 行）、资源侧 `packages/**/web` **12 份 / 2416 行**（含 `workflow/workflow.css` 640 行、`task/.../agent-tasks.css` 480 行、`model-management/.../agent-models.css` 278 行、`knowledge/.../agent-knowledge.css` 268 行、`platform/identity/.../agent-api-keys.css` 209 行）。它们与业务 tsx 里的自定义类名联动（如 `agent-tasks-page`），迁移时两者必须同批改。

  **计数口径**（就是 §10 四类里**剩下的那一类**，排除项逐条对齐类别 ①②③）：

  - **计入**：`apps/web/src/**/*.css` 与 `packages/**/web/**/*.css` 中**没有同目录同名 `.tsx` / `.ts` 兄弟**的 `.css`；
  - **排除**：① token 入口 `apps/web/src/index.css`（781 行）与 `ui-components/web/styles/theme.css`（272 行）；② 第三方覆盖表 `ui-components/web/components/preview/overrides.css`（43 行）；③ 类别 ③ 伴随表 **67 份 / 3830 行**（63 份配 `.tsx` 兄弟、4 份配 `.ts` 兄弟；2026-09-23 删除 `memory/web/pages/hindsight/components/CompactMarkdown.css`（27 行、配 `.tsx` 兄弟）后就地重跑本节命令所得，此前为 68 份 / 3857 行）；④ `ui-components/web/chat/css/*.css`（3 份 / 148 行，模块级表，§10 单列）；
  - **口径外**：`ui-sandbox/`（独立演示应用）、`docs/**`（VitePress 主题）、`e2e/playwright-report/**` 与 `tmp/**`（产物与临时目录）、`.worktrees/**`、`node_modules`/`dist`，以及 `packages/ui-components/demo/demo.css`（包内 demo，不在 `@source` 扫描范围内）；
  - **边界一例**：`ui-components/web/chat/primitives/conversation-scroll.css` 的源文件叫 `conversation.tsx`（不同名），按上面的机械规则落进本类——它是模块级表而非页面表，这是机械规则的已知代价。

  ```bash
  # 逐文件分类 + 汇总（仓库根目录执行；输出即上面四类的份数与行数）
  { find apps/web/src -name '*.css' -not -path '*/node_modules/*' -not -path '*/dist/*'
    find packages -path '*/web/*' -name '*.css' -not -path '*/node_modules/*' -not -path '*/dist/*'; } | sort | while read -r f; do
    base=${f%.css}
    if [ "$f" = apps/web/src/index.css ] || [ "$f" = packages/ui-components/web/styles/theme.css ]; then kind=token
    elif [ "$f" = packages/ui-components/web/components/preview/overrides.css ]; then kind=override
    elif [[ "$f" == packages/ui-components/web/chat/css/* ]]; then kind=chat-module
    elif [ -f "$base.tsx" ] || [ -f "$base.ts" ]; then kind=companion
    else kind=page; fi
    printf '%s\t%s\n' "$kind" "$(wc -l < "$f" | tr -d ' ')"
  done | awk -F'\t' '{n[$1]++; l[$1]+=$2} END {for (k in n) printf "%-12s %2d 份 %5d 行\n", k, n[k], l[k]}'
  ```

  **别用「上次的数字 ± 本批增删」维护这两行**：v3.0.5 记下的「伴随表 66 份 / 3348 行」，66 取自 `21a8bffa` 提交信息「新增伴随表 66 份」那句——那是**该次下沉新增的文件数**（该提交前全仓只有 1 份伴随表，提交后全仓实测 66 份 / 3499 行，3348 行对不上），v3.0.7 再按「删掉一张 513 行的表」做加减得 67 份 / 3391 行，于是与实测一路偏离（v3.0.8 重测为 68 份 / 3792 行、`f73f9265` 重测为 68 份 / 3857 行）。**改这一节就重跑上面的命令**，不要接着算。

  2026-09 的 Tailwind 迁移已把此前的基数压下来（`agent-editor.css` / `-design.css` / `-responsive.css` 三表随 `bfd63e52` 删除；`agent-panel.css` 由 919 行降到 677、`artifacts-workspace.css` 由 664 行降到 376；`agent-organizations.css` 513 行随 2026-09-23 的组织页工具类转换整片删除，只留同目录同名的伴随表 `agent-organizations-workspace.css`——本批由 43 行扩到 92 行，随后 `f73f9265` 删去其中为目录写的三条覆盖后为 **57 行**），但**剩余部分仍未登记**。
- **`tw-animate-css` 声明了依赖但源仓库从未 `@import` 它**（只在包内 demo 的 CSS 里导入过），因此 shadcn 过渡动画工具类在应用中是空操作（已在 `ui-components` README 登记）。包内已知限制的完整清单见 `packages/ui-components/README.md`，以那里为准，不在此重复。

## 11. 开发落地清单

### 11.1 提交前自检

- [ ] **`bun run precheck` 通过**（15 步，见 §11.2）
- [ ] **前端改动额外跑 `bun run build:web`**（后端从 `apps/web/dist/` 挂载静态资源，类型检查通过 ≠ 构建通过）
- [ ] `precheck` 覆盖不到的前端测试已单独跑：`bun test apps/web/src/__tests__/`
- [ ] 每个 `test(...)` 上方有一行中文注释说明行为与业务意图
- [ ] 用户可见字符串全部走 `t()`；插值用 `{{var}}`；en / zh key 对称
- [ ] 导航使用 `useNavigate()` / `<Link>`，未使用 `window.location` 写操作
- [ ] 新增页面：路由壳放 `apps/web/src/routes/agent/_panel/`，页面实现放 owner 包 `web/pages/` 并经懒加载引入（见 §2.5）；已在 `web/contribution.ts` 加导航项并补包字典
- [ ] 新增路由后跑过一次 dev 或 build（`routeTree.gen.ts` 才会重生）
- [ ] API 调用经域模块，且已 `unwrap()` 或显式判断 `success`；组件中无裸 `fetch`、无自拼后端 URL
- [ ] 失败没有被映射成 empty 或成功状态
- [ ] 跨包引用经各包 `exports`；未新增指向 `packages/**` 的别名；vite 与根 tsconfig 两张别名表同步
- [ ] 单文件未超 500 行
- [ ] Loading 态有骨架屏守卫；Empty 态有占位提示
- [ ] 表单使用 `FormDialog` + `formConfig`（react-hook-form + zod），不手写 `useState` 校验
- [ ] Dialog `onOpenChange` 中清理状态；表单重置用 `key`
- [ ] 无 `dangerouslySetInnerHTML` 不经清洗使用；新增 iframe 显式声明 `sandbox`
- [ ] 无 API Key / Token 存入 localStorage；无原生 `confirm()`
- [ ] 改动过 UI 结构时：`packages/ui-components` 的 `web/index.ts` 与 `exports` 已同批更新

### 11.2 自动化检测

**`bun run precheck` = `scripts/ci.ts` 的 15 步**，顺序为：format → import-sort → `generate:module-registry --check` → `generate:web-contributions --check` → `check:root-owner-inventory` → `check:schema-ddl-drift` → `architecture` → tsc(server) → tsc(web) → tsc(app skeletons) → `check:dependencies` → lint → 三批 `bun test`（`apps/server/src/__tests__/ scripts/__tests__/ packages/platform/platform-sdk/src/__tests__/`、`packages/`、`apps/web/src/__tests__/`）。

其中三处与前端直接相关：

#### 硬红线（`scripts/check-architecture.ts`，零容忍）

| 规则 id | 约束 |
|---------|------|
| `browser-entry-server-import` | 浏览器生产代码（`apps/web/src/**`、各包 `web/**`）不得导入 `node:*`、`@server/*`、`@fenix/chat-channel/server`；测试代码可使用服务端测试工具 |
| `package-no-internal-imports` | 跨 workspace 包不得绕过公开导出访问 `@fenix/*/src/*`、`@fenix/*/web/src/*`，也不得用相对路径越界到其他包的 `src/`、`web/src/`、`db/` |
| `zod-v4-entrypoint` | Zod 必须从 `zod/v4` 导入 |
| `model-icon-boundary` | `@lobehub/icons` 只能由 model-management 的 `model-icon` 组件封装 |
| `frontend-no-legacy-api-prefix` | 经 `request()` 调用时不得使用 `/v1`、`/v2` 历史前缀 |
| `backend-no-route-imports` | （后端）Service / Repository 不得反向依赖 Route |

#### 边界规则（台账制，`scripts/lib/architecture-boundary-rules.ts`）

`undeclared-workspace-dependency`（导入 workspace 包但未声明依赖）、`apps-boundary`（`packages/**` 不得依赖各 app）、`special-dependency`（跨类别依赖矩阵 + 具体包禁则）、`web-package-not-to-app`（`packages/**/web/**` 不得用宿主别名或相对路径越界到 `apps/web`）。

这四条是**台账制**：只有**未登记的新增违规**才失败，豁免清单在 `scripts/architecture/exceptions.json`（逐条带 owner 与移除条件）。**已不再违规的条目要求删除**——修好问题后必须同步清理台账，不要让豁免过期。

#### dependency-cruiser（`bun run check:dependencies`）

规则名：`no-circular`、`no-cross-package-src:<pkg>`（每包一条）、`no-cross-package-db:<pkg>`（每包一条）、`platform-not-to-agent-runtime-resources-apps`、`agent-runtime-not-to-resources`、`ce-not-to-ee`（`<pkg>` 取的是工作区路径，如 `no-cross-package-src:packages/resources/task`）。它以**仓库根的 `tsconfig.json` 的 `paths`** 作为别名判定基准（见 §1.2）。

#### 浏览器安全入口守卫

各包的 `web/__tests__/*-browser-surface.test.ts`（当前 13 份，全在 `packages/resources/*`；`chat-channel` 的对应文件在 `src/__tests__/`）静态走根出口的**值导入图**，断言图中不出现服务端模块与 `node:*`。**新增包外运行时依赖时必须同步登记到该测试的白名单**——否则守卫会在别人的改动里失败。

#### 前端测试约定

- 框架是 **`bun test`**（无 vitest / jest）；`bunfig.toml` 只 preload 服务端侧垫片，**没有全局 DOM**。
- 需要 DOM 的用例自建 happy-dom Window，唯一入口是 `@fenix/ui-components/testing` 的 `initializeHappyDomWindow`（`HTMLElement` 与 `customElements` 必须**成对**注入，否则 streamdown 链路在用例之间崩）。
- 只测关键交互、状态与数据流，不写纯 UI 结构断言或仅重复类型检查的测试。
- **DOMPurify 在 happy-dom 下清洗不动，别写「渲染后的 HTML」类断言**（2026-09-23 实测，原因见 §6.5 末条）：`DOMPurify.sanitize()` 在本环境要么把节点当成白名单外、要么只处理到第一次节点移除为止，断言会测到桩行为（既可能假绿也可能假红）。清洗相关用例只断言**白名单内容与接线**，参考 `knowledge/web/__tests__/sanitize-html.test.ts`。
- **`react-i18next` 替身必须返回稳定的 `t`**：真身的 `t` 只在切语言时换身份，替身不能在 `useTranslation()` 里每次渲染新建对象或函数。"把 `t` 写进 `useCallback` 依赖、再用该回调喂 `useEffect`"的组件一旦碰上不稳定替身就会陷入反复拉取，**生产不复现**——纯属替身造成的假阳性（2026-09-22 在 `workflow/web/__tests__/workflow-versions-a11y.test.tsx` 上踩到，表现是 3 个用例 5s 超时，曾被误判成并发改动）。当前仍有 10 份 mock 用 `useTranslation: () => ({ ... })` 的写法，改到相关组件时顺手收口。
- **radix `Portal` 内容在 happy-dom 用例里挂不上，别写「弹窗内的 XX」类断言**（2026-09-23 实测）：`@radix-ui/react-use-layout-effect` 在**模块求值期**用 `globalThis.document` 决定是否使用 `useLayoutEffect`，而用例注入 DOM 全局必然晚于静态导入（`bun test` 同进程内先求值哪个测试文件还不确定），portal 于是永远不渲染——`ReactDOM.createPortal` 到同一个 `document.body` 却是正常的，说明卡点在 radix 而非 happy-dom。要覆盖弹窗**里的**分支时，把断言移到弹窗内容所复用的子组件上（如 `MemoryDetailPanel`），弹窗自身只断言取数是否发出、失败是否记录；也可以像 `workflow/web/__tests__/workflow-data-fetching.test.tsx` 对 Popover 那样，`mock.module` 出一份**保持 open/onOpenChange 语义**的就地渲染替身（同批 `ConfirmDialog` / `Sheet` 的先例），调换的只是 portal，弹层内分支因此可断言。

### 11.3 尚未自动化的规则

以下靠人工 review，不靠工具兜底：

| 规则 | 现状 |
|------|------|
| 组件中裸调 `fetch()` / `XMLHttpRequest` | 未自动化；现有例外点是登记制（§5.3） |
| 直接 `await` 域模块不解包 | 未自动化，签名层面无法区分 |
| `window.location` 写操作 | 无**全仓**门禁（当前生产代码零命中；`workflow/web/__tests__/workflow-page-route.test.ts` 只守 workflow 页面，`ui-components/web/testing.ts` 里的一处属测试工具） |
| `dangerouslySetInnerHTML` 不经清洗 | 未自动化。2026-09-23 复核：**3 处**（knowledge 的 docx / 切片 / 检索高亮）全部经 `web/lib/sanitize-html.ts` 的显式白名单，无一处用 DOMPurify 默认配置；白名单内容与三处接线由 `knowledge/web/__tests__/sanitize-html.test.ts` 钉住 |
| `localStorage` 读写组织身份 | 未自动化（当前 2 处违规，见 §3.6） |
| 原生 `confirm()` / `alert()` / `prompt()` | 未自动化。2026-09-22 已全量复核：全仓零命中（4 处已迁 `ConfirmDialog`）；新增只能靠 review |
| `console.error` 缺配对用户可见反馈 | 未自动化，判据见 §5.8；2026-09-22 全量复核后仍有已知残留（见 §5.9）。**错误边界是已豁免的一类**（§7.1：降级 UI 本身就是反馈） |
| 错误边界的放置矩阵（§7.1） | 未自动化：**新增页面 / 面板是否包裹仍靠 review**。2026-09-23 已落地五处（`__root.tsx` / `_panel.tsx` / `ChatPanel` / `ArtifactsPanel` / `AgentSidebar`），降级链路的两条不变量由 `ui-components/web/__tests__/error-fallback.test.tsx` 与 `apps/web/src/__tests__/error-boundary-fallback.test.tsx` 钉住（见 §7.3） |
| iframe 的 `sandbox` 取值 | 未自动化。2026-09-23 复核现状：`IframePreview`（Markdown / Agent 输出）为 `allow-scripts allow-popups` 且 `src` 过协议白名单、`sandbox` 不可被 props 覆盖，有包内用例；`SiteFrame` / `AgentSitesCard`（用户自己的站点）保留 `allow-same-origin` 但带 `referrerPolicy`；knowledge 的 HTML 预览（UGC）为 `allow-scripts`；office 转 PDF 的同源预览无 `sandbox`（风险低） |
| 单文件 500 行上限 | 未自动化（当前 16 处超限，见 §4.8） |
| 组件重复开发检测 | 未自动化（当前 2 处本地重复实现，见 §4.8） |
| i18n 全仓 key 对称、`[object Object]` | 包级与宿主各有测试（14 份 `packages/**/web/__tests__/*-i18n.test.ts` + `ui-components` 的 `i18n-barrel.test.ts` + 宿主 `host-i18n.test.ts`），**跨包漏注册**无门禁（见 §9.4） |
| import 分组顺序、格式化 | 已由 Biome 覆盖（`import-sort` + `format`） |
