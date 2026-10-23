# 交互式 Chat 流式正文跨工具错序与正文丢失缺陷（`ai ai tools`）

> 状态：**已修复（结构性有序工具边界标记 + 无标记安全降级）**。
> 证据等级：静态代码证据 + 包内最小复现 + 真实 Chat Doc / SyncContentProjectionHub / YjsStore / React hook（happy-dom）；未做真实浏览器抓包。
> 行号基准：本轮修复后的工作区内容（分支 `fix/chat-streaming-tool-text-order`），引用优先看函数名，行号仅作定位辅助。
> 相关不变量：`docs/arch/19-yjs-chat-streaming.md` §4.2「有序工具边界标记 / 旧侧不追平不得隐藏正文」；`docs/developer/system/frontend-development.md` §8.5 第 13 条。

## 1. 现象与触发条件

用户可见现象：同一轮回答里，助手先输出一段文本、随后调用工具、再输出一段文本，流式过程中第二段文本会**跑到工具之前**，形成 `ai ai`（两段文本相邻）+ 工具的顺序，即用户描述的 `ai tools ai → ai ai tools`；旧路径补齐分段后顺序恢复，表现为逐帧跳动。

前置修复轮次（保留为诊断历史）：

1. **第一轮（#341）**：只保证工具前文本不被整段顶替，导致旧侧缺段时新投影正文被永久隐藏（`AB`、`AC`）。
2. **第二轮（#342）**：覆盖感知的无损合并解决了正文丢失，但缺口按“下一个已知段之前”注入，会跨越工具；合成 id/别名 key 未做全局唯一性检查。
3. **第三轮（本分支）**：先是启发式边界与安全降级；仍无法满足“精确工具位置”。本轮追加**结构性有序工具边界标记**，从根上消除缺口定位歧义。

精确触发条件：

1. 交互式 Chat（浏览器）走**新旧双路展示合并**：新同步协议默认开启（`packages/agent-runtime/web/yjs/yjs-ws.ts:151-153`，只有显式 `?chatSync=0` 回退）；
2. 同一助手 entry 内出现 **文本 → 工具调用 → 文本**，旧投影按工具位置把 entry 切成 `entryId` / `entryId#N` 多段；
3. 两路投影进度不一致：新投影已包含工具后的正文、旧侧尚未成段；或分页/重连导致旧侧缺首段、中段、尾段。

不触发：纯文本流（无工具）、无工具的历史消息、`chatSync=0` 的纯旧链路、HTTP `/api` 与 Workflow（两者不消费该展示合并层）。

## 2. 根因与结构性结论

根因位于**前端展示合并层**，本质是**双投影信息不等价**：旧投影带工具位置，新投影原先把整条 entry 压成一条正文。

**(a) 后端 Chat Doc 顺序正确。** `appendEntryText` 只在末尾追加文本，工具块插入后再次输出文本会新建 `text:N` 块（`packages/chat-channel/src/state/chat-writer.ts:283-332`）；展示派生按 `blockOrder` 切段（`packages/web-runtime/web/chat/chat-doc-to-structured.ts:157-217`）。

**(b) 旧 content Doc 没有有序工具边界。**

1. 非终态工具只写运行态实体（`live-writer.ts` 的 `writeSemantic` 非终态分支）；终态才写 content Doc 的 `final` 记录，按完成时间追加。
2. 运行态实体是 `Y.Map`、键为 `entityId`，没有跨 Doc 的有序序列。
3. 前端镜像只接受 content Doc，且原先跳过 `tool_object`。
4. 生产历史源原先只输出 `text_part`。

因此旧数据只能从分段序号与工具数量推断边界；多缺段、尾段跨工具、重复子串等场景不可判定。**结论：必须在 content Doc 增加有序工具边界标记**，而不是继续加启发式。

## 3. 第三轮对抗验证失败与最终结果

以下反例先在旧代码（`26821043e`）上原样运行失败，再于本轮通过（无标记时显式降级，标记存在时精确）：

| 编号 | 构造 | 旧结果（错误） | 最终结果 |
| --- | --- | --- | --- |
| 1 | 旧 `[A,t1,t2,t3,D#3]` + 新 `ABCD` | `A,t1,BC,t2,t3,D` | 标记存在：`A,t1,B,t2,C,t3,D`；无标记：整条降级 |
| 2 | 旧 `[A,t1,t2]` + 新 `AB` | `A,t1,B,t2`（猜测） | 标记存在：`A,t1,t2,B`；无标记：整条降级 |
| 3 | 旧 `[t1,t2,C#2]` + 新 `ABC` | `AB,t1,t2,C` | 标记存在：`A,t1,B,t2,C`；无标记：整条降级 |
| 4 | 旧 `[A,t1,t2,t3]` + 新 `AB` | `A,t1,B,t2,t3` | 无标记安全降级；标记存在按 run 精确落位 |
| 5 | fallback 复用被消费 base id | 用户/工具/plan 被覆盖 | 合成 id 在全部 legacy+sync id 中查重，均保留 |
| 6 | 旧 `[A,t1,t2,B#2]` + 新 `AABB` | `A,t1,A,t2,BB` | 无标记：判歧义降级；标记存在：`A,t1,AB,t2,B` |
| 7 | 1400 次属性检查只断言正文/工具存在 | 无法捕获错位 | 新增标记存在时的精确顺序用例；属性检查保留无丢失断言 |
| 8 | 报告计数/行号不一致 | 189/行号/过度外推 | 本文按最终代码与实际测试重写 |

