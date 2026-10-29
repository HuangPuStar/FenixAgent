# P1：活动链在本轮加载期间反复自动收起与展开

**状态**：已确认，待修复。
**优先级**：P1。
**类型**：回归。
**创建日期**：2026-10-29。
**来源**：用户报告（`/fix-bug`）。
**确认方式**：explorer 只读确认 + 主 agent 复核（基线 `85ff5542d`）。

## 确认证据

- 用户报告：聊天流式输出期间，活动链本应保持展开，实际「偶尔关闭，偶尔展开」。
- `packages/ui-components/web/chat/lib/activity-chain-summary.ts:70-83` 的 `isActivityChainActive()` 第三条件要求链的最后一项是「助手消息且等于会话末条条目」；链最后一项是 `tool_group` 时直接返回 false。
- `packages/ui-components/web/chat/view/ActivityChain.tsx:95-98`：用户未手动干预时 `expanded = active`，`active` 翻转即整条链收起/展开，折叠体不参与渲染（非视觉隐藏）。
- ACP 事件到条目的投影顺序（均为已核对代码）：
  - `packages/chat-channel/src/state/aggregator.ts:243-294` 工具状态写 `running | completed | error`；
  - `packages/web-runtime/web/chat/chat-doc-to-structured.ts:357-364` 与 `structured-to-thread.ts:67-88` 把 `completed → complete`；
  - `packages/ui-components/web/chat/lib/chat-render-layout.ts:38-95` 把连续工具与 thought-only 助手消息合成一条活动链。
- `packages/chat-channel/src/state/chat-writer.ts:548-587`：`loading` 在 `accepting | running | cancelling` 期间非空，`awaiting_permission` 与终态为 null；`packages/ui-components/web/chat/shell/ChatInterface.tsx:115` 直接以 `loading != null` 作为 `isLoading`，同一轮内除权限等待外保持为 true。
- 现有测试固化了旧契约：`packages/ui-components/web/__tests__/activity-chain-summary.test.ts:96-99` 明确断言「加载中但末项为终态工具」应视为已结束（false）。

## 根因链

1. 触发：本轮正在加载（`isLoading = true`），链内最后一个工具从 `running` 变为 `complete`，下一个可渲染条目尚未到达。
2. 机制：`isActivityChainActive()` 不再命中「有运行中工具」，且链最后一项是 `tool_group`，无法命中第三条件 → 返回 false；`ActivityChain` 随即将 `expanded` 置为 false，折叠体整段卸载。
3. 下一个工具开始执行（`running`）或新的助手条目到达 → 条件重新成立 → 重新展开。
4. 用户可见后果：一轮里每完成一次工具调用就收起一次，下一次工具启动又展开；工具密集的轮次表现为持续闪断，用户无法稳定观察执行过程。（推断：未在运行时录制 DOM 时间线，依据为用户报告与上述代码路径。）

补充：`tool_call` 事件之后若先到达 plan 条目，`buildChatRenderItems` 会跳过 plan（`chat-render-layout.ts:49`），但它会成为 `visibleEntries` 的末条；若仅放宽为「末条在本链内」，此场景仍会收起，故需在 `ChatView` 侧把「会话末条条目」收敛为「最后一条可渲染条目」。

## 影响面

- 用户影响：主聊天面板（所有 agent 会话）流式输出过程块的展开/收起不稳定，工具密集的轮次最明显；折叠期间看不到正在进行的工具行。
- 受影响模块/调用点：
  - `packages/ui-components/web/chat/lib/activity-chain-summary.ts:70-83`（判定函数）；
  - `packages/ui-components/web/chat/view/ChatView.tsx:167`（传入 `lastEntry` 的位置）；
  - `packages/ui-components/web/chat/view/ActivityChain.tsx:95-98`（消费方，不改逻辑）。
  - trace 资源包自绘对话气泡，不引用该组件，不受影响（`packages/resources/trace/web/components/detail/chat-view.tsx`）。
- 是否可规避：可手动展开，但每次工具切换后仍需再次点击。

## 修复方案

- 范围：
  1. `isActivityChainActive()` 的第三条件由「链最后一项是末条助手消息」放宽为「会话末条可渲染条目属于本链」；仍以 `isLoading` 为前提，保留「旧链不展开」。
  2. `ChatView` 计算「最后一条可渲染条目」（跳过 `plan`）并作为 `lastEntry` 传入，避免 plan 条目落在末尾时误折叠。
  3. 更新/新增回归测试：
     - `activity-chain-summary.test.ts`：改写 96-99 的旧断言；补「工具已 complete 但末条在本链内 → true」「旧链（末条在别的链）→ false」「末条为 plan 时不算本链（由 ChatView 过滤，纯函数输入不含 plan）」。
     - `activity-chain.test.tsx`：补组件级用例「工具 complete + isLoading → 展开」「同一轮两条链只展开最后一条」。
- 明确不做：
  - 不改变「本轮结束立即自动折叠」的口径；
  - 不改变思考块（`reasoning.tsx`）的 1 秒自动折叠；
  - 不做手动状态的会话级持久化（仍仅当前链生命周期）；
  - 不改 ACP/后端投影。
- 回归测试：上述两个测试文件。

## 验收标准

1. 一轮加载中，工具完成到下一动作之间的空档，活动链保持展开；plan 条目落在末尾时同样保持展开。
2. 同一轮出现两条活动链时，只有最后一条随加载展开，前一条保持折叠（除非其内部仍有运行中工具或用户手动展开）。
3. `bun test packages/ui-components/web/__tests__/activity-chain-summary.test.ts packages/ui-components/web/__tests__/activity-chain.test.tsx` 通过。

## 验证记录

- `bun test packages/ui-components/web/__tests__/activity-chain-summary.test.ts packages/ui-components/web/__tests__/activity-chain.test.tsx` → 16 pass / 0 fail（44 expect）。
- `bun run fastcheck` → ✓ All passed（70745ms，ui-components 1093 pass / 108 files）。
- `git diff --check` → 无输出。
