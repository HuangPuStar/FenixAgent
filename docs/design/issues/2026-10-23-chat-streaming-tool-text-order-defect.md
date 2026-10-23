# 交互式 Chat 流式正文跨工具错序与正文丢失缺陷（`ai ai tools`）

> 性质：**已修复（第二轮）**的 P0 展示缺陷登记；第一轮修复因正文静默丢失被对抗验证推翻，本文保留完整失败矩阵，作为复发时的第一诊断入口。
> 证据等级：静态代码证据 + 包内最小复现 + 真实 Chat Doc / SyncContentProjectionHub 投影 + React hook（happy-dom）；未做真实浏览器抓包。
> 行号基准：修复后的工作区内容（分支 `fix/chat-streaming-tool-text-order`，第二轮修复之上），引用优先看函数名，行号仅作定位辅助。
> 相关不变量：`docs/arch/19-yjs-chat-streaming.md` §4.2「工具前文本位只认旧分段结构 / 旧侧不追平不得隐藏正文」；`docs/developer/system/frontend-development.md` §8.5 第 13 条。

## 1. 现象与触发条件

用户可见现象：同一轮回答里，助手先输出一段文本、随后调用工具、再输出一段文本，流式过程中第二段文本会**跑到工具之前**，形成 `ai ai`（两段文本相邻）+ 工具的顺序，即用户描述的 `ai tools ai → ai ai tools`；旧路径补齐分段后顺序恢复，表现为逐帧跳动。

第一轮修复只保证了顺序，却引入了更严重的回归：**新投影中合法但旧侧尚未成段的正文被静默隐藏**。典型表现是工具后的第二段/尾文永久不可见，旧侧永不追平时无任何自愈路径；分页缺中段时整段新正文被丢弃。

精确触发条件（三者同时成立）：

1. 交互式 Chat（浏览器）走**新旧双路展示合并**：新同步协议默认开启（`packages/agent-runtime/web/yjs/yjs-ws.ts:151-153`，只有显式 `?chatSync=0` 回退）；
2. 同一助手 entry 内出现 **文本 → 工具调用 → 文本**，旧投影按工具位置把 entry 切成 `entryId` / `entryId#1` 多段；
3. 两路投影进度不一致：新投影已包含工具后的正文，旧侧尚未成段；或分页/重连导致旧侧缺首段、中段、尾段。

不触发：纯文本流（无工具）、无工具的历史消息、`chatSync=0` 的纯旧链路、HTTP `/api` 与 Workflow（两者不消费该展示合并层）。

## 2. 根因

根因位于**前端展示合并层**，但本质是**双投影信息不等价**：旧投影带工具位置，新投影只有整段正文。

**(a) 后端 Chat Doc 顺序正确。** `appendEntryText` 只在末尾追加文本，工具块插入后再次输出文本会新建 `text:N` 块（`packages/chat-channel/src/state/chat-writer.ts:283-332`）；展示派生按 `blockOrder` 切段（`packages/web-runtime/web/chat/chat-doc-to-structured.ts:157-217`）。这一层没有排序/重排逻辑。

**(b) 新同步投影不携带工具位置。** `sync-doc-hub` 只消费 `kind: "text"` 记录，`tool_object` 直接跳过（`packages/agent-runtime/web/yjs/sync-doc-hub.ts:12`、`:219-222`）；同一 `entryId` 的全部文本片段按记录下标拼接成**一条** assistant 消息（`:343-392`，`entry.text = parts.map(...).join("")`、`:380` 固定生成 `assistant_message`）。实测：向投影喂入 `["ai ", "ai"]` 两条文本记录，输出 `{ id: "turn_X:assistant", chunks: [{ text: "ai ai" }] }`，没有工具。

**(c) 第一轮修复的错误取舍。** 合并器的 `preferredMessage` 会在同一 `entryId` 上取"正文更长的一侧"；第一轮改为"工具邻接的旧消息一律保留旧文本"，并跳过同 key 的新消息。旧侧一旦不追平（终态、分页缺段、重连旧快照、旧聚合层拒绝迟到增量），新投影的合法正文就永久不可见。

**(d) 流式中间态的时序窗口真实存在。** 旧路径 `applyUpdate` 的重算被调度到**宏任务**（`packages/chat-channel/src/state/yjs-store.ts:209-217`，`setTimeout(..., 0)`，慢路径 50ms）；新投影镜像在**微任务**里通知（`packages/agent-runtime/web/yjs/sync-doc-hub.ts:404-410`，`queueMicrotask`）。同一 tick 内到达的更新会先提交新投影；`useChatHydration` 的 16ms 提交门控可能合并该窗口，因此"存在可达窗口，是否绘制取决于门控与延迟"，不能等同于"屏幕必然错序"。

