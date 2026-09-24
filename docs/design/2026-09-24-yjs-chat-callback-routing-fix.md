# Yjs Chat 聚合：无 turnId 帧（回显 / 历史回放 / 异步回调）路由错位修复方案

- 日期：2026-09-24
- 范围：`packages/chat-channel`（relay 事件分类层 + 聚合层），不改前端、不改 acp-link
- 行号基准：**工作区当前文件内容**（HEAD `9cd1328b` + 少量在途改动；`aggregator.ts` / `doc-manager.ts` / `schema.ts` / `session-channel.ts` / `claude-acp-adapter.ts` 在写本方案时已有小改动，本方案的两个主要改动点 `relay-event-handler.ts` 与 `connection-types.ts` 无在途改动）。引用优先看函数名，行号仅作定位辅助。
- 相关历史：`b253e3684 fix: 隔离异步回调消息历史`、`2fefaca8 fix(chat): 修正会话切换后消息区空白`

## 1. 现象与证据

用户侧报告（原文）：后端 yjs 的聚合还有聚合到上一条的情况；「yjs 新生成的 user 数据聚合到了上一个 user，但是两个 user 之间已经隔了非常远，不知道是不是没有 id 的原因」。

复现脚本 `scratch-yjs-repro.ts`（模拟真实 relay 帧序列，`bun run scratch-yjs-repro.ts`）输出：

场景 1（实时两轮 + Agent 用户消息回显，窗口外）：

```
0 turn_X:user                        user      turnId=turn_X        completed  第一条消息
1 turn_X:assistant                   assistant turnId=turn_X        completed  (空)
2 callback_6e861d34-...              user      turnId=null          completed  第一条消息   <- 复制条目
3 callback_6e861d34-...:assistant    assistant turnId=null          streaming  回答1        <- 卡在 streaming
4 turn_Y:user                        user      turnId=turn_Y        completed  第二条消息
5 turn_Y:assistant                   assistant turnId=turn_Y        completed  (空)
6 callback_5ae67ca4-...              user      turnId=null          completed  第二条消息
7 callback_5ae67ca4-...:assistant    assistant turnId=null          streaming  回答2
```

场景 4（回显缺失/被跳过时的后续无 turnId 增量）：

```
2 callback_bf52b564-...              user      turnId=null          completed  第一条消息
3 callback_bf52b564-...:assistant    assistant turnId=null          streaming  回答一回答二  <- 第二条消息的回答并入上一条
4 turn_1790213...qb046ir8:user       user      turnId=turn_...      completed  第二条消息
5 turn_1790213...qb046ir8:assistant  assistant turnId=turn_...      completed  (空)
```

场景 3（窗口仍开）：形态正确（history 与实时各自成对，无 callback 条目）。

结论：用户看到的「聚合到上一条、且隔着非常远」就是场景 4 形态；「没有 id」对应这些 `turnId=null` 的 `callback_*` 条目。

## 2. 根因（证据链）

无 turnId 帧的归属完全依赖 relay 级可变状态 `shared.callbackAssistantEntryId`，且该状态的**建立条件过宽、失效条件过窄**。

1. 建立（过宽）：`relay-event-handler.ts:747-750`

   ```ts
   if (!inReplayWindow && event.type === "user_message" && !event.turnId) {
     const callbackEntryId = `callback_${crypto.randomUUID()}`;
     shared.callbackAssistantEntryId = callbackEntryId;
     event = { ...event, callbackEntryId };
   }
   ```

   窗口外**任何**无 turnId 的 `user_message` 都被判为「异步回调」。但无 turnId 的 `user_message` 实际有三种来源：
   - 实时 prompt 回显：`protocol-adapter.ts:165-177`（SDK `user` 消息逐 text block 产出 `user_message_chunk`，经 `acp-channel.ts:109/132` 规范化为 `user_message`）；
   - 历史回放：`claude-acp-adapter.ts:617-661`（`unstable_resumeSession` 把整个历史逐条回放为 chunk 帧）；回放窗口只有 10s（`connection-types.ts:19`），窗口过期后仍到达的回放帧落到本分支；
   - 真异步回调（Peri callback）：本分支的正主。

