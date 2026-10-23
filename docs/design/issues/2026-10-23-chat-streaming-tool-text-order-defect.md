# 交互式 Chat 流式正文跨工具错序与正文丢失（`ai ai tools`）

> 第六轮收口：只完成已确认问题，以是否仍有 P0（正文/工具丢失、正常流式不可用）为验收标准，不再增加对抗轮次。
> 证据：真实 content Y.Doc / SyncContentProjectionHub / YjsStore / React hook（happy-dom）及 MemoryProjectionStore；未做真实浏览器抓帧。
> 分支：`fix/chat-streaming-tool-text-order`；PR #343 只更新，保持 OPEN，由用户合并。

## 1. 现象与根因

正常一轮 `文本 → 工具 → 文本` 曾显示为 `ai ai tools`：新投影整段正文顶替旧侧工具前段，把工具后正文前移；早期修复又在旧侧停滞时隐藏新正文。

1. 旧 Chat Doc 按 `blockOrder` 拆为 `entryId` / `entryId#N`，携带工具位置。
2. 新 content Doc 原来只表达合并正文，运行态工具不能提供跨 Doc 文本边界。
3. 前序提交引入 `tool_boundary` 标记与显式降级，但第六轮接管的 `41aeae802` 仍有下列反例。撤回此前“所有标记场景均精确、fallback 已全保留、只 seed active 即足够”的结论。
4. 本问题只影响交互式 Chat 展示合并；HTTP `/api`、Workflow 不消费该展示层。

## 2. 接管记录

1. HEAD 为 `41aeae802`，分支正确；10 个未提交文件均与本轮有关，延续实现。
2. `.mcp.json`、`e2e/` 保留，不暂存；未执行 reset/clean/checkout，不删除用户工作。
3. 接管草稿的 `errors[]` 聚合改为保留原助手段的 error：这样不用新增 UI 错误数组，也能保留错误与 thought 的原位置。对应 UI/adapter 文件已回到原内容。
4. 基线失败验证在独立 detached worktree `/tmp/fenix-chat-r6-baseline-41aeae802`，只复制新增测试，主工作区改动未被替换。

## 3. 基线失败 → 修复后证据

命令：

```bash
bun test packages/agent-runtime/web/__tests__/sync-chat-round-six.test.ts packages/chat-channel/src/__tests__/sync-boundary-restart.test.ts
```

在 `41aeae802` 上：**0 pass / 10 fail / 13 expect() calls**。失败均为行为断言，不是加载或环境错误。

| 反例 | 基线实测 | 修复后要求与受影响测试结果 |
| --- | --- | --- |
| ordinal 0 且有前置工具 | `A,t1,t2,B` | `t1,A,t2,B`，正文 `AB`，无降级 |
| 跨 entry 同名工具 | 第二条工具丢失 | 两个 entry 的工具均保留，`A,same,B,same,C,tail,D`，key 唯一且重复 merge 稳定 |
| 同 run 同名工具 | `ABC,same,tail` | `A,same,same,B,tail,C`，run 尾 occurrence 正确，无降级 |
| 缺 t2 marker，旧尾 BC 超前 | `ABCBC` | 正文 `ABBC` 一次（两个 B 是旧侧合法正文），`incomplete-markers`，两个工具均保留 |
| 无新增正文但旧侧有更后段 | `degraded=[]` | 正文 `ABC` 不丢，`incomplete-markers` |
| fallback 多 thought/error | thought 全移到前面；仅第一条 error | chunk 顺序 `A,THINK1,B,THINK2,CD`；两条 error、用户、工具、plan 原位置保留 |
| 重复 id + run 属性模式 | 三个 same 工具只剩一个 | 50×7 = 350 个组合正文/工具完整；有锚点顺序精确，无锚点显式 `missing-text-anchor` |
| sealed 历史跨块 seed | 重写 t0，t2 ordinal=1 | t0 不重写，t2=2；seal/recover/新写者后 t0…t5 序号连续 |
| 显式同名 occurrence 重放 | 第二条 same ordinal=0 | 同名 ordinal 0/1 各一条，相同 occurrence 重放幂等 |
| generation 隔离 | 新代次 old ordinal=0 | 只 seed 当前代次，接在 new=0 后，old=1 |

已有两个 200×7 属性检查保留（合计 2800 个组合），无标记属性与 fallback 回归移至 `sync-chat-fallback.test.ts`，避免原文件超过 500 行；未删除或弱化断言。原 fallback 测试按新契约额外断言精确 chunk 与段顺序，不再要求全部正文集中到第一条助手消息。

## 4. 稳定契约

### 4.1 工具身份与 ordinal 0

1. marker 载荷仍是 `{ toolCallId, ordinal }`，不变更 wire frame 版本或数据库 schema。
2. 身份为 `(entryId, toolCallId, ordinal)`；ordinal 是 entry 内工具 occurrence，包含同 run 连续工具，不是正文段序号。内部写者接受显式 `boundaryOrdinal`，区分同名 occurrence 并保持重放幂等。
3. hub 按 entry 聚合，传播 `entryBoundaryMarkerOrdinal`（段前 run 尾 occurrence）、`entryBoundaryToolId`；结构合并在本 entry 工具列表中定位，不按 id 全局取第一条。
4. 正文 ordinal 0 且工具 id 非空：放该工具之后；只有空值才放第一个工具之前。
5. 通用合并为重复工具/plan occurrence 分配稳定唯一内部 key，避免 Map 覆盖第二条工具。
6. **边界**：无源 occurrence 的旧实时输入仍按 entry/tool 首次出现去重，无法区分完全相同的新调用与重放；不宣称该场景精确。这是非 P0 后续项，不另改 ACP/wire 协议。

