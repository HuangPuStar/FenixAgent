# 会话页错误展示优化实现计划

> **面向 AI 代理的工作者：** 使用 executing-plans 在当前会话逐任务执行；用户已授权计划和开发，无需再次确认。用复选框跟踪进度，不创建 commit。

**目标：** 探索失败默认中性展示，详情保留真相，健康接管的同步异常静默，用户操作与终态失败继续反馈。

**架构：** UI 组件负责默认过程与主动详情；agent-runtime 前端读取现有同步证明、按对象归属选择错误提示。协议、Y.Doc、服务端和客户端 transport 不变。

**技术栈：** React 19、TypeScript、Bun、happy-dom、现有 i18next / Radix 组件。

**规格：** [会话页错误展示优化设计](./2026-11-09-chat-error-ux-design.md)。

## 全局约束

- 所有代码在 `.worktrees/chat-error-ux`；仅修改前端、相关测试和文档。
- 不修改 `packages/chat-channel/**`、`packages/acp-link/**`、`packages/agent-runtime/web/yjs/**`。
- 不改变发送保护、命令身份、重连、执行结果、持久化或投影结构。
- 不新增依赖；文件不超过 500 行；文案走中英文 `t()`；新增测试有中文行为注释，不用 `mock.module()`。
- 详情不扩大现有数据访问边界，控制台不输出原始 close reason 或业务内容。

## 文件与职责

- 工具过程：`packages/ui-components/web/chat/view/ActivityChain.tsx`、`chat/lib/activity-chain-summary.ts`、`chat/timeline/ToolCallRow.tsx`、`chat/timeline/HindsightToolCard.tsx`。
- 任务过程与详情：同包 `chat/panels/peri-task-rows.tsx`、`chat/panels/PeriTaskDetailSheet.tsx`。
- 前端提示策略：`packages/agent-runtime/web/agent-panel/chat-error-presentation.ts`，只包含展示选择与当前基线证明的纯逻辑；`ChatPanel.tsx` 负责渲染，`use-chat-panel-runtime.ts` 负责读取已有信号。
- 同步诊断：`packages/agent-runtime/web/hooks/use-sync-chat-state.ts` 的现有降级日志。
- 文案：UI 包 `web/i18n/locales/{zh,en}/uiComponents.json`；必要的连接状态文案沿用 agent-runtime 现有字典。
- 测试：扩展现有工具行、活动链、记忆工具、任务和 runtime 用例；增加 `chat-error-presentation.test.ts` 与真实 ChatPanel 交互用例。
- 长期契约：`docs/arch/19-yjs-chat-streaming.md`、`docs/arch/23-chat-error-diagnostics.md`、`docs/developer/system/frontend-development.md`。

## 审查重点

1. 只有 PublicError 的工具也能查原因，不把错误记录伪装成成功（任务 1）。
2. 任务预览读取失败或过期时，已有失败摘要仍可查；快速切换不串数据（任务 2）。
3. 在线连接和实时增量不是完整性证明；异代、旧连接或换会话不能使同步故障误判健康（任务 3）。
4. 发送未知结果、认证失败、独立 Error ID 不可被去重或恢复逻辑吞掉（任务 4）。
5. 健康接管后失去健康状态时，必要提示恢复；重渲染不重复诊断，日志不含业务内容（任务 3、4）。

## 任务 1：工具过程默认中性，主动详情保留原因

- [x] 扩展 `activity-chain.test.tsx`、`tool-call-row-inline-detail.test.tsx`、`hindsight-tool-group-ssr.test.tsx`：失败汇总/摘要默认不出现；工具仍存在，展开可见错误；没有输出的失败也有详情；嵌套失败同样降噪。
- [x] 运行对应 `bun test --isolate <文件>`，确认新增行为断言失败。
- [x] 删除活动链的失败展示及无用失败计数；工具行保留原图标，终态失败不显示失败状态；详情展开区显示真实状态、安全原因或「未提供失败详情」。记忆卡片同步处理，复用现有详情入口和字典。
- [x] 运行工具、记忆、活动链相关测试，确认通过且等待授权/取消与输出详情行为保留。