2. 失效（过窄）：`relay-event-handler.ts:751-763` 只在**不带 turnId 的终态**上清空指针。而实时 prompt 的终态必然带 turnId（`relay-event-handler.ts:276-282` 按 `pendingPromptTurns` 回填），故：
   - 指针建立后长期存活；
   - 该指针指向的 `callback_*:assistant` 也永远收不到终态（`aggregator.ts:483-492` 的 callback 收敛分支要求事件带 `callbackEntryId`，带 turnId 的终态不进该分支），状态永久 `streaming`。

3. 消费：`aggregator.ts:203-211` 把后续所有无 turnId 增量写进 `${callbackEntryId}:assistant`；`aggregator.ts:136-147` 的 callback 分支还会为新的无 turnId user_message 建一对 `callback_*` 条目。

叠加结果：
- 缺陷 A（场景 1/2）：实时回显被当作异步回调 → 用户消息多出一条 `callback_*` 复制条目，本轮回答写进 `callback_*:assistant`，真实 `turn_X:assistant` 恒空且 `callback_*:assistant` 永久 `streaming`。
- 缺陷 B（场景 4，即用户报告）：回显缺失（resume 后 `claude-acp-adapter.ts:437` 的 `skipReplay` 会跳过本轮回显）时，新一轮的无 turnId 增量被盖上**上一轮遗留的指针**，回答被追加进很久以前那条 `callback_*:assistant`；指针此后仍不清空，后续每一轮继续往同一旧条目里灌（「还有」的来源）。

补充：`relay-event-handler.ts:666` 的注释已经记录了「助手增量落到上一轮 entry」这一现象，但只是靠 10s 回放窗口绕开，根因未解决。

## 3. 设计目标与必须保持的不变量

不变量（回归红线）：
1. 用户消息（`docManager.registerUserMessage`）只产生**一个** user entry，不重复、不与他条合并。
2. 无 turnId 帧不得凭空丢内容：真正的异步回调（文档里不存在同文本 user entry 的自由消息）必须仍能显示。
3. 异步回调流与实时 turn 的增量不得互相串写：回调到达时正在跑实时 turn 的场景（`b253e3684` 的原始意图）必须仍被隔离。
4. 聚合层仍是唯一写 Y.Doc 的地方；relay 只做「帧分类 + 上下文补全」，不得直接写 doc。
5. 幂等：同一帧重放不重复创建 entry（延续 `aggregator.ts:149-155` 的 user entry 存在性判定）。

## 4. 候选方案与取舍

候选 1：让实时 turn 优先——所有无 turnId 增量一律先归 active turn，删除 callback 机制。
落选：回退 `b253e3684`。真异步回调在一个实时 turn 进行中到达时会被写进用户当前轮的 assistant entry，污染实时输出，且回调内容失去自己的 user 气泡。

候选 2：把 callback 绑定的建立限制在「回放窗口内 / 会话同步在途」。
落选：真异步回调可发生在任意时刻（会话空闲、其它 turn 进行中）。按时间窗判定会漏掉真回调，回调消息被聚合层以 `user_message missing turnId` 拒绝 → 用户看不到内容（数据丢失比错位更糟）。

候选 3（推荐）：**分类判定 + 绑定代际校验**。
- R1 建立条件收紧：窗口外的无 turnId `user_message`，若**文档中已存在同文本的 user entry**，判定为回显/重复回放 → 丢弃（不建 callback 条目）；否则判定为真异步回调 → 按现状建 callback 对。
- R2 绑定加代际：mint 时记录当时的 active turnId；无 turnId 增量到达时若当前 active turnId 与记录不一致，绑定立即失效（交回聚合层按当前 turn 归位）。
- R3 显式清理：带 turnId 的终态到达且与绑定代际不一致时清空绑定；会话换代（`replaceProjection`）时清空绑定。
全部落在既有分层内，不改跨包契约、不动前端。R1 的「丢弃」语义与现有窗口内「doc 已有内容则拒绝回显」的既有语义一致（`relay-event-handler.ts:721-745` + `aggregator.ts:138`）。

候选 4（中期加固，本轮不做）：acp-link 在帧上标注来源（echo / replay / callback）。
原理最可靠（来源是确定的，不需猜），但需要改 `packages/acp-link`（`protocol-adapter.ts`、`claude-acp-adapter.ts`）与 `NormalizedEvent` schema，跨包契约变更 + 需 Peri 端配合。若抓帧证实回显文本不可靠（引擎改写/拼接附件导致 R1 判定失效），必须升级为本方案。

## 5. 选定方案（候选 3）

