# Chat 会话恢复缺陷清单

> 性质：**已确诊、待修复**的缺陷登记（只记现象与已证实机制，不含修复方案）。
> 证据等级：下列机制均为**静态代码证据，未运行时复现**；运行时判别信号见各节末。
> 行号基准：工作区当前内容（HEAD `0afc2244`），仅作定位辅助。

## I1 · 离开 agent 壳再返回，历史会话记录消失

**现象**：Agent 下已有历史会话，离开整个 agent 壳后返回，会话记录（时间线）消失。

**复现路径**：切到其他模块页面——非 `/agent/*` 同壳切页，即 ChatPanel 真卸载、WS 断开、本地 Y.Doc 销毁——再点最左侧树的 **Agent 主行**（不带 `instanceUid`）返回，走冷恢复。

**根因链（已证实）**：不是单一机制，而是 (a) 与 (b′) 的串联；(c) 是与数据无关的显示干扰项。

**(a) 入口条件：主行进入的是默认实例，与「上次访问的实例」无关**

主行点击不传 `instanceUid`（`AgentSidebarTree.tsx:193`），实例子项才传（`:315`）。默认实例判据固定为 `creationSource=user + name=default + isDefault=true`（`agent-instance-service.ts:46-53`、`:138-149`、`:243-259`；`agent-instance.ts:65-85`）；自建实例是 `name=instance-<uuid>`、`isDefault:false`（`instances.ts:98-103`）。返回结果回写 URL（`use-agent-sidebar-tree.ts:164-171`、`:181`；`DefaultAppShell.tsx:96-110`），该 URL 段即 `instanceUid` 并决定 `rcsSessionId`（`use-chat-panel-runtime.ts:132-133`、`:263-268`；服务端校验 `routes/acp/index.ts:305-314`）。因此上次在自建实例的用户，主行点击**必然**回到默认实例，旧实例 Doc 不可达。典型观感是「列表还在、点进去没内容」：workspace 路径只由 org + user + environment 决定、不含 instanceUid（`workspace-resolver.ts:20-22`），Claude 从该 cwd 全量恢复会话（`claude-acp-adapter.ts:267-270`、`:544-553`）。

**(b′) 内容为空的直接原因：空 Doc 被路由到 `load_session`，而引擎不支持 load**

`chat-writer.ts:448` 的 `caps.set(key, Boolean(value))` 把 `sessionCapabilities` / `promptCapabilities` / `mcpCapabilities` 三个嵌套对象折成布尔 `true`；前端只还原出扁平布尔（`chat-state-derivation.ts:123-127`）。于是 `supportsLoadSession = !!(caps?.loadSession || caps?.sessionCapabilities)` 恒为 `true`（`use-chat-panel-runtime.ts:349`），而 `ChatPanel` 只传了 `supportsLoadSession`、**从未传 `supportsResumeSession`**（`ChatPanel.tsx:188-189`），ACPMain 该 prop 默认 `false`（`ACPMain.tsx:145`）→ bootstrap 永远走 load 分支（`use-acp-session-bootstrap.ts:100-113`）。Claude 引擎声明 `loadSession: false`（`claude-acp-adapter.ts:276-281`）→ 转发被拒（`acp-dispatcher.ts:457-460`、`acp-link/src/server.ts:1283-1286`）→ 换代已发生但无回放（`session-channel.ts:319-351`）→ 消息区永久空。**同一折叠也破坏 `supportsImages`**（`use-chat-panel-runtime.ts:339-340`）：composer 粘贴图片失效（已按上传兜底修复，commit `0afc2244`）与本 issue 同根因。

**(c) 左树默认折叠——与数据无关，仅造成「看不到条目」**

展开态是组件内 state（`AgentSidebarTree.tsx:91`），整壳重挂载即归零；折叠时实例列表不渲染（`:165-166`、`:296-300`）。这是**看不到条目**而非条目消失，展开即恢复。

**降级或推翻的上一轮说法**