## 任务 2：任务列表中性，详情保留失败摘要

- [x] 修改 `peri-task-rows.test.tsx`：列表显示「已结束」而不出现错误摘要；点开后可见真实失败与原因；预览不可用/失败时原因仍可见；保留加载/取消/切换行为。
- [x] 运行 `bun test --isolate packages/ui-components/web/__tests__/peri-task-rows.test.tsx`，确认新增行为失败。
- [x] 列表去掉红叉与失败摘要；详情头部使用任务投影展示真实状态和失败原因，不依赖预览请求成功。
- [x] 重跑该文件，确认通过。

## 任务 3：仅根据当前会话基线证明静默同步故障

- [x] 增加纯策略测试与 runtime 集成测试：1011 失败后快照、ACP session 和历史未就绪时不判健康；当前两份文档同代交付且会话就绪时判健康；旧连接、换代与历史缺失使证明失效。
- [x] 运行新增测试确认失败。
- [x] 在 `chat-error-presentation.ts` 定义 `isLegacyFallbackUsable(input): boolean`、基线证明类型及验证函数；输入只读。runtime 保存现有 `onSyncComplete` 的当前文档代次/会话 scope，派生仅供展示使用的 `legacyFallbackUsable`。不修改原发送门控。
- [x] 现有降级日志只记录有界传输码和阶段，删除原始 reason；不在 render 中记录日志。
- [x] 运行新增策略、runtime、现有历史恢复及同步 fallback 测试，确认通过。

## 任务 4：提示去重、恢复清理与真实面板接线

- [x] 增加 `selectChatErrorNotices(input): PublicErrorInfo[]` 测试：同 ID 优先消息/操作，独立 ID 保留；健康 fallback 的同步故障静默，未知错误、操作失败和 Agent 失败保留。
- [x] 增加真实面板用例：健康降级无红卡但可发送；历史缺失有单一恢复提示；消息末尾与顶部不重复；自动重连优先轻状态，认证/终态保留反馈。
- [x] 运行用例确认失败，再将纯策略接入 `ChatPanel`。客户端 transport 故障使用现有通用状态展示，不伪造 PublicError ID；只对属于该连接且已恢复的提示退出显示。
- [x] 操作临时提示按会话 scope 隔离，已确认回执仅清除对应 commandId 的提示；草稿未知结果逻辑不变；现有时间隐藏仍保留。
- [x] 重跑新用例及发送/重连/组织隔离回归，确认通过。

## 任务 5：契约、完整验证和审查

- [x] 更新三份长期文档，检查规格每项均有实现与测试。
- [x] 运行已修改范围的只读 Biome 检查，修复本次新增诊断；确认全局自动格式化不会改写无关文件。
- [x] 运行 `bun run fastcheck`、`bun run build:web`、`bun run docs:build`、`bun run precheck`，逐项检查退出码与输出；只修复与本次有关的问题。
- [x] 根据 executing-plans 的最终审查要求，使用独立审查者检查完整 diff，修复必要问题并补回归。
- [x] 检查变更路径与底层禁改目录、文件行数、工作区状态，记录测试结论；保留 worktree 供用户审阅。

## 验证结果

- `bun run fastcheck`：通过。
- `bun run precheck`：通过；13,348 项通过，118 项跳过，0 失败。
- `bun run build:web`、`bun run docs:build`：通过。
- 独立审查发现的 3 项重要问题均以 RED → GREEN 回归修复：重连次数耗尽、迟到重复操作错误、独立操作错误互相覆盖。
- 保留范围限制：没有当前完整交付证明时继续显示中性同步状态；底层 transport 日志保持原样。延后轻微问题：交错重复的 Error ID 可能重复打印控制台诊断。
- 未创建 commit；保留工作树供审阅。