职责划分：**relay 负责「是哪一类帧」与「绑定是否仍在代际内」；聚合层保持既有的写入规则不变**（唯一例外见 5.4 的可选项）。

### 5.1 新增 DocManager 查询（`state/doc-manager.ts`，紧邻 `hasTimelineContent`，约 :264）

```ts
/**
 * 文档中是否已存在同文本的 user entry（回显 / 历史回放去重判定）。
 * 归一化口径与 relay extractText 一致（trim + 折叠空白），空文本一律返回 false。
 */
hasUserMessageText(rcsSessionId: string, text: string): boolean
```

实现：`getEntryOrder(ydoc)` + `getEntriesMap(ydoc)`，仅看 `role === "user"` 的 entry；文本抽取复用 `blocks`/`blockOrder` 的 Y.Text 拼接（与 `chat-doc-to-structured.ts:blockText` 同口径）。O(entry 数)，每条回显一帧，无需缓存。

### 5.2 SharedRelay 新增字段（`channel/connection-types.ts:137-138` 旁）

```ts
/**
 * callback 绑定的代际：mint 时的 activeTurnId（无活动 turn 时为 null）。
 * 无 turnId 增量到达时若当前 activeTurnId 已变，说明绑定属于上一轮/更早的回调流，
 * 必须失效——否则新 turn 的回答会被追加进旧的 callback assistant entry
 * （2026-09-24 聚合错位根因）。
 */
callbackBindingTurnId?: string | null;
```

### 5.3 relay 分类与代际判定（`channel/relay-event-handler.ts:746-764`）

```ts
if (!inReplayWindow && event.type === "user_message" && !event.turnId) {
  const text = extractEventText(event);            // 与 aggregator extractText 同口径
  if (text && this.dependencies.docManager.hasUserMessageText(shared.rcsSessionId, text)) {
    this.dependencies.log?.("[YJS-FE] duplicate user echo dropped");
    return;                                        // R1：回显/重复回放，不建条目、不建绑定
  }
  const callbackEntryId = `callback_${crypto.randomUUID()}`;
  shared.callbackAssistantEntryId = callbackEntryId;
  shared.callbackBindingTurnId = readActiveTurn(this.dependencies.docManager, shared.rcsSessionId).turnId ?? null; // R2
  event = { ...event, callbackEntryId };
} else if (
  shared.callbackAssistantEntryId &&
  (event.type === "message_delta" || event.type === "reasoning_delta" ||
   event.type === "turn_completed" || event.type === "turn_cancelled" || event.type === "turn_failed") &&
  !event.turnId
) {
  const currentTurnId = readActiveTurn(this.dependencies.docManager, shared.rcsSessionId).turnId ?? null;
  if (shared.callbackBindingTurnId !== currentTurnId) {
    // R2：代际已变（新 turn 接管 / 换代后 active 清空）→ 绑定失效，交聚合层按当前 turn 归位
    shared.callbackAssistantEntryId = null;
    shared.callbackBindingTurnId = null;
  } else {
    event = { ...event, callbackEntryId: shared.callbackAssistantEntryId };
    if (event.type !== "message_delta" && event.type !== "reasoning_delta") {
      shared.callbackAssistantEntryId = null;      // 既有语义：终态清空绑定
      shared.callbackBindingTurnId = null;
    }
  }
}
```

要点：
- 回显丢弃只在**文本命中**时发生（保守，避免真回调被吞）；未命中一律走 callback（保持 `b253e3684` 隔离意图）。
- 代际判定用 activeTurnId 而不是时间戳：同一写入端（`bindInstanceSession` 单活归属）语义稳定，且不引入跨进程时钟问题。
- 增量不带绑定且存在可写 active turn 时，自然落回 `aggregator.ts:213-228` 的现有路径（本轮回答进 `turn_X:assistant`）。
- 终态清空语义保持与现状一致（仅无 turnId 终态走到这里，不改变既有行为）。

### 5.4 会话换代清理（R3，`channel/relay-event-handler.ts:659-678` / `gateway.ts:429-431`）

`openReplayWindow(shared, { resampleSkip: true })` 是 load/resume 换代后重采样判定的唯一入口。在同一处（外加 `replaceProjection` 已生效的 action 路径）清空 `callbackAssistantEntryId` / `callbackBindingTurnId`：换代后旧绑定指向已销毁 doc 的 entry，不清空会让后续无 turnId 增量全被 `aggregator.ts:205` 以 `callback assistant entry not found` 拒绝（静默丢内容）。

