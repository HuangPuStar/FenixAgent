# 交互式 Chat 流式正文跨工具错序与正文丢失缺陷（`ai ai tools`）

> 状态：**已修复（结构性有序工具边界标记 + 完整性校验 + 显式降级）**。
> 证据等级：静态代码证据 + 包内最小复现 + 真实 Chat Doc / SyncContentProjectionHub / YjsStore / React hook（happy-dom）；未做真实浏览器抓包。
> 行号基准：本轮修复后的工作区内容（分支 `fix/chat-streaming-tool-text-order`），引用优先看函数名，行号仅作定位辅助。
> 相关不变量：`docs/arch/19-yjs-chat-streaming.md` §4.2「有序工具边界标记 / 旧侧不追平不得隐藏正文」；`docs/developer/system/frontend-development.md` §8.5 第 13 条。

## 1. 现象与触发条件

用户可见现象：同一轮回答里，助手先输出一段文本、随后调用工具、再输出一段文本，流式过程中第二段文本会**跑到工具之前**，形成 `ai ai`（两段文本相邻）+ 工具的顺序，即用户描述的 `ai tools ai → ai ai tools`；旧路径补齐分段后顺序恢复，表现为逐帧跳动。

修复轮次（保留为诊断历史）：

1. **第一轮（#341）**：只保证工具前文本不被整段顶替，导致旧侧缺段时新投影正文被永久隐藏（`AB`、`AC`）。
2. **第二轮（#342）**：覆盖感知的无损合并解决正文丢失，但缺口跨工具、合成 id 冲突。
3. **第三轮（f150f7d15）**：启发式边界、安全降级、全局唯一 id；仍无法精确处理多缺段/工具 run，并暴露 marker 终态写入、完整性、fallback 非文本保留问题。
4. **第四轮（本提交）**：补齐 marker 写入/去重/完整性/工具 run 映射/fallback 非文本保留，并拆分超长文件。

精确触发条件：

1. 交互式 Chat（浏览器）走**新旧双路展示合并**：新同步协议默认开启（`packages/agent-runtime/web/yjs/yjs-ws.ts:151-153`，只有显式 `?chatSync=0` 回退）；
2. 同一助手 entry 内出现 **文本 → 工具调用 → 文本**，旧投影按工具位置把 entry 切成 `entryId` / `entryId#N` 多段；
3. 两路投影进度不一致：新投影已包含工具后的正文、旧侧尚未成段；或分页/重连导致旧侧缺首段、中段、尾段。

不触发：纯文本流（无工具）、无工具的历史消息、`chatSync=0` 的纯旧链路、HTTP `/api` 与 Workflow（两者不消费该展示合并层）。

## 2. 根因与结构性结论

根因位于**前端展示合并层**，本质是**双投影信息不等价**：旧投影带工具位置，新投影原先把整条 entry 压成一条正文。

1. 后端 Chat Doc 顺序正确：`appendEntryText` 只在末尾追加，工具块插入后新建 `text:N` 块（`chat-writer.ts:283-332`）；展示派生按 `blockOrder` 切段（`chat-doc-to-structured.ts:157-217`）。
2. 旧 content Doc 没有有序工具边界：非终态工具只写运行态实体，终态才写按完成时间追加的 `final` 记录；运行态是 `Y.Map` 无跨 Doc 顺序；历史源原先只发 `text_part`。
3. 因此仅靠字符串/分段序号推断无法覆盖多缺段、工具 run、部分 marker 缺失。**结论：在 content Doc 增加有序工具边界标记**。

## 3. 对抗验证失败矩阵与最终结果

### 3.1 第三轮及更早（保留）

| 编号 | 构造 | 旧结果 | 最终结果 |
| --- | --- | --- | --- |
| M07 | 旧 `[A,t1,t2,C]`，新 `ABC` | `AC`（B 丢） | `A,t1,B,t2,C` |
| M08 | 旧 `[A,t]` 永久停滞，新 `AB` | 只显示 `A` | 标记存在 `A,t,B`；无标记整条降级 |
| M09 | 旧 `[A,t,B]`，新增长 `ABC` | 丢 `C` | `A,t,BC` |
| R02 | 新侧 `final`，`ABFINAL` | 尾部不可见 | 标记存在精确；无标记降级不丢 |
| H01/H02 | 终态/重连 scope | `A\|[tool]\|B` | 正文 `ABC`，重建后仍完整 |
| N1a/N1b/N1c | 缺中/首/尾段跨工具 | 跨工具错放 | 标记存在精确；无标记只处理单缺口单工具 |
| N2/N3/N4 | 合成 id / `sync:e` 冲突 | 覆盖工具/旧消息 | 合成 id 全局查重，`sync-ext:` 命名空间 |
| N5/N6 | 空白/乱序 | 空白丢失/`ABCA` | 空白保留；乱序整条降级 |

