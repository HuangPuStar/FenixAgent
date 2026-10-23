# 交互式 Chat 流式正文跨工具错序与正文丢失缺陷（`ai ai tools`）

> 性质：**核心回归已修复；第三轮补齐工具边界定位与 ID 冲突残余风险**。第一轮修复因正文静默丢失被对抗验证推翻；第二轮修复解决了正文完整性，但缺口跨工具定位、合成 id 冲突等仍被严格验收判 FAIL。本文保留三轮完整失败矩阵，作为复发时的第一诊断入口。
> 证据等级：静态代码证据 + 包内最小复现 + 真实 Chat Doc / SyncContentProjectionHub 投影 + React hook（happy-dom）；未做真实浏览器抓包。
> 行号基准：本轮修复后的工作区内容（分支 `fix/chat-streaming-tool-text-order`），引用优先看函数名，行号仅作定位辅助。
> 相关不变量：`docs/arch/19-yjs-chat-streaming.md` §4.2「工具前文本位只认旧分段结构 / 旧侧不追平不得隐藏正文」；`docs/developer/system/frontend-development.md` §8.5 第 13 条。

## 1. 现象与触发条件

用户可见现象：同一轮回答里，助手先输出一段文本、随后调用工具、再输出一段文本，流式过程中第二段文本会**跑到工具之前**，形成 `ai ai`（两段文本相邻）+ 工具的顺序，即用户描述的 `ai tools ai → ai ai tools`；旧路径补齐分段后顺序恢复，表现为逐帧跳动。

三轮修复分别解决不同层次的问题：

1. **第一轮（#341）**：只保证工具前文本不被整段顶替，导致旧侧缺段时新投影正文被永久隐藏（`AB`、`AC`）。
2. **第二轮**：覆盖感知的无损合并解决了正文丢失，但缺口按“下一个已知段之前”注入，会跨越工具（真实 `B` 应在 `t1`/`t2` 之间，却落到 `t2` 之后）；合成段 id 与别名 key 未做全局唯一性检查。
3. **第三轮（本轮）**：按分段序号与工具数量确定性定位缺口；不可判定时安全降级；合成 id / 别名 key 全局唯一；保留纯空白；乱序 legacy 安全降级。

精确触发条件（三者同时成立）：

1. 交互式 Chat（浏览器）走**新旧双路展示合并**：新同步协议默认开启（`packages/agent-runtime/web/yjs/yjs-ws.ts:151-153`，只有显式 `?chatSync=0` 回退）；
2. 同一助手 entry 内出现 **文本 → 工具调用 → 文本**，旧投影按工具位置把 entry 切成 `entryId` / `entryId#1` 多段；
3. 两路投影进度不一致：新投影已包含工具后的正文、旧侧尚未成段；或分页/重连导致旧侧缺首段、中段、尾段。

不触发：纯文本流（无工具）、无工具的历史消息、`chatSync=0` 的纯旧链路、HTTP `/api` 与 Workflow（两者不消费该展示合并层）。

## 2. 根因与结构性判定

根因位于**前端展示合并层**，本质是**双投影信息不等价**：旧投影带工具位置，新投影只有整段正文。

**(a) 后端 Chat Doc 顺序正确。** `appendEntryText` 只在末尾追加文本，工具块插入后再次输出文本会新建 `text:N` 块（`packages/chat-channel/src/state/chat-writer.ts:283-332`）；展示派生按 `blockOrder` 切段（`packages/web-runtime/web/chat/chat-doc-to-structured.ts:157-217`）。这一层没有排序/重排逻辑。

**(b) 新同步投影不携带工具位置。** `sync-doc-hub` 只消费 `kind: "text"` 记录，`tool_object` 直接跳过（`packages/agent-runtime/web/yjs/sync-doc-hub.ts:12`、`:219-222`）；同一 `entryId` 的全部文本片段按记录下标拼接成**一条** assistant 消息（`:343-392`）。运行时用例 `sync-chat-entry-merge-adversarial.test.ts:169` 实测：content Doc 同时含 text + tool_object 时，投影只有一条正文消息、`skippedRecords=1`。

**(c) 新投影能否在运行时拿到工具边界？不能（本轮结论）。**