**结构性修复评估（为什么本轮不做）**

让新投影保留工具边界需要三处同时改动，属于共享同步协议/存储契约变更：

1. **实时写入**：工具事件只写运行态实体；只有终态才把描述符写进 content Doc（`packages/chat-channel/src/sync/live/live-writer.ts:271-310`，`entryId = ${toolCallId}:final`），没有按文本位置排序的工具标记；
2. **生产历史源**：`readLegacyCommittedHistory` 把每个 entry 的可见正文压成 `text_part`，不读取 `blockOrder` 的工具位置（`packages/chat-channel/src/channel/legacy-chat-history.ts:80-105`）；
3. **前端镜像**：`sync-doc-hub` 只镜像 content Doc 并跳过 `tool_object`（`sync-doc-hub.ts:12`、`:219-222`）。

因此"只解析 `tool_object`"不足以恢复实时工具位置；真正结构化需要新增有序标记记录，并同步修改 live writer、历史导入、容量/轮转/幂等与前端镜像。该改动影响共享协议与持久化语义，需单独评审。本轮采用**覆盖感知的无损合并**，并在 §4 明确保底策略；结构权威的后续动作登记在 §9。

## 3. 对抗验证失败矩阵（第一轮修复被推翻的证据）

| 编号 | 构造 | 第一轮结果 | 第二轮结果 |
| --- | --- | --- | --- |
| M07 | 旧 `[A, t1, t2, C]`，新 `ABC`（分页缺中段） | 显示 `AC`，`B` 丢失 | 显示 `A, t1, t2, BC`，正文 `ABC` |
| M08 | 旧 `[A, t]` 永久不补第二段，时钟推进 1 小时 | 只显示 `A` | 显示 `A, t, B`（任意时钟一致） |
| M09 | 旧 `[A, t, B]`，新继续增长到 `ABC` | 丢 `C` | 显示 `A, t, BC` |
| R02 | 旧快照停滞，新侧已 `final`（`ABFINAL`） | 尾部 `FINAL` 不可见 | 显示 `A, t, BFINAL` |
| H01/H02 | React hook 终态/重连 scope 重建 | DOM `A\|[tool]\|B`，`C` 缺失 | DOM 正文 `ABC`，重建后仍 `ABC` |
| M01 | 旧 `[A, t]`，新 `AB`（流式中间态） | `AB` 在工具前（错序） | `A, t, B`（顺序正确且不丢） |
| M11 | 用户与助手同 id | 助手正文被吞 | 用户与助手都可见 |
| M15 | 多标签页旧侧进度不同 | 一侧 `A`、一侧 `AB` | 两侧正文一致 |

第一轮新增回归的直接代码原因：`sync-chat-messages.ts:335-336` 原本要求旧侧缺段时用新投影兜底；新增的 `:339-341` 在旧侧未完整覆盖新正文时仍跳过新消息；`:58` 的单段保护没有终态/超时恢复。既有回归测试过窄：`apps/web/src/__tests__/sync-chat-messages.test.tsx:103` 手写新侧文本、未走真实投影；`:171` 的分页用例同时删除工具及后续段，绕开了关键保护分支。

## 4. 修复

**契约**：旧投影分段是工具位置的唯一权威；新投影整段是正文完整性的权威。合并结果必须同时满足：

1. 旧侧已覆盖的正文留在工具两侧原位置；
2. 新侧未被旧侧覆盖的正文按同步文本顺序补到「紧随其后的已知段」之前；没有后续已知段时补到条目末尾（末尾是工具则排在工具之后）；
3. 两路无法对齐时把整段新正文作为条目尾段兜底——**宁可重复，也不能永久隐藏正文**；
4. 旧侧追平后按同一分段 id 收敛，不重复、不新增合成段；
5. 合成尾段使用下一个空闲 `entryId#N`，追平后 id 稳定。

修改 `packages/agent-runtime/web/hooks/sync-chat-messages.ts`：

