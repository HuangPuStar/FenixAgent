# 交互式 Chat 流式正文跨工具错序缺陷（`ai ai tools`）

> 性质：**已修复**的 P0 展示缺陷登记，可作为复发时的第一诊断入口。
> 证据等级：静态代码证据 + 包内最小复现（`apps/web/src/__tests__/sync-chat-messages.test.tsx`），未做真实浏览器抓包。
> 行号基准：修复后的工作区内容（HEAD `c2441521` + 本次改动），引用优先看函数名，行号仅作定位辅助。
> 相关不变量：`docs/arch/19-yjs-chat-streaming.md` §4.2「工具前文本位只认旧分段结构」；`docs/developer/system/frontend-development.md` §8.5 第 13 条。

## 1. 现象与触发条件

用户可见现象：同一轮回答里，助手先输出一段文本、随后调用工具、再输出一段文本，流式过程中第二段文本会**跑到工具之前**，形成 `ai ai`（两段文本相邻）+ 工具的顺序，即用户描述的 `ai tools ai → ai ai tools`；旧路径补齐分段后顺序恢复，因此表现为逐帧跳动 / 重复。

精确触发条件（三者同时成立）：

1. 交互式 Chat（浏览器）走**新旧双路展示合并**：新同步协议默认开启（`packages/agent-runtime/web/yjs/yjs-ws.ts:151-153`，只有显式 `?chatSync=0` 回退）；
2. 同一助手 entry 内出现 **文本 → 工具调用 → 文本**，旧投影按工具位置把 entry 切成 `entryId` / `entryId#1` 多段；
3. 处于流式**中间态**：工具已投影到旧侧、工具后的正文尚未在旧侧成段，而新投影已把工具后的正文拼进同一条助手消息。

不触发：纯文本流（无工具）、无工具的历史消息、`chatSync=0` 的纯旧链路、HTTP `/api` 与 Workflow（两者不消费该展示合并层）。

## 2. 根因

根因位于**前端展示合并层**，不是后端 ACP 解析、Y.Doc 写入或广播顺序。逐层核查结论：

**(a) 后端 Chat Doc 顺序正确。** `appendEntryText` 只在末尾追加文本，工具块插入后再次输出文本会新建 `text:N` 块（`packages/chat-channel/src/state/chat-writer.ts:283-325`、`:328-332`）；展示派生按 `blockOrder` 切段（`packages/web-runtime/web/chat/chat-doc-to-structured.ts:157-217`）。这一层没有排序/重排逻辑。

**(b) 新同步投影不携带工具位置。** `sync-doc-hub` 只消费 `kind: "text"` 记录，`tool_object` 直接跳过（`packages/agent-runtime/web/yjs/sync-doc-hub.ts:12`、`:219-222`）；同一 `entryId` 的全部文本片段按记录下标拼接成**一条** assistant 消息（`:343-392`，`entry.text = parts.map(...).join("")`、`:380` 固定生成 `assistant_message`）。实测：向投影喂入 `["ai ", "ai"]` 两条文本记录，输出 `{ id: "turn_X:assistant", chunks: [{ text: "ai ai" }] }`，没有工具。

**(c) 合并器用「更长的一侧」顶替工具前的文本位。** `createSyncMessageMerger` 的 `preferredMessage`（修复前的原实现）对同 `entryId` 的旧/新助手消息取正文更长者。新投影的整段正文必然不短于旧侧首段，于是工具前的文本位被替换成「首段 + 工具后正文」。

**(d) 为什么恰好在流式中间态出现。** 旧侧只在工具后正文到达时才创建 `entryId#1`；合并器用于保护工具顺序的 `segmentedBases` 也只在旧侧已存在带 `#` 的段时才生效（`sync-chat-messages.ts` 的 `segmentedEntryBases` / `coveredBySegments`）。在第二段出现之前，保护条件为空，整段新文本直接顶替首段位置。

两路的提交时序并不对称，使这个中间态真实可见：

- 旧路径 `applyUpdate` 的重算被调度到**宏任务**（`packages/chat-channel/src/state/yjs-store.ts:209-217`，`setTimeout(..., 0)`，慢路径 50ms）；
- 新投影镜像在**微任务**里通知（`packages/agent-runtime/web/yjs/sync-doc-hub.ts:404-410`，`queueMicrotask`）。

同一 tick 内到达的更新会先提交新投影、后提交旧投影，合并器读到的就是「新投影领先、旧侧尚未成段」的中间态；每次工具后文本增量都可能重复这一窗口。