1. **实时写入**：非终态工具只写运行态实体（`live-writer.ts:271-329`，非终态分支 `target.upsertEntity(record)`）；终态才写 content Doc 的 `final` 记录，且 `entryId = ${toolCallId}:final`（`:291-318`），按完成时间追加，不表达与文本的相对顺序。
2. **运行态结构**：实体存放在 `Y.Map`（`runtime-doc.ts:251-278`），键为 `entityId`，没有跨 Doc 的有序序列；即使前端镜像运行态 Doc 也无法与 content Doc 的文本记录建立稳定先后关系。
3. **前端镜像入口**：`sync-doc-hub.applyUpdate` 只接受 `parseContentDocId` 的 content Doc（`sync-doc-hub.ts:427-435`），运行态 Doc 不进入展示投影。
4. **生产历史源**：`readLegacyCommittedHistory` 把每个 entry 的可见正文压成 `text_part`，不读取 `blockOrder` 的工具位置（`packages/chat-channel/src/channel/legacy-chat-history.ts:80-105`）。

因此，**精确恢复工具边界必须改共享同步写协议/存储**：在 content Doc 增加有序工具标记记录、让历史源按 blockOrder 输出标记、并扩展前端镜像解码；还要评审容量、轮转、幂等与协议版本。按本轮约束，**未实施该结构性变更**，只报告设计取舍；展示层采用下述确定性边界规则与安全降级。

## 3. 对抗验证失败矩阵

### 3.1 第一轮（#341）引入的正文丢失

| 编号 | 构造 | 第一轮结果 | 最终结果 |
| --- | --- | --- | --- |
| M07 | 旧 `[A, t1, t2, C]`，新 `ABC`（分页缺中段） | 显示 `AC`，`B` 丢失 | 显示 `A, t1, B, t2, C` |
| M08 | 旧 `[A, t]` 永久不补第二段，时钟推进 1 小时 | 只显示 `A` | 显示 `A, t, B`（任意时钟一致） |
| M09 | 旧 `[A, t, B]`，新继续增长到 `ABC` | 丢 `C` | 显示 `A, t, BC` |
| R02 | 旧快照停滞，新侧已 `final`（`ABFINAL`） | 尾部 `FINAL` 不可见 | 显示 `A, t, BFINAL` |
| H01/H02 | React hook 终态/重连 scope 重建 | DOM `A\|[tool]\|B`，`C` 缺失 | DOM 正文 `ABC`，重建后仍 `ABC` |

### 3.2 第二轮（正文完整但边界/ID 仍错）

以下用例先在 `26821043e` 上原样运行失败，再于本轮通过（`sync-chat-entry-merge-adversarial.test.ts`）：

| 编号 | 构造 | 第二轮结果（错误） | 本轮结果 |
| --- | --- | --- | --- |
| N1a | 旧 `[A, t1, t2, C]`，新 `ABC` | `A, t1, t2, BC`（B 跨过 t2） | `A, t1, B, t2, C` |
| N1b | 旧 `[t1, e#1=B]`，新 `AB` | `t1, e#1=AB`（A 被塞到 t1 之后） | `A, t1, B` |
| N1c | 旧 `[A, t1, t2]`，新 `AB` | `A, t1, t2, B`（B 跨过 t2） | `A, t1, B, t2` |
| N2 | 旧 `[A, t]`，新 `[e=AB, e#1=XYZ]` | `A, t, e#1=XYZ`，`B` 丢失 | `A, t, e#2=B, e#1=XYZ`，正文 `ABXYZ` |
| N3 | 旧 `[A, tool(id=e#1)]`，新 `e=AB` | 工具被合成 `e#1` 覆盖 | `A, tool(e#1), e#2=B` |
| N4 | 旧 `[user(e), assistant(sync:e=OLD)]`，新 `e=NEW` | 旧助手 `OLD` 被 `NEW` 顶掉 | `OLD`、`NEW` 都可见，key `sync-ext:e` |
| N5 | 旧 `[A, t]`，新 `"A "` | 尾随空格丢失（`A`） | 正文 `A `（空白保留、无空消息） |
| N6 | 乱序旧 `[t2, e#2=C, t1, e=A]`，新 `ABC` | `ABCA`（重复正文） | `t2, e=ABC, t1`（正文只出现一次，工具保留） |

第二轮的测试断言也过窄：`apps/web/src/__tests__/sync-chat-messages.test.tsx` 只断言 `A,t1,t2,BC`，没有证明工具位置；本轮改为精确断言 `A,t1,B,t2,C`。

## 4. 本轮修复

### 4.1 确定性边界规则（不跨未知工具）

修改 `packages/agent-runtime/web/hooks/sync-chat-entry-merge.ts`：