## 4. 修复

### 4.1 第一段：确定性回归

1. **fallback id 全局唯一**：合成消息 id 在全部 legacy + sync 消息 id（用户、工具、计划、其他 sync entry）中查重；被消费的 sync base id 只有在没有保留消息占用时才让位。`nextFreeEntryId`（`sync-chat-entry-merge.ts:52`）与 `uniqueMessageKey`（`sync-chat-messages.ts`）共同保证。
2. **尾段一致性**：无标记时尾段跨工具不再猜测，整条降级；有标记时按工具 run 精确落位。
3. **锚定式对齐**：同一段文本在后续位置重复出现时判为歧义并降级，不再贪心拆分（`sync-chat-heuristic-merge.ts` 的 `alignSegmentsToSyncText`）。
4. **纯空白保留**：空白缺口并入相邻已知段，不丢失、不制造空消息。
5. **乱序 legacy 安全降级**：分段序号不再递增时整条退化为新投影单条消息，保留工具与输入顺序。

### 4.2 第二段：有序工具边界标记（核心）

1. **记录格式**：content Doc 新增 `kind: "tool_boundary"` 记录，载荷为工具 id 的 JSON 字符串，`entryId` 为所属助手 entry，`contentSlot: "boundary"`。
2. **实时写入**：`live-writer.ts:324` 在工具开始时、文本 barrier 之后写标记；同一 `toolCallId` 重放不写第二条（扫描当前 content Doc）。`ingress.ts:425`/`:503` 只对 `tool_call_started`（及标准 `tool_call`）置 `boundary: true`；`host-session.ts:403-405` 保留 started 语义。
3. **历史导入**：`legacy-chat-history.ts:46` 按旧 entry 的 `blockOrder` 输出 `text_part` 与 `tool_boundary`；`ingest.ts` 的 `HistoryRecordKind` 接受新 kind。
4. **镜像切段**：`sync-doc-hub.ts:205` 解析 `tool_boundary`，`buildProjection`（`:390`）按有序 parts 把文本切成段；连续边界不产生空段，同一 `toolCallId` 的重复标记被忽略；输出 `entryId` / `entryId#N` 消息并带 `entryBaseId`（`:455`），兼容入口 id 自身含 `#`。
5. **精确合并**：`sync-chat-structural-merge.ts:60` 的 `planStructuralGroup` 用段序号与工具边界定位：
   - 已有段：保留旧消息（thought/error 不丢），只追加同步多出的正文后缀；
   - 缺失段：`tools.length === required` 时逐工具定位，最后一个边界落在最后一个工具之后；中间边界无法拆分时降级；
   - 段序号不连续、正文互不为前缀、旧侧无文本锚点 → fallback。
6. **无标记降级**：`sync-chat-heuristic-merge.ts` 只处理单缺口单工具等可判定场景；多缺段/尾段跨工具/重复子串/乱序一律整条降级。`createSyncMessageMerger({ onDegraded })` 每个 `entryId + reason` 只上报一次；hook 以 content-free `console.warn` 记录（展示层无现成用户提示面，最小实现为安全结构 + 遥测）。

### 4.3 兼容性、容量与幂等

- **协议版本**：`tool_boundary` 是 content Doc 内部记录 kind，wire frame 版本不变；旧客户端跳过未知 kind，仍显示合并正文（不丢正文）；旧内容 Doc 无标记时新客户端走启发式 + 显式降级。
- **数据库**：无 schema 变更、无迁移；历史迁移指旧 content Doc 无标记的降级，不是 DB 数据迁移。
- **容量/轮转**：标记是小型 content 记录，沿用既有记录/字节上限；镜像跨内容块按 `(docRank, recordIndex)` 聚合，边界按 `toolCallId` 跨块去重。
- **幂等/重放**：写入侧按 `toolCallId` 去重；镜像侧再次去重；合并器每次从投影重新计算，重复 merge 稳定。
- **旧数据**：无标记时不会崩溃、不会隐藏正文；`onDegraded` 给出原因码。

## 5. 影响面

- **入口**：仅浏览器交互式 Chat 的展示合并（`useChatHydration` 调用合并器，`packages/agent-runtime/web/hooks/use-chat-hydration.ts:95` 附近；新协议默认开启）。
- **不涉及**：HTTP 单轮调用、Workflow、`/api/*` 调用方。
- **数据影响**：content Doc 新增少量标记记录；无数据库变更；旧客户端/旧文档兼容。

## 6. 回归测试