复原顺序（修复前）：

```
旧侧: [user] [assistant "ai "] [tool]
新侧: [user] [assistant "ai ai"]
合并: [user] [assistant "ai ai"] [tool]        ← 工具后的 "ai" 跑到工具前
旧侧补齐: [user] [assistant "ai "] [tool] [assistant#1 "ai"]
合并: [user] [assistant "ai "] [tool] [assistant#1 "ai"]   ← 恢复正确
```

**已排除的候选**（均有代码/测试证据）：

- 同一 chunk 被重复应用：服务端只有 `Y.Text.insert(len, text)` 一处文本写入（`chat-writer.ts:322-323`），`YjsBroadcaster` 用 `Y.mergeUpdates` 合并且不重放已应用更新；聚合层对 `turnId` / `entryId` 幂等。
- 广播/微批次乱序：`DocManager` 按 `batch.events` 数组顺序投影（`packages/chat-channel/src/state/doc-manager.ts:390-400`），控制事件先 flush 当前批次。
- `sessionUpdate` 字段误读：`normalizeAcpMessage` 只从 `params.update` 取 `sessionUpdate` 与 `content`（`packages/chat-channel/src/protocol/acp-channel.ts:576-595`），文本提取与聚合层同口径。
- 词级/行级重新解析：流式链路无按词/行排序或去重逻辑；`splitSystemReminderBlocks` 只切分不重排。

## 3. 影响面

- **入口**：仅浏览器交互式 Chat 的展示合并（`useChatHydration` 调用合并器，`packages/agent-runtime/web/hooks/use-chat-hydration.ts:147`；新协议默认开启 `yjs-ws.ts:151-153`）。
- **不涉及**：HTTP 单轮调用（`openai-chat.ts`）、Workflow（`agent-chat-transport.ts`）、`/api/*` 调用方；这些路径不消费 `createSyncMessageMerger`。
- **多标签页/重连**：不是触发必要条件。重连后历史 entry 已终态且新旧两侧都有完整分段，通常不再出现；纯实时流式每轮遇到「文本 → 工具 → 文本」即可复现。
- **数据影响**：无。仅展示层排序错误，Y.Doc、Redis 快照与数据库内容不受影响；刷新后以旧侧分段结构恢复。

## 4. 修复

修改 `packages/agent-runtime/web/hooks/sync-chat-messages.ts`：

1. 新增 `toolFollowedAssistantIds(legacy)`（`:28-46`）：扫描旧侧消息，标记「后面在下一个文本消息之前紧跟 `tool_call`」的助手消息 id——这些位置属于工具前的文本位。
2. `preferredMessage` 增加 `toolFollowed` 参数（`:48-62`）：工具前的文本位一律保留旧消息，不再取更长的新投影正文。
3. 合并器入口计算该集合（`:202`），并在配对分支传入（`:330`）。
4. 未配对但复用同一 key 的新投影消息同样不得顶替工具前旧文本（`:339-342`），覆盖别名/模糊配对失败但仍落在同一位的路径。

未改动后端、协议、投影与渲染组件；未新增兼容层或开关。修复后中间态显示为「首段文本 + 工具」，工具后正文在旧侧成段后按原顺序出现，不重复。

## 5. 回归测试

文件：`apps/web/src/__tests__/sync-chat-messages.test.tsx`

- 新增用例：`工具后正文未成段时新投影整段文本不得前移到工具之前`（`:85`）
  - 用真实 `applyNormalizedEvent` 构造 `user_message → message_delta("ai ") → tool_call_started`；
  - 中间态断言合并结果 id 顺序为 `[turn:user, turn:assistant, tool-s]`、首段文本仍为 `"ai "`（新投影的 `"ai ai"` 不得占位）；
  - 旧侧补齐第二段后断言顺序为 `[turn:user, turn:assistant, tool-s, turn:assistant#1]`、文本为 `["", "ai ", "", "ai"]`（不重复、不丢段）。
- 既有防线继续通过：
  - `工具分段 entry 保留最终答案与顺序`（`:58`，B02 分段结构优先）；
  - `分页缺段时保留新投影正文兜底`（`:154`，旧侧缺段时仍允许新投影补正文）。
- 合并器覆盖次数/用户配对：`packages/agent-runtime/web/__tests__/sync-chat-messages-merge.test.ts` 全部通过。

## 6. 验证证据

实际执行命令与结果：