- 「`resume_session` 不走换代与提前绑定」：真实代码不对称，但当前宿主不可达（resume 路径未接线），**不是本次成因**。
- 「Redis 快照异步加载无就绪屏障」：**降权为可自愈竞态**——晚到快照仍会广播（`doc-manager.ts:126-130`、`broadcaster.ts:131-143`，update 监听不过滤 origin）；残留的永久风险是 generation 已变时快照被直接丢弃（`redis.ts:311`）。
- 「列表 20 条裁剪 + 删除未返回条目」：成立，但**只解释「部分历史条目消失」**，不解释「内容为空」；日志 `sessions listed: total/filtered/returned`（`acp-link/src/server.ts:1252-1257`）可用于证实。

**运行时判别信号**（两步归分支）

1. 比对返回前后 URL 与服务端 `[YJS-WS] Opening ... instanceUid=`（`routes/acp/index.ts:325`）：不同 → (a) 成立。
2. 同实例下：列表有条目 + 消息 0 条 + 出现错误卡片 → (b′) 的 load 被拒签名；Session Doc 中 `agent.capabilities.sessionCapabilities` 是布尔 `true` 而非对象 → 折叠已发生。

**修复方向**：两条一起才完整——投影层保留嵌套结构（同步 `SESSION_DOC_SCHEMA_VERSION`）+ 宿主补齐 `supportsResumeSession` 接线。相关不变量：确定性 `rcsSessionId`、同 ACP session 跳过重复回放、换代而非 clear + replay、`AgentSidebarTree` 是 `memo`（改 props 需同步 comparator）。

## I2 · 进入 chat 页经常需要重连（刷新或点侧边栏才正常）

**现象**：进入 chat 页面经常停在需要重连或空白状态；刷新整页、或手动点侧边栏后恢复正常。

**已证实的缺口**

1. **bootstrap 把「尝试」当「成功」**：先置 `sessionEnteredRef` 再调 `handleSelectSession`（`use-acp-session-bootstrap.ts:163-168`、`:180-185`、`:217-227`）；能力未到达时该调用被守卫直接返回、不算失败（`:100-107`）；发送回调是 void 签名，失败只出 toast / 错误卡、不回流失败结果（`use-chat-panel-runtime.ts:364-392`、`:313-318`）。后续能力或列表到达时被该 ref 拦住，不再补发（`:148-149`）。刷新（新 hook，ref 归零）或手选会话（不经守卫，`sidebar-session-list.tsx:217`）能补上。
2. **重试耗尽后 UI 仍可能长期显示「重连中」**：退避 1/2/4/8/16/30 秒、连续不稳定断开 6 次即停止自动重连（`ws.ts:18-23`、`:254-277`、`ws-close-codes.ts:52-98`），而 runtime 每次 `onClose` 都置 `autoReconnecting=true`，收到 `error` 时不清除（`use-chat-panel-runtime.ts:284-307`、`ChatPanel.tsx:138-140`、`:204-209`）。
3. **load / resume 能力接线不正确**：`supportsLoadSession` 取 `caps.loadSession || caps.sessionCapabilities`（`use-chat-panel-runtime.ts:349`），ChatPanel 未传 `supportsResumeSession`（`ChatPanel.tsx:182-198`），ACPMain 默认 `false`（`ACPMain.tsx:143-145`）。对「支持 resume、不支持 load」的 Agent 会误判并错发——与 I1 (b′) 同源，此处后果是进入时即错发，而非消息区为空。
4. **status 门禁缺超时与降级**：`list_sessions` 仅在 `agentStatusReceived` 后放行（`session-channel.ts:205-208`），就绪 status 要求 `capabilities` 非空（`relay-event-handler.ts:455-465`、`:496-508`），轮询跳过只累计计数、不放弃（`gateway.ts:176-197`），pending 重放同样跳过 `list_sessions`（`action-forward.ts:46-56`）。status 始终不就绪时，列表永不加载。

**待运行时确认**：WS Close code；`instanceUid` 是否变化；Agent 实际 capabilities 与 status 帧序列。

**修复方向**：与 I1 一并收敛。

---

**复核说明**：本文 `文件:行号` 已按工作区当前内容逐条抽查，其中 I1 的守卫区间由 `:96-105` 修正为 `:100-107`（96-99 为注释）。运行时时序（WS close code、帧序列、URL 变化）尚无运行时证据，已分别归入各节的「运行时判别信号」与「待运行时确认」。