### 4.2 完整性与降级

1. hub 检测 marker 缺口、重复 ordinal、缺工具 id，设置 `entryBoundaryIssue`。
2. 合并器比较 `entryBoundaryCount`、正文 ordinal、旧侧锚点前的工具数；旧侧正文段/边界超前即 `incomplete-markers`，不等到有 extra 文本才检查。
3. 结构段携带 occurrence 时同时校验工具 id；未知/歧义工具不能猜位置。旧 marker 无 ordinal 且工具同名时降级；唯一工具的旧字符串 marker 保留原可判定路径。
4. 子串重叠仅作为旧格式“不完整”的证据，不再靠 `extra.includes(later.text)` 作为唯一检查。
5. `onDegraded` 保持显式上报，同一 entry/原因不刷屏。无 marker 旧数据用原启发式降级，无文本锚点仅保证正文/工具保留。

### 4.3 重启 seed

1. 覆盖当前 generation 入口闭包、全部目录页可达的内容块（sealed 历史 + 实时轮转块）和 active 内存态；不扫描其他代次或不可达块。
2. 每块读取 canonical + 连续已提交 tail，不能误把 seq 0 快照当作封口后的完整事实。
3. ordinal 从历史最大值续接；索引在写者生命周期常驻，轮转沿用；recover/新写者重新 seed。
4. 已确认的可达块缺失或目录循环直接报错，不静默跳过造成从 0 重编。
5. 抽取 `committed-doc.ts` 给写者、目录与 seed 复用既有读取逻辑，保持 writer 实现 ≤500 行。

### 4.4 fallback 保真

1. 纯正文 entry 可压成一条；较短同步正文不得覆盖旧侧已显示的完整正文。
2. 含 thought/error 时保留各原助手段和全部 chunk 交错顺序，只在原 message chunk 槽位补缺失正文；每段 error 留在原段，不使用 `.find()` 取第一条。
3. 用户、工具、plan 不移位；工具不能被重复 id 的通用合并吞掉。
4. 不把 fallback 描述为精确工具定位：没有足够边界时正文补齐位置仍是降级近似。

## 5. 验证记录

前五轮报告把相关 **17 文件实际 330 pass / 0 fail** 错写成 314，现更正。下列第六轮数据单独记录，不能混用历史统计。

| 检查 | 第六轮实际结果 |
| --- | --- |
| 基线新用例（2 文件，`41aeae802`） | 0 pass / 10 fail |
| 受影响测试（13 文件） | 200 pass / 0 fail；覆盖真实 YjsStore/hub/hook 与 300 个终态工具轮转 |
| `bun run precheck` | **通过**：12 项静态门禁；web 393 pass、server/script 1017 pass、package 11593 pass + 2 skip，0 fail；`All passed (214320ms)` |
| `bun run build:web` | **通过**：`✓ built in 1.36s`；保留 Vite 配置/弃用提示与 Tailwind sourcemap 警告，无构建错误 |
| `bun run docs:build` | **通过**：首次 6.29s，文档更新后 `build complete in 9.64s`；保留 env 高亮回退与 chunk 大小提示，无构建错误 |
| `bun run fastcheck` | **通过**：静态门禁与受影响测试；本次扩展为三批测试，393/1017/11593 pass + 2 skip，0 fail；`All passed (220513ms)` |
| PR CI | 接管时 HEAD `41aeae802` 的 7 项 Actions 成功；新提交尚未产生，不能沿用旧 CI 证明本轮 |

## 6. 非 P0 后续项与结论边界

受影响 200 用例与完整门禁通过，正常流式 `文本 → 工具 → 文本` 正确，本轮已确认反例未再出现正文/工具丢失；当前验证范围内未发现仍存 P0。该判断不等于无条件精确或穷尽所有输入。

变更 TypeScript 文件均 ≤500 行：writer impl 497、hub 495、原对抗测试 482、通用合并 459、entry 合并 437、types 320、directory 297、新回归 246/226、结构合并 168、boundary index 130、fallback 测试 93、fallback 实现 61、committed reader 31；既有长篇架构/前端文档不另作无关拆分。

1. 旧数据/旧客户端只保证正文与工具不丢，近似顺序，不作无条件精确保证。
2. 无源 occurrence 的同名调用与重放不可区分，不在本轮扩展协议；显式 occurrence、历史 marker 和通用合并的重复工具均有回归覆盖。
3. M16 异 id 未配对：正文不丢但顺序不保证，保留登记。
4. 未做真实浏览器抓帧；happy-dom 的真实 hook 与存储/投影测试不能替代真实绘制验证。
5. 不再新增对抗轮次，不宣称穷尽所有输入；最终 P0 判断限于本轮已确认反例、正常流式与门禁的实际覆盖。

## 7. 交叉引用

- `docs/arch/19-yjs-chat-streaming.md` §4.2。
- `docs/developer/system/frontend-development.md` §8.5 第 13 条。
- 代码：`sync-chat-entry-merge.ts`、`sync-chat-structural-merge.ts`、`sync-chat-fallback.ts`、`sync-chat-messages.ts`、`sync-doc-hub.ts`、`boundary-index.ts`、`committed-doc.ts`。