| 命令 | 结果 |
| --- | --- |
| `bun test apps/web/src/__tests__/sync-chat-messages.test.tsx packages/agent-runtime/web/__tests__/sync-chat-messages-merge.test.ts` | 25 pass / 0 fail |
| `bun test`（11 个相关文件：合并器、hydration 门控、structured-to-thread、sync 回退权威） | 168 pass / 0 fail |
| `bun run fastcheck` | **全绿**：13 项静态门禁通过；因未跟踪的 `.mcp.json` 无法判定归属，保守跑全量三批——web-app-tests 384 pass、server-and-script-tests 1017 pass、package-tests 11551 pass + 2 skip，均 0 fail，`All passed (234044ms)` |
| `bun run build:web` | **成功**（`✓ built in 1.71s`）；仅有 Tailwind `SOURCEMAP_BROKEN` 既有警告，无构建错误 |
| `bun run docs:build` | **成功**（`build complete in 6.63s`）；`env` 语法高亮回退为既有警告 |

修复前的最小复现结果：同一用例在 `mid[1]` 处得到 `"ai ai"`（`Expected: "ai " / Received: "ai ai"`），与用户现象一致。

## 7. 复发防线

**测试断言（必须保留）**

- 任何改动 `createSyncMessageMerger` / `preferredMessage` / `segmentedBases` / 消息退役规则：必须同时跑「工具已到、工具后正文未成段」的中间态用例；只断言最终态会漏掉本缺陷。
- 新投影结构（`sync-doc-hub`）若开始输出工具位置，先删掉本合并特判，再补「单源即可表达工具顺序」的等价测试，不得两层同时猜顺序。

**代码评审检查项**

1. 新投影的一条消息是否可能跨越旧侧的工具/计划边界？跨越时是否只用于「无工具邻接」的位置？
2. 合并器是否在某个分支用「文本更长」决定位置？位置只能由稳定结构（entry 顺序、分段 id、工具块）决定，长度只用于同位置内容取舍。
3. 是否存在「protection 只在第二种状态出现后才生效」的时间窗？中间态必须有独立断言。
4. 新增排序/合并 key 是否可能冲突（`entryId`、`entryBaseId`、`coalesce key`）；冲突时的兜底是否会移动工具位置？

**日志与可观测信号**

- 展示层目前无内容日志（合规要求）。排查时可在本地用 `?chatSync=0` 对照：若关闭新协议后顺序正确，即命中本缺陷面。
- 复现脚本可用 `createSyncMessageMerger()(legacy, sync)` 直接比对：`legacy = [user, assistant("ai "), tool]`、`sync = [assistant("ai ai")]`，输出首条助手文本必须是 `"ai "`。

**相邻位置排查结论**

- `chat-doc-to-structured.ts` 按 `blockOrder` 切段：顺序权威，无排序。
- `structured-to-thread.ts` / `MessageBubble`：按数组顺序渲染，`chunks` 不重排。
- `sync-doc-hub` 的跨 Doc 拼接按 `(blockIndex, recordIndex)` 排序（`:363-375`）：顺序来自协议写入顺序，未发现重排；但它无法表达工具位置，这是本缺陷的上游事实，不是独立缺陷。
- `useChatHydration` 的 hydration 门控只决定「何时提交」，不改变消息顺序。
- 同一缺陷模式的另一处（`takeCoverage` 退役）已复核：退役只作用于未配对、且不属于分段 base 的纯文本旧消息；工具前首段在存在新投影同 id 消息时必然配对，不会被退役。

## 8. 交叉引用

- 架构契约：`docs/arch/19-yjs-chat-streaming.md` §4.2（合并器不变量）、§4.1（新旧协议分流）。
- 前端规范：`docs/developer/system/frontend-development.md` §8.5 第 13 条。
- 历史相关修复：`docs/design/2026-09-24-yjs-chat-callback-routing-fix.md`（双路聚合错位）、`docs/design/2026-10-16-fenix-message-sync-implementation-notes.md` §3（新旧共存与文本退役）、B02「工具分段 entry 保留完整旧结构」。
- 代码入口：`packages/agent-runtime/web/hooks/sync-chat-messages.ts`、`packages/agent-runtime/web/hooks/use-chat-hydration.ts`、`packages/agent-runtime/web/yjs/sync-doc-hub.ts`、`packages/chat-channel/src/state/chat-writer.ts`、`packages/web-runtime/web/chat/chat-doc-to-structured.ts`。