1. `collectEntrySegments`（`:185`）：按「精确入口 id + 紧随其后的 `#N` 分段」索引旧助手消息，兼容 entryId 自身含 `#`。
2. `alignSegmentsToSyncText`（`:80`）：把旧分段按出现顺序对齐到新整段文本，得到已覆盖区间与未覆盖缺口。
3. `planEntryInjection`（`:120`）：生成无损合并计划——缺口并入紧随其后的已知段，尾部缺口并入末尾已知段或生成条目尾段；无法对齐时整段兜底。
4. `applyLosslessEntryMerge`（`:211`）：只对**分段或工具邻接**的助手 entry 执行；无工具单段 entry 仍走原 `preferredMessage`，避免改变既有语义。
5. 合并入口（`:431`）：先做无损注入，再把被消费的新投影整段消息从后续配对/候选中剔除，杜绝整段正文顶替工具前段落。
6. 配对与 key（`:463` 起）：同 id 不同角色不再配对；同 id 冲突时新消息使用 `sync:{id}` 独立 key，两侧都可见。

未改动后端、同步协议、投影 schema 与渲染组件；无兼容层、无开关。

## 5. 影响面

- **入口**：仅浏览器交互式 Chat 的展示合并（`useChatHydration` 调用合并器，`packages/agent-runtime/web/hooks/use-chat-hydration.ts:147`；新协议默认开启 `yjs-ws.ts:151-153`）。
- **不涉及**：HTTP 单轮调用、Workflow、`/api/*` 调用方；这些路径不消费 `createSyncMessageMerger`。
- **多标签页/重连**：不是触发必要条件；重连后旧快照缺段时，本轮修复保证新投影正文仍可见（H02）。
- **数据影响**：无。仅展示层合并错误，Y.Doc、Redis 快照与数据库内容不受影响。

## 6. 回归测试

文件：`apps/web/src/__tests__/sync-chat-messages.test.tsx`

| 用例 | 覆盖 |
| --- | --- |
| `工具后正文未成段时新投影尾文排在工具之后且不丢失` | 真实 Chat Doc 中间态：尾文排在工具后、正文两段都在；旧侧追平后同一 id、不重复 |
| `分页缺中段且保留工具时新投影中段正文不得丢失` | M07：保留工具与 `#2`、只缺 `#1`，断言 `A, t1, t2, BC` 与正文 `ABC` |
| `真实投影中间态尾文排在工具后且追平后不重复` | 真实 `SyncContentProjectionHub` 从 content Doc 派生新投影，不手写 sync 消息 |
| `多段多工具终态保持严格顺序且新投影不重复` | M02：`A, t1, B, t2, C` 严格顺序 |
| `空白尾段与空尾段不产生多余消息` | M04/M05：空白段保留、空尾不生成合成消息 |
| `用户与助手同 key 时助手正文不得丢失` | M11：两侧都可见 |
| `entryId 含 # 时仍按分段结构保持顺序` | M12：`e#1` / `e#1#1` 分段 |
| `旧侧停滞且新侧 final 后尾文仍然可见` | M08/R02：三个时钟点 + 永久缺第二段 |

文件：`apps/web/src/__tests__/use-chat-hydration.test.tsx`

| 用例 | 覆盖 |
| --- | --- |
| `终态旧快照缺尾段时保留新投影尾文并跨 scope 重建可见` | H01/H02：真实 hook + happy-dom；终态正文 `ABC`，scope 重建仍 `ABC`，旧侧追平后不重复 |

另外用属性检查覆盖 1400 组「完整/任意缺段 × 多工具」组合：每段正文都必须可见，完整终态顺序精确。

## 7. 验证证据

| 命令 | 结果 |
| --- | --- |
| `bun test`（合并器、hydration 门控、structured-to-thread、sync 回退权威共 11 个文件） | 176 pass / 0 fail |
| 对抗矩阵 M01–M18（验证者脚本 + 本轮补充） | 18 pass / 0 fail |
| 缺段属性检查（200 轮 × 7 种缺段组合 + 尾文增长） | 1400 checks passed |
| `bun run precheck` | **全绿**：12 项静态门禁（Biome + 11 项 STATIC_GATES）；web-app-tests 392 pass、server-and-script-tests 1017 pass、package-tests 11551 pass + 2 skip，均 0 fail，`All passed (225979ms)` |
| `bun run build:web` | **成功**（`✓ built in 1.54s`）；存在项目既有警告（Tailwind `SOURCEMAP_BROKEN` 等），无构建错误 |
| `bun run docs:build` | **成功**（`build complete in 7.22s`）；`env` 语法高亮回退为既有警告 |

第一轮失败证据（修复前）：

```text
Expected: ABC
Actual:   AB          # 新投影尾文被静默隐藏
Expected: BC
Received: C           # 分页缺中段
Expected: ABFINAL
Received: AB          # 终态尾文丢失
```

门禁计数更正：`scripts/lib/check-gates.ts` 的 `STATIC_GATES` 为 **11** 项，加 Biome 共 **12 项静态门禁**；此前报告中的"13 项"有误。