### 3.2 第四轮（本轮修复）

旧代码 `f150f7d15` 复现（临时脚本或验证报告）：

| 编号 | 构造 | 旧结果 | 本轮结果 |
| --- | --- | --- | --- |
| F1 | 工具首帧自带 `terminal:true` | 记录 `["text","final","final"]`，无 marker | 先写 `tool_boundary` 再写 final；重放只保留一条 |
| F2 | 不同 entry 复用同名 toolCallId | boundaries length 1 | `(entryId, toolCallId)` 去重，两条边界 |
| F3 | 缺 `t2` marker，保留 B/C | `ABCC`，`degraded=[]` | 检测跨旧段缺口，整条降级，正文 `ABC` 一次，触发 `incomplete-markers` |
| F4 | 工具 run `A,t1,B,t2,t3,C`，旧侧缺 B | 整条 fallback `ABC,t1,t2,t3` | `A,t1,B,t2,t3,C`（`entryBoundaryToolId=t1`） |
| F5 | fallback 旧段带 thought/error | `THINK`/`ERR` 消失 | 挂到合并消息，正文/工具/thought/error 全保留 |

## 4. 修复

### 4.1 Marker 写入与去重

- **终态首帧也写 marker**：`live-writer-impl.ts` 在 terminal/final 分支之前写 `tool_boundary`；标准 `tool_call`、内部 `tool_call_started`、`tool_call_update`、`tool_call_result/error` 都携带边界意图，写者按 `(entryId, toolCallId)` 只落第一次。
- **身份**：`boundary-index.ts` 的 `BoundaryIndex` 以 `(entryId, toolCallId)` 为键，序号按 entry 递增；不同 entry 同名工具各写一条，重放/终态更新不重复。
- **性能**：索引在写者生命周期常驻，首次从当前内容块一次性 seed，之后每工具 O(1)；轮转沿用，恢复时重建。
- **取消/失败**：终态首帧仍写边界；已开始的工具失败不重复写。
- **轮转顺序**：终态事件若触发内容块软水位轮转，必须先完成轮转再写边界；否则边界落在已封口 Doc，`overflowOf` 无法把它当作写目标（`DOC_NOT_FOUND`，300 个终态工具回归覆盖）。

### 4.2 边界完整性

- marker 载荷为 `{ toolCallId, ordinal }`；实时写入与历史导入都生成 ordinal。
- `sync-doc-hub`/`sync-doc-parse` 解析 ordinal，输出 `entryBoundaryOrdinal`、`entryBoundaryToolId`（本段之前 run 尾工具）、`entryBoundaryCount`、`entryBoundaryIssue`。
- 序号缺口/重复 → `entryBoundaryIssue=true`；合并器检测到即整条降级 `incomplete-markers`。
- **部分 marker 缺失**：同步段正文若跨过后续旧段（`extra.includes(later.text)`），整条降级，避免 `ABCC`；正文只出现一次、工具与 thought/error 保留。
- 无 marker（旧数据）走 `markers-missing`/启发式；部分 marker 缺失走 `incomplete-markers`，两种原因区分。

### 4.3 工具 run 与结构合并

- `sync-chat-structural-merge.ts` 用 `entryBoundaryToolId` 定位缺失段：该 id 是段前工具 run 的**最后一个工具**，因此 `A,t1,B,t2,t3,C` 的 B 落在 t1 之后、t2 之前；无需工具计数推断。
- 缺首段（ordinal 0）落在第一个工具之前；缺中/尾段落在对应 `entryBoundaryToolId` 之后。
- 已有段保留旧消息（thought/error 不丢），只追加同步多出的正文。
- fallback 只替换文本段：合并消息的 chunks = 旧 thought 等非文本 chunk + 同步正文；旧 entry error 挂到合并消息，用户/工具/plan 原样保留。

### 4.4 文件拆分（行为/导出不变）

- `sync-doc-hub.ts` 拆出 `sync-doc-parse.ts`（464 + 170 行）。
- `live-writer.ts` 拆为公开门面（20 行）+ `live-writer-impl.ts`（500 行）+ `live-writer-types.ts`（71）+ `live-writer-records.ts`（36）+ `live-writer-internal.ts`（约 46）+ `boundary-index.ts`（77）。所有文件 ≤500 行，公开导出保持。

## 5. 兼容性与已知语义

- **数据库**：无 schema 变更、无 DB 迁移。
- **wire 协议**：`tool_boundary` 是 content Doc 内部记录 kind，frame 版本不变。
- **旧客户端**：跳过未知 kind，只显示合并正文；不丢正文，但**不保证精确工具顺序**。
- **旧内容 Doc（无 marker）**：新客户端启发式 + `onDegraded`；只处理单缺口单工具等可判定场景，**精确顺序不作保证**。
- **容量/轮转**：marker 是小型 content 记录，沿用既有上限；镜像按 `(docRank, recordIndex)` 聚合、按 `(entryId, toolCallId)` 跨块去重。
- **写者重启**：ordinal 从当前活动内容块重建；若旧块中的 ordinal 未纳入，镜像可能检测到重复/缺口并显式降级，不产生错误顺序。