1. `collectEntrySegments`（`:155`）：按「精确入口 id + 紧随其后的 `#N` 分段」索引，兼容 entryId 自身含 `#`。
2. `alignSegmentsToSyncText`（`:100`）：旧分段按出现顺序对齐到新整段，得到覆盖区间与缺口。
3. `planGroup`（`:208`）：按分段序号与工具数量定位缺口：
   - 相邻已知段序号差 = 其间文本分段边界数；
   - **缺首段** → 插在第一个工具之前；
   - **缺中段** → 插在第一个工具之后；
   - **缺尾段** → 插在末段后第一个工具之后；
   - 工具数必须等于边界数，否则视为不可判定；
   - 纯空白缺口并入相邻已知段，不生成空消息。
4. `applyLosslessEntryMerge`（`:304`）：执行计划；不可判定/乱序 legacy 安全降级——移除该 entry 的文本段，在原位置插入新投影单条消息，工具与输入顺序保留，正文只出现一次。
5. `nextFreeEntryId`（`:137`）：合成段 id 在**全部 legacy + sync 消息 id**（工具、计划、用户、其他 sync entry）中查重，冲突顺延序号。
6. `sync-chat-messages.ts`：`uniqueMessageKey`（`:20`）为同 id 冲突的新投影消息生成 `sync-ext:{id}` 可打印 key，并对全部 legacy/sync id 与已分配 key 查重；内部 alias map 仍用不可碰撞的 `\u0000sync:` 前缀（`:13`）。同 id 不同角色不再配对。

### 4.2 合成 id 与别名 key 的唯一性

- 合成段 id 的保留集覆盖所有 legacy/sync 消息（不限于当前 entry 的分段）；被移除/被消费的消息 id 才让位。
- 别名候选 key 使用 `sync-ext:` 命名空间并逐个查重，不再生成可能与真实消息 id（如 `sync:e`）碰撞的 `sync:{id}`。
- 用例覆盖：另一条 sync entry 占用 `e#1`、工具占用 `e#1`、旧消息真实 id 为 `sync:e`。

### 4.3 纯空白与乱序

- 空白缺口不再被 `trim()` 丢弃：并入相邻已知段，正文空白保留，且不制造空白合成消息。
- legacy 分段序号不再递增（乱序）→ 整条安全降级为新投影单条消息；不产生重复正文，工具不丢。

### 4.4 未实施的结构性修复（需评审）

在 content Doc 增加有序工具标记记录会同时改动：live writer（工具开始时写标记、幂等/容量/轮转）、生产历史源（按 blockOrder 输出标记）、前端镜像（解析标记并切段）、协议版本与存储契约。该变更超出本轮“只改必要代码、不改 schema/共享协议”的约束，未实施；本轮用确定性边界规则 + 安全降级覆盖可判定场景，并把结构性方案登记为后续。

## 5. 影响面

- **入口**：仅浏览器交互式 Chat 的展示合并（`useChatHydration` 调用合并器，`packages/agent-runtime/web/hooks/use-chat-hydration.ts:147`；新协议默认开启 `yjs-ws.ts:151-153`）。
- **不涉及**：HTTP 单轮调用、Workflow、`/api/*` 调用方；这些路径不消费 `createSyncMessageMerger`。
- **多标签页/重连**：不是触发必要条件；重连后旧快照缺段时，本轮修复保证新投影正文仍可见（H02）。
- **数据影响**：无。仅展示层合并错误，Y.Doc、Redis 快照与数据库内容不受影响。

## 6. 回归测试

新增 `packages/agent-runtime/web/__tests__/sync-chat-entry-merge-adversarial.test.ts`（13 个用例，仓库内可执行）：

- 缺口定位：缺中段落在 `t1`/`t2` 之间、缺首段落在 `t1` 之前、缺尾段落在末段后第一个工具之后、工具数不匹配时安全降级。
- ID 唯一性：另一条 sync entry 占用 `e#1`、工具占用 `e#1`、旧消息真实 id 为 `sync:e`、重复 merge 稳定。
- 空白/乱序/幂等：纯空白保留、乱序 legacy 不重复、旧侧追平与再次落后幂等。
- 真实投影证据：`SyncContentProjectionHub` 跳过 `tool_object`，正文压成一条、`skippedRecords=1`。
- 缺口属性检查：200 轮 × 7 种缺段组合 = **1400 次断言**，正文完整、工具顺序稳定、id 唯一。

更新 `apps/web/src/__tests__/sync-chat-messages.test.tsx`：分页缺中段改为精确断言 `A,t1,B,t2,C`；用户/助手同 key 断言 `sync-ext:e`。`use-chat-hydration.test.tsx` 保留终态/重连尾文可见用例。

## 7. 验证证据