| 文件 | 覆盖 |
| --- | --- |
| `packages/agent-runtime/web/__tests__/sync-chat-entry-merge-adversarial.test.ts` | 标记存在：多缺段/缺首+中/缺尾 run/重复子串精确顺序；无标记：单缺口可判定、多缺段/尾段跨工具/重复子串降级；fallback 同 id 用户/工具/plan；降级回调去重；真实 hub 跳过/解析边界；200×7=1400 次属性断言 |
| `packages/chat-channel/src/__tests__/legacy-chat-history.test.ts` | `blockOrder` 输出 text_part / tool_boundary 顺序与 partIndex |
| `packages/chat-channel/src/__tests__/sync-live-writer.test.ts` | 工具开始写入边界记录、同 toolCallId 重放不重复 |
| `apps/web/src/__tests__/sync-chat-messages.test.tsx` | 真实 Chat Doc 中间态降级；真实 hub 无标记降级；同 key/空白/分段/用户配对 |
| `apps/web/src/__tests__/use-chat-hydration.test.tsx` | 终态/重连尾文可见；真实 `YjsStore + SyncContentProjectionHub + useChatHydration` 标记精确落位 |
| `apps/web/src/__tests__/sync-chat-projection.test.ts` | 投影窗口/跨块顺序/final ts；分段消息带 `entryBaseId` |

相关 14 个测试文件：**227 pass / 0 fail**（含 1400 次属性断言）。

## 7. 验证证据

| 命令 | 结果 |
| --- | --- |
| `bun test`（14 个相关文件） | **227 pass / 0 fail** |
| 旧代码复现（`26821043e` + 同一组反例） | 8/8 反例按预期失败（`A,t1,t2,BC`、`AXYZ`、`ABCA` 等） |
| `bun run precheck` | **全绿**：12 项静态门禁（Biome + 11 项 STATIC_GATES）；web-app-tests 393 pass、server-and-script-tests 1017 pass、package-tests 11576 pass + 2 skip，均 0 fail，`All passed (215213ms)` |
| `bun run build:web` | **成功**（`✓ built in 1.28s`）；存在项目既有警告（Tailwind `SOURCEMAP_BROKEN` 等），无构建错误 |
| `bun run docs:build` | **成功**（`build complete in 5.96s`）；`env` 语法高亮回退为既有警告 |

门禁计数：`scripts/lib/check-gates.ts` 的 `STATIC_GATES` 为 **11** 项，加 Biome 共 **12 项静态门禁**。本文不再引用无法在仓库内复现的临时矩阵脚本；所有反例均在上述测试文件中。

## 8. 复发防线

1. 标记存在时必须断言**精确工具/文本顺序**；标记缺失时必须断言**明确降级结构 + 回调**，不接受“只断言正文存在”。
2. 新增/修改 `tool_boundary` 写入点：必须覆盖 live writer 与历史导入两条路径，并验证同一 `toolCallId` 重放幂等。
3. 合成 id / 别名 key 必须对全部 legacy+sync 消息查重，包括用户、工具、计划与其他 sync entry。
4. 内容 Doc 轮转/跨块场景必须验证边界去重与分段顺序。
5. 旧数据无标记路径必须走 `onDegraded`；不得把启发式猜测当作精确结果。
6. 属性检查保留“正文完整、工具不丢、id 唯一”；精确顺序由标记用例单独覆盖。

## 9. 未决与后续

1. **额外尾随工具 run**：若缺失的最后一个文本段之后还有只有工具、没有正文的 run，当前标记消息不暴露空边界计数；极端情况下最后一段可能落在最后一个工具之后。需要后续在投影消息上补充边界计数/run 元数据。
2. **M16 异 id 未配对**：正文不丢但顺序不保证，属既有行为，另行跟踪。
3. **真实浏览器/多标签页**：本轮未做真实浏览器抓包；链路覆盖真实 YjsStore/hub/hook，仍需一次端到端绘制验证。
4. **协议演进**：旧客户端跳过未知 kind 的行为需在真实旧版本客户端上验证；新记录 kind 的容量画像建议在压测中观察。

## 10. 交叉引用

- 架构契约：`docs/arch/19-yjs-chat-streaming.md` §4.2（有序工具边界标记、降级语义）。
- 前端规范：`docs/developer/system/frontend-development.md` §8.5 第 13 条。
- 历史相关修复：`docs/design/2026-09-24-yjs-chat-callback-routing-fix.md`、`docs/design/2026-10-16-fenix-message-sync-implementation-notes.md`、B02「工具分段 entry 保留完整旧结构」。
- 对抗验证原始报告：`.peri/plans/chat-tool-order-adversarial-verification.md`（临时产物，关键证据已并入本文）。
- 代码入口：`packages/agent-runtime/web/hooks/sync-chat-entry-merge.ts`、`sync-chat-structural-merge.ts`、`sync-chat-heuristic-merge.ts`、`sync-chat-merge-types.ts`、`packages/agent-runtime/web/yjs/sync-doc-hub.ts`、`packages/chat-channel/src/sync/live/live-writer.ts`、`packages/chat-channel/src/channel/legacy-chat-history.ts`。