## 6. 回归测试

| 文件 | 覆盖 |
| --- | --- |
| `sync-chat-entry-merge-adversarial.test.ts` | 28 个用例：标记存在多缺段/缺首+中/缺尾 run/工具 run 缺中段/重复子串精确顺序；无标记降级；fallback 同 id 用户/工具/plan；fallback thought/error；部分 marker 缺失；序号缺口；真实 hub；200×7 无标记属性 + 200×7 标记属性 |
| `sync-live-writer.test.ts` | 工具开始写边界、终态首帧写边界、同 toolCallId 重放、跨 entry 同名工具各写一条 |
| `legacy-chat-history.test.ts` | `blockOrder` 输出 text_part / tool_boundary（含 ordinal） |
| `sync-runtime-ingress.test.ts` | 工具事件携带 boundary 意图 |
| `sync-chat-messages.test.tsx` / `use-chat-hydration.test.tsx` | 真实 Chat Doc/hub 降级；真实 YjsStore + hub + hook 标记精确落位；终态/重连 |
| `sync-chat-projection.test.ts` / `sync-chat-session.test.ts` | 分段消息元数据（entryBaseId / boundary*） |

相关 17 个测试文件：**314 pass / 0 fail**（两个属性测试各 1400 次，合计 2800 次断言；含 300 个终态工具的轮转回归）。

## 7. 验证证据

| 命令 | 结果 |
| --- | --- |
| `bun test`（17 个相关文件） | **314 pass / 0 fail** |
| 旧代码复现（`f150f7d15`） | 工具 run fallback `ABC,t1,t2,t3`；部分 marker `ABCC`；fallback 丢失 thought/error；终态/跨 entry 见验证报告 |
| `bun run precheck` | **全绿**：12 项静态门禁；web-app 393 pass、server 1017 pass、package 11583 pass + 2 skip，0 fail，`All passed (212900ms)` |
| `bun run build:web` | **成功**（`✓ built in 1.29s`）；仅既有 Tailwind `SOURCEMAP_BROKEN` 等警告，无构建错误 |
| `bun run docs:build` | **成功**（`build complete in 6.12s`）；`env` 语法高亮回退为既有警告 |

门禁计数：`STATIC_GATES` 为 **11** 项，加 Biome 共 **12 项静态门禁**。

## 8. 复发防线

1. marker 写入必须覆盖 terminal 首帧；去重身份必须是 `(entryId, toolCallId)`，不得只比 tool id。
2. 每段必须带 `entryBoundaryToolId`（run 尾）与 ordinal；序号缺口/重复必须降级。
3. 部分 marker 缺失必须通过“同步段跨旧段正文”检测，禁止把后续段追加到当前段。
4. fallback 只替换文本，thought/error/用户/工具/plan 必须保留。
5. 测试必须断言精确顺序 + 正文一次 + 非文本保留 + 降级原因；属性检查需同时覆盖无标记与标记存在两种模式。
6. 单文件 ≤500 行；新增写入/解析逻辑优先拆到职责模块。

## 9. 未决

1. 旧数据/旧客户端只保证正文与工具不丢，精确顺序不保证；已在文档中明确。
2. 写者重启时若没有重建全部内容块的 ordinal，镜像会以 `entryBoundaryIssue` 降级；后续可在 generation 入口携带边界计数。
3. M16 异 id 未配对：正文不丢但顺序不保证，属既有行为。
4. 未做真实浏览器抓包；链路覆盖真实 YjsStore/hub/hook，仍需一次端到端绘制验证。

## 10. 交叉引用

- 架构契约：`docs/arch/19-yjs-chat-streaming.md` §4.2。
- 前端规范：`docs/developer/system/frontend-development.md` §8.5 第 13 条。
- 历史相关：`docs/design/2026-09-24-yjs-chat-callback-routing-fix.md`、`docs/design/2026-10-16-fenix-message-sync-implementation-notes.md`、B02「工具分段 entry 保留完整旧结构」。
- 对抗验证原始报告：`.peri/plans/chat-tool-order-adversarial-verification.md`（临时产物，关键证据已并入本文）。
- 代码入口：`sync-chat-entry-merge.ts`、`sync-chat-structural-merge.ts`、`sync-chat-heuristic-merge.ts`、`sync-chat-merge-types.ts`、`sync-doc-hub.ts`、`sync-doc-parse.ts`、`live-writer.ts` / `live-writer-impl.ts` / `boundary-index.ts`、`legacy-chat-history.ts`。