| 命令 | 结果 |
| --- | --- |
| `bun test`（合并器、adversarial、hydration 门控、structured-to-thread、sync 回退权威共 12 个文件） | **189 pass / 0 fail**（含 1400 次属性断言） |
| 旧代码复现（`26821043e` 的两份合并文件 + 同一组反例） | 8/8 反例按预期失败（`A,t1,t2,BC`、`AXYZ`、`ABCA`、`A` 等） |
| `bun run precheck` | **全绿**：12 项静态门禁（Biome + 11 项 STATIC_GATES）；web-app-tests 392 pass、server-and-script-tests 1017 pass、package-tests 11564 pass + 2 skip，均 0 fail，`All passed (230119ms)` |
| `bun run build:web` | **成功**（`✓ built in 1.30s`）；存在项目既有警告（Tailwind `SOURCEMAP_BROKEN` 等），无构建错误 |
| `bun run docs:build` | **成功**（`build complete in 6.37s`）；`env` 语法高亮回退为既有警告 |

门禁计数：`scripts/lib/check-gates.ts` 的 `STATIC_GATES` 为 **11** 项，加 Biome 共 **12 项静态门禁**；此前报告中的“13 项”有误。本文不再引用无法在仓库内复现的 “M01–M18 18/18”；对抗用例与 1400 次属性断言均在上表测试文件中。

## 8. 复发防线

**测试断言（必须保留）**

1. 缺口用例必须同时断言**用户可见正文**与**精确的工具/文本顺序**；只断言正文存在会漏掉跨工具错放。
2. 缺首/中/尾段分别有独立断言；工具数与边界数不一致必须有安全降级断言。
3. 合成 id / 别名 key 必须断言与全部输入 id 不重复（含工具、用户、其他 sync entry）。
4. 纯空白、乱序 legacy、追平/再次落后、重复 merge 必须有回归。
5. 属性检查（200×7）必须在仓库内可执行；不得引用未提交的临时脚本。

**代码评审检查项**

1. 缺口定位是否使用分段序号与工具数量？是否在计数不一致时拒绝猜测？
2. 合成 id 是否对**全部** legacy+sync 消息查重，而不是只看当前 entry？
3. 别名 key 是否可能与真实消息 id 碰撞？是否使用独立命名空间/查重？
4. 乱序输入是否安全降级，而不是用错误顺序推断边界？
5. 空白正文是否被 `trim()` 吞掉？

**日志与可观测信号**

- 展示层无内容日志（合规要求）。排查时用 `?chatSync=0` 对照：关闭新协议后顺序正常，说明命中双路合并面；关闭后仍错序则转向旧投影/后端链路。
- 最小复现：`legacy = [A, t1, t2, C]`、`sync = [ABC]`，输出必须是 `A, t1, B, t2, C`；无法判定时必须整条退化为 `ABC` + 工具，不得产生 `ABCA`。

## 9. 未决与后续

1. **跨投影结构权威（高）**：评估在同步协议中增加有序工具标记记录（content Doc 记录 kind + 历史源 + 镜像解码），让新投影可独立表达工具位置；需评审共享协议、容量、轮转、幂等与版本影响。本轮未实施。
2. **多缺段合并（中）**：两个以上缺失段且工具数匹配时，缺口文本作为单个合成段落在第一个边界之后；内部段边界仍不可知，已在代码注释与本文登记。
3. **M16 异 id 配对（中）**：异 id 未配对时，工具前旧文本可能被退役并显示在条目末尾；正文不丢但顺序不保证，属既有行为，另行跟踪。
4. **真实浏览器/多标签页（中）**：本轮未做真实浏览器抓包；时序结论来自真实 store/hub/hook 与调度语义，需补一次端到端绘制验证。

## 10. 交叉引用

- 架构契约：`docs/arch/19-yjs-chat-streaming.md` §4.2（合并器不变量）、§4.1（新旧协议分流）。
- 前端规范：`docs/developer/system/frontend-development.md` §8.5 第 13 条。
- 历史相关修复：`docs/design/2026-09-24-yjs-chat-callback-routing-fix.md`（双路聚合错位）、`docs/design/2026-10-16-fenix-message-sync-implementation-notes.md` §3（新旧共存与文本退役）、B02「工具分段 entry 保留完整旧结构」。
- 对抗验证原始报告：`.peri/plans/chat-tool-order-adversarial-verification.md`（临时产物，关键证据已并入本文）。
- 代码入口：`packages/agent-runtime/web/hooks/sync-chat-entry-merge.ts`、`packages/agent-runtime/web/hooks/sync-chat-messages.ts`、`packages/agent-runtime/web/yjs/sync-doc-hub.ts`、`packages/chat-channel/src/state/chat-writer.ts`、`packages/chat-channel/src/sync/live/live-writer.ts`、`packages/chat-channel/src/channel/legacy-chat-history.ts`。