可选（P2，需要时再做）：给 `aggregator.ts:203-211` 的 callback 分支补一条兜底——绑定目标 entry 不存在时按「正常增量」路径继续尝试（当前是直接拒绝）。这会改变「历史 callback 条目缺失时不污染实时 turn」的既有语义，需单独讨论，**本轮不做**。

## 6. 存量数据兼容

- 已存在的 `callback_*` / `turnId=null` 条目：本方案不删除、不改写；它们仍是合法 entry（前端按普通 user/assistant 气泡渲染）。
- 永久 `streaming` 的存量 `callback_*:assistant`：不改历史 doc。若要改善观感，另开一次性收敛（在 `bindInstanceSession` 或 `openChat` 时扫描旧于 N 分钟仍未终态的 callback assistant entry 置 `completed`）——**列为未决问题，不在本方案默认范围内**。
- 换代（`replaceProjection`）本就把 doc 整体替换，存量错位不会跨会话污染。
- 新旧代码混跑（滚动发布）：R1/R2 只收紧 relay 的分类与绑定，聚合层写入规则未变；旧实例仍会产出错位条目，新实例不产出。可接受。

## 7. 测试计划

约定：每个 `test(...)` 上方加一句中文注释，说明行为与业务意图（仓库既有要求）；断言用 `countEntriesByRole` / `entriesText`（`relay-event-handler.test.ts:639/654`）与 `relayOn`（:23）。

`packages/chat-channel/src/channel/relay-event-handler.test.ts` 新增：
1. 窗口外 + 文档已有同文本 user entry 的 `user_message_chunk` → 只保留 1 条 user entry，不产生 `callback_*` 条目（缺陷 A 回归）。
2. 窗口外 + 文档无同文本（真异步回调）→ 产生 `callback_*` 对，`callback_*:assistant` 收到后续无 turnId 增量（`b253e3684` 意图回归）。
3. 回调进行中 + 实时 turn 起来（`registerUserMessage`）→ 回调增量继续落回调条目，实时 turn 的增量落 `turn_X:assistant`（隔离不回归）。
4. 陈旧绑定：回调 mint（turn 1 终态带 turnId）→ 新 turn 2 的无 turnId 增量 → 落 `turn_2:assistant`，旧 `callback_*:assistant` 文本不变、状态不变（缺陷 B 回归，本次核心用例）。
5. 换代清理：`replaceProjection` 后无 turnId 增量 → 不因旧绑定被拒绝（内容落新 turn 或按语义拒绝需明确断言）。
6. 窗口内行为不变：既有 `:770 / :838 / :794 / :815` 用例保持通过（不修改其断言）。

`packages/chat-channel/src/__tests__/doc-manager.test.ts` 新增：`hasUserMessageText` 的正/负例（同文本、空白差异、仅 assistant entry 有同文本、空文本）。

回归：`bun test packages/chat-channel`；`bun run precheck`；`bun run scratch-yjs-repro.ts` 核对场景 1/2/4 变为「无 callback 复制条目、回答落 turn_X:assistant」，场景 3 保持正确。若正式测试已覆盖四个场景，可删 `scratch-yjs-repro.ts`（该脚本自带「用完即删」标注）。

## 8. 验证方式与回滚

- 验证顺序：`bun test packages/chat-channel`（含新增用例）→ `bun run scratch-yjs-repro.ts` 人工核对 entry 表 → `bun run precheck` → 真实链路抽查（切换会话后发消息：回答必须落本轮 entry；历史回放不产生条目复制）。
- 回滚：改动集中在 `relay-event-handler.ts` + `connection-types.ts` + `doc-manager.ts`（+测试），无数据迁移、无 schema 变更，`git revert` 单个 commit 即可；存量 doc 不受新旧代码切换影响。

## 9. 风险与未决问题

风险：
1. R1 依赖「回显文本与用户消息逐字一致」。若引擎会改写/拼接（附件、system reminder 等），回显将不被识别 → 缺陷 A 仍会出现（有复制条目，但不会再发生缺陷 B 的远期错位，因为 R2 已限制绑定代际）。需要抓一帧真实回显验证。
2. R2 会让「回调流未结束时用户又发新消息」的回调尾部增量改写到新 turn（原语义是继续写回调条目）。这是本次取舍：优先保证用户当前轮的回答不错位。
3. `hasUserMessageText` 在超长会话上是 O(N) 文本比较，每条回显帧一次；当前量级（entry 数十~数百）可接受，后续若放大需加最近 N 条窗口或索引。