## 8. 复发防线

**测试断言（必须保留）**

1. 任何改动 `createSyncMessageMerger` / `preferredMessage` / `segmentedBases` / 消息退役规则：必须同时跑「工具已到、工具后正文未成段」与「旧侧永久缺段 + 新侧 final」两类用例；只断言最终态会漏掉流式中间态，只断言顺序会漏掉正文丢失。
2. 新投影结构（`sync-doc-hub`）若开始输出工具位置：先删掉本合并特判，再补「单源即可表达工具顺序」的等价测试，禁止两层同时猜顺序。
3. 任何"覆盖/退役"判断都必须有缺口兜底断言：新投影正文的每个字符要么被旧结构覆盖，要么被注入，不得静默丢弃。

**代码评审检查项**

1. 是否用"文本更长"决定**位置**？位置只能由稳定结构（entry 顺序、分段 id、工具块）决定，长度只用于同位置内容取舍。
2. 是否存在"保护只在第二种状态出现后才生效"的时间窗？中间态必须有独立断言。
3. 旧侧缺段/分页/重连/终态时，新侧正文是否有可见出口？不得依赖"旧侧迟早会追平"。
4. 合成段 id 是否与 legacy `#N` 编号兼容，追平后能否稳定收敛而不重复？
5. 同 id 不同角色、entryId 自身含 `#` 时，配对与分段是否仍然成立？

**日志与可观测信号**

- 展示层无内容日志（合规要求）。排查时用 `?chatSync=0` 对照：关闭新协议后顺序正常，说明命中双路合并面；关闭后仍错序则转向旧投影/后端链路。
- 合并器最小复现：`legacy = [A, tool]`、`sync = [ABC]`，输出必须是 `A, tool, BC`（或 `A, tool, B, C`），不得是 `ABC, tool`，也不得只有 `A`。

**相邻位置排查结论**

- `chat-doc-to-structured.ts` 按 `blockOrder` 切段：顺序权威，无排序。
- `structured-to-thread.ts` / `MessageBubble`：按数组顺序渲染，`chunks` 不重排。
- `sync-doc-hub` 的跨 Doc 拼接按 `(blockIndex, recordIndex)` 排序（`:363-375`）：未发现重排；但它无法表达工具位置，是本缺陷的上游事实。
- `useChatHydration` 的 hydration 门控只决定"何时提交"，不改变消息顺序。
- 退役路径（`takeCoverage`）已复核：同 id 双写会配对，不被退役；异 id 未配对时仍可能把工具前旧文本退役到条目末尾（M16），属于既有行为，新投影正文仍可见，登记为 §9 的后续项。

## 9. 未决与后续

1. **跨投影结构权威（高）**：评估在同步协议中增加有序工具标记记录（content Doc 记录 kind + 历史源 + 镜像解码），让新投影可独立表达工具位置；需评审共享协议、容量、轮转与幂等影响。
2. **M16 异 id 配对（中）**：异 id 未配对时，工具前旧文本可能被退役并显示在条目末尾；正文不丢但顺序不保证，需确认生产可达性后另立修复。
3. **真实浏览器/多标签页（中）**：本轮未做真实浏览器抓包；时序结论来自真实 store/hub/hook 与调度语义，需补一次端到端绘制验证。
4. **报告措辞（低）**：第一轮"已排除后端其他层"的结论过强；本文收窄为"当前证据未发现后端重排"。

## 10. 交叉引用

- 架构契约：`docs/arch/19-yjs-chat-streaming.md` §4.2（合并器不变量）、§4.1（新旧协议分流）。
- 前端规范：`docs/developer/system/frontend-development.md` §8.5 第 13 条。
- 历史相关修复：`docs/design/2026-09-24-yjs-chat-callback-routing-fix.md`（双路聚合错位）、`docs/design/2026-10-16-fenix-message-sync-implementation-notes.md` §3（新旧共存与文本退役）、B02「工具分段 entry 保留完整旧结构」。
- 对抗验证原始报告：`.peri/plans/chat-tool-order-adversarial-verification.md`（临时产物，关键证据已并入本文）。
- 代码入口：`packages/agent-runtime/web/hooks/sync-chat-messages.ts`、`packages/agent-runtime/web/hooks/use-chat-hydration.ts`、`packages/agent-runtime/web/yjs/sync-doc-hub.ts`、`packages/chat-channel/src/state/chat-writer.ts`、`packages/chat-channel/src/sync/live/live-writer.ts`、`packages/chat-channel/src/channel/legacy-chat-history.ts`。