未决：
1. 是否要一次性收敛存量永久 `streaming` 的 callback assistant entry（会改历史 doc 展示）。
2. 是否需要把「回调绑定」升级为独立结构（`{ entryId, turnId, createdAt }`）以便未来扩展；当前只加一个字段。
3. 真异步回调是否也需要在 UI 上与用户消息区分（本方案不改前端，回调仍渲染为用户气泡）。

## 10. 需要用户裁决的问题（已裁决，2026-09-24）

1. R1 对回显采取**丢弃**（不产生任何条目，文本已由 `registerUserMessage` 写入）是否符合预期？还是要求回显与既有 turn 合并（语义上等价于丢弃，只是日志口径不同）？→ **按丢弃实现**（等价于合并；日志记 `duplicate user echo dropped`）。
2. 是否同意「回调尾部增量在用户发出新消息后改归新 turn」这一取舍（风险 2）？→ **同意**（优先保证当前轮不错位；不引入跨包来源标注）。
3. 存量错位的 callback 条目是否需要在本次一并收敛（未决 1）？→ **不处理**（不改历史 doc，仅新代码不再产出错位条目）。

## 11. 最可能被反驳的假设（供对抗式审查）

1. **假设生产上的「远期错位」来自回放窗口过期后 mint 的绑定**（而非实时回显）。若真实触发点是别的（如 SDK 在 resume 时回放历史导致 `hasUserMessageText` 命中率低），R1 的判定条件需要重选，甚至要上候选 4。
2. **假设「文档存在同文本 user entry ⇒ 这是回显」**。反例：用户在两个不同会话/代际里发过完全相同的话，或真异步回调文本恰与历史消息同文——后者会被静默丢弃。
3. **假设实时 prompt 的终态总是带 turnId**（因此绑定永不被清空，缺陷 B 成立）。需抓帧确认：若某些引擎的终态不带 turnId，绑定会被清空，缺陷 B 的复现条件需修正。
4. **假设 `readActiveTurn` 在 relay 的调用时机是可靠的**（增量到达时 session doc 已反映 active turn 的切换）；聚合层的 turn 接管由 `aggregator.ts:166-174` 在同事务内完成，relay 读到的是同一 doc 的最终值——若存在批处理合并（`flushACPBatch`，`doc-manager.ts:291-318`）导致的时序差，代际判定可能读到旧值。
5. **假设 R1 不需要区分「窗口内」与「窗口外」**：窗口内路径（`relay-event-handler.ts:721-745`）已由 `replaySkipSynthesis` 覆盖，R1 只动窗口外分支，不改窗口内语义——若窗口内也出现复制条目，本方案不覆盖。

## 12. 与既有结论的差异

- 既有结论把缺陷 B 描述为「陈旧 callbackAssistantEntryId 未清空 + 后续无 turnId 增量被追加」；复核后确认成立，但补两点：(a) 绑定不只是「未清空」，而是**只会被无 turnId 终态清空**，实时 prompt 的终态因 `pendingPromptTurns` 回填必然带 turnId，所以是结构性永不清空；(b) 缺陷 A 的复制条目与永久 `streaming` 也是同一指针造成的（`callback_*:assistant` 收不到终态），两者应一起修，不能只清指针。
- 用户观察的「user 数据聚合到上一个 user」在服务端**不可能**是 user→user 文本合并：服务端只有 `aggregator.ts:142` 与 `:181` 两处写 user entry，callback id 每条消息新生成（`relay-event-handler.ts:748`）、turnId 每轮新生成（`doc-manager.ts:278`），无复用点。实际形态是「回答被聚合进了远端旧 callback 条目」，且用户消息会多出一条 `turnId=null` 的复制条目（「没有 id」的来源）。

## 13. 实施记录（2026-09-24）

改动文件（无 schema / 无迁移 / 无前端改动）：

| 文件 | 改动 |
| --- | --- |
| `packages/chat-channel/src/state/doc-manager.ts` | 新增 `hasUserMessageText(rcsSessionId, text)`（R1 判定）+ 模块内 `normalizeUserText` / `readEntryText`；导入 `getEntriesMap` / `getEntryOrder` |
| `packages/chat-channel/src/channel/connection-types.ts` | `SharedRelay.callbackBindingTurnId?: string \| null`（R2 代际） |
| `packages/chat-channel/src/channel/relay-event-handler.ts` | 窗口外分支按 R1 剔除回显、按 R2 校验代际；`openReplayWindow` 清空绑定（R3）；新增 `CALLBACK_STREAM_EVENTS` / `CALLBACK_TERMINAL_EVENTS` / `extractUserMessageText` |
| `packages/chat-channel/src/channel/connection-test-helpers.ts` | 默认 DocManager mock 补 `hasUserMessageText: () => false`（避免既有用例打到未实现的桩） |
| `packages/chat-channel/src/channel/relay-event-handler.test.ts` | 新增 `RelayEventHandler callback routing`（7 例） |
| `packages/chat-channel/src/__tests__/doc-manager.test.ts` | 新增 `hasUserMessageText` 正反例 1 例（覆盖精确命中 / 空白改写 / 仅助手同文 / 空文本 / 未打开会话） |

与方案的差异（实施中发现，需记录原因）：

1. **代际不符的终态直接丢弃**（方案 §5.3 伪码未覆盖）：解绑后若把无 `callbackEntryId` 的终态交回聚合层，`aggregator.ts:494-503` 会按当前活动 turn 归位——**提前终结用户正在进行的回答**（新 turn 增量随后被 `canWriteToTurn` 全部丢弃、答案永不出现）。因此该分支只把「增量」交回聚合层，终态丢弃并记 `stale callback terminal dropped`。副作用：失去绑定的回调流最多保持非终态展示，不影响用户可见内容。
2. **测试 3 的语义修正**：方案原写「回调增量继续落回调条目，实时 turn 的增量落 `turn_X:assistant`」，但无 turnId 增量在 relay 层无法区分来源（这正是缺陷 B 的成因）。代际变化后所有无 turnId 增量都归当前 turn，故该用例与用例 4 合并为：断言旧 callback assistant 的文本与状态不被追加（隔离留痕），同时新轮回答落 `turn_X:assistant`。
3. **归一化口径为「trim + 折叠空白」**（保留空白的有无，不删除全部空白）：空白改写（换行/多空格/首尾空白）等价，`"第一条消息"` 与 `"第一条\n消息"` 不判为同文——后者是真实内容差异，判等会误吞回调。
4. **R3 只挂在 `openReplayWindow`**：create/load/resume 三条换代路径都会经它（relay 的 sync-result 分支与 `gateway.ts:431` 的 action 后重开窗口），无需再挂 `replaceProjection`；两条路径都在换代之后调用。
5. **未做**：方案 §5.4 的 P2 兜底（绑定目标 entry 缺失时回落正常增量）、存量 `streaming` 收敛、前端回调气泡区分。

验证（逐项核对终态；对照证据见下）：

| 命令 | 结果 |
| --- | --- |
| `bun test packages/chat-channel/src/channel/relay-event-handler.test.ts` | exit 0，52 pass / 0 fail（新增 7 例全过） |
| 同上，暂存 3 个源文件改动后重跑 | 5 fail（缺陷 A 两例、回答落真实 turn、缺陷 B、换代清理）——新用例确为回归保护，非恒真 |
| `bun test packages/chat-channel/src/__tests__/doc-manager.test.ts` | exit 0，16 pass / 0 fail |
| `bun test packages/chat-channel` | exit 0，671 pass / 0 fail |
| `bun run scratch-yjs-repro.ts` | 场景 1/2/4：无 `callback_*` 复制条目，回答落本轮 `turn_X:assistant`（场景 4 修复前为「回答一回答二」并入旧 callback 条目）；场景 3 保持正确 |
| `bun run precheck` | exit 0，All passed（128s）。首轮曾出现 1 例无关失败（`apps/server/src/__tests__/round37-service-boundaries.test.ts` 的 sandbox 补偿边界，并行负载下偶发；单独重跑 3 次全过、复跑 precheck 0 fail） |
| `bunx biome check …` / `bun run typecheck:packages` | 0 warning（首轮 1 条 `useOptionalChain` 已修）、0 error |

未覆盖 / 未验证：真实链路抓帧（回显文本形态、终态是否总带 turnId）；真实 TUI 冷启动；生产存量 doc 的旧错位条目观感（按裁决不处理）。`scratch-yjs-repro.ts` 为临时脚本，四个场景已由正式用例覆盖，可删。
