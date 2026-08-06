# 测试方针与覆盖重点

> 本文回答三个问题：**测什么点**（§2、§4 覆盖原则与重点清单）、**用什么策略测、资源往哪投**（§3、§5）、**门槛是什么**（§6-§8）。
> §1 是测试现状的数据快照（实测，不是推断），季度复查更新；策略与优先级以它为输入。
> 测试写法与工程约定以《后端开发规范》《前端开发规范》及根目录 `CLAUDE.md` 为准，本文不重复。

## 1. 测试现状

> 本文所有数字来自实测：`bun run coverage:audit`（内部执行 `bun test --coverage` 并输出审计报告，基线耗时约 25s）。
> **统一口径（已固化为 `scripts/coverage-audit.ts`，下同）**：
> - 覆盖 = **行覆盖**（`% Lines`，Bun 报告第二列）；函数覆盖（第一列 `% Funcs`）仅作参考——Bun 报告列序曾导致"函数覆盖 0%"被误读为"行覆盖 0%"。
> - 0% = 行覆盖为 0；低覆盖 = 行覆盖 < 30%。
> - **未加载** = 从未被任何测试 import 的文件。Bun 报告只列出被测试加载过的文件，未加载文件不会出现，必须与全量源文件对比（脚本自动完成，见 §1.5）。
> - **全局均值口径**：bun 的 "All files" 是**被加载文件**的百分比简单均值（不含测试文件，也不计入未加载文件）；计入未加载（按 0 计）后的整体均值另行输出（2026-08-06 实测：71.22% vs 45.15%）。

### 1.1 总量

| 范围 | 测试文件 | test 数 | 说明 |
|------|---------|---------|------|
| 后端 `src/` | 176 | 1052 | 覆盖集中度高 |
| 前端 `web/` | 72 | 507+ | 纯逻辑强、页面组件弱 |
| `packages/*` | 70 | ~1050 | 健康度分化大 |
| **全仓** | **318（bun 报 350，差异为 workspace symlink 重复计数）** | **2613** | 被加载文件行覆盖均值 71.2%（计入未加载后整体 45.2%） |

### 1.2 后端 `src/`

报告内被测文件 227 个：**行覆盖 <30% 共 35 个；行覆盖为 0% 的 0 个**（函数覆盖为 0% 的有 43 个，多数行覆盖 3%~30%，是低覆盖而非零覆盖）。

| 模块 | 覆盖状况（行覆盖） | 判定 |
|------|---------|------|
| 认证/权限（`auth/`、`plugins/`、`resource-permission` 测试侧） | token/trusted-origins/require-team-scope/system-api-auth 100%；**`auth/encryption.ts` 30%**（函数 0%）；`plugins/auth.ts` 54% | P0 缺口 |
| **repository 层（21 个文件）** | **全部有行覆盖（3.82%~100%），无一行 0%**；13 个 <30% 为真实低覆盖区：knowledge-base 3.82%、resource-permission 4.55%、share-link 5.94%、environment 5.11%、workflow-def 7.79%、task 10.71%、workflow-trigger 12.77%、channel-binding 13.04%、prod-view 18.06%、agent-machine 20%、user 21.43%、agent-engine 24%、agent-config 8.24%（其中 11 个函数覆盖为 0） | **最大系统性缺口（低覆盖，不是 0%）** |
| **knowledge 域** | service 行覆盖 3.92%（knowledge-runtime）~53% 不等（knowledge-base 11.92%），route 与 repo 同域低覆盖，**无一处为 0%** | 全链路薄弱 |
| **workflow 执行域（宿主侧）** | `workflow/workflow-execute.ts` 6.67%、`workflow-trigger.ts`(service) 11.61%、`routes/web/workflow-defs.ts` 27.35%、`workflow-engine.ts` 14.67%、`routes/api/workflows.ts` 62.30%、repo `workflow-def.ts` 7.79% | 引擎包内测试健康，宿主集成薄弱 |
| **channels / IM 通道域** | `channel-binding` service 14.89%、repo 13.04%、`routes/web/channels.ts` 56.02% | 薄弱 |
| ACP/relay/会话（`transport/`、`services/`） | agent-relay/event-bus/file-ws 系列 100%；**`transport/relay/relay-handler.ts` 16%**；`acp-ws-handler.ts` 46% | 局部缺口 |
| 实例/编排（`services/instance.ts` 等） | `instance.ts` 32.90%、`core-bootstrap.ts` 15.49%、`event-service.ts` 57.89% | 生命周期周边缺口 |
| 其余 service 低覆盖（函数 0% 但行覆盖非 0） | `agent-generation` 3.33%、`agent-templates` 15.63%、`chat-channel-error-classify` 16%、`config/agent-config-skill` 20%、`knowledge-metadata`、`knowledge-provider/registry`、`knowledge-upload`、`mcp-inspector`、`meta-agent` 17.24%、`ragflow-key`、`scheduler/http-executor` | 按域补齐 |
| 健康模块 | 文件系统（fs-*、file-ws-*、path-validator）、并发（concurrency/toctou/lease）、skill 导入编排、config 资源访问矩阵、迁移、YJS 一致性 | 保持 |

**根因**：41 个测试文件用 `stubRepositories` / `stubDb` 隔离数据层（这是单元测试的正确做法），真实 SQL 只在少数路径执行，repository 行覆盖因此集中在 3.82%~24%；全仓仅 `db-schema.test.ts` 与 `task-schema.test.ts` 两处用内存 sqlite 真库。结论：repository 层不是"0%"，而是**缺少一层 L3 真库测试**（对策见 §3 L3、§6.1）。

### 1.3 `packages/*`

12 个包，70 个测试文件，健康度分化大：

| 包 | 状态（行覆盖） | 判定 |
|----|------|------|
| chat-channel（14） | 33 个被测文件，全部有覆盖 | 健康 |
| core（6）、orchestration（3）、workflow-engine（23） | 全部有覆盖 | 健康 |
| **acp-link（11）** | client 子模块 6 个文件函数 0%，行覆盖 3.65%~25.81%（acp-spawn-helper、file-operations、instance-manager、protocol-adapter、resolve-executable、workspace-registry），无一为 0% | P1 缺口 |
| **plugin-ccb（2）** | 7/11 文件函数 0%；行覆盖 0% 仅 1 个：`relay/relay-handle.ts`（全仓唯一行覆盖 0% 文件）；ccb-handler 6.02%、ccb-runtime 5.91%、process/* 11%~21% | P1 缺口 |
| **plugin-claude-code（1）** | 4/7 文件函数 0%（handler 9.21%、runtime 3.85%、settings 3.28%），行覆盖无一为 0% | P1 缺口 |
| plugin-opencode（8） | opencode-handler 5.88%、process/executable 9.23%，其余健康 | 小缺口 |
| remote-runtime（2） | remote-transport 4.26% | 小缺口 |
| logger | 1 个源文件，被间接加载（56.57%），无自有测试 | 可接受 |
| **acp-runtime-cli、plugin-sdk** | **0 个测试文件**（未出现在报告中） | P2 |

### 1.4 前端 `web/`（含 `web/src` 与 `web/components`）

被测文件 113 个，**行覆盖为 0% 的 0 个**（函数覆盖为 0% 的有 34 个，多为声明性代码与薄包装）。

| 类别 | 状况（行覆盖） | 判定 |
|------|------|------|
| 纯逻辑 `lib/`、narrators、request.ts、useBackoffRetry | 大部分 90-100% | 健康，保持 |
| **业务组件/上下文** | `CommandMenu.tsx` 5.98%、`ModelConfigDialog.tsx` 14.14%、`OrgContext.tsx` 11%、`theme.ts` 7%、`structured-to-thread.ts` 13%、`config-events.ts` 23% | P1 |
| **页面级大组件** | `AgentFormDialog.tsx` 4.05%、`ParamsEditor.tsx` 19.93%、`DataTable.tsx` 12.50%、`CronEditor.tsx` 31.64% | P2（成本高） |
| `web/src/api/` 模块 | 多为薄封装：instances 35%、knowledge-bases 28.42%、organizations 22.39%、sites 37.21%、workflow-engine 34.62%；request.ts 本身 91% | 中低风险，选择性补 |
| `web/components/ui/` 薄包装组件 | 函数覆盖大面积 0%，行覆盖 8%~100% 不等 | **豁免**（见 §6.4） |

### 1.5 未加载文件（真正的盲区）

Bun 报告只统计被测试加载的文件。对比全量源文件与报告清单（2026-08-06 实测）：

| 范围 | 非测试源文件 | 被测试加载 | **从未加载** |
|------|------------|-----------|------------|
| `src/` | 246 | 217 | **29**（含 `src/index.ts`、`src/logger.ts`、`src/routes/skills.ts`、`src/services/environment.ts`、`src/types/*` 等） |
| `web/`（`web/src` + `web/components`） | 319 | 113 | **206（64.6%）** —— 绝大多数组件、页面、hooks 从未被测试加载 |
| `packages/*` | 155 | 131 | **24** |

这些文件不在覆盖率报告中，之前的"0% 清单"无法反映它们。排查盲区必须以此对比结果为准（`bun run coverage:audit` 自动完成该对比，排查方法见 §7）。
注意：未加载清单可能含**纯类型文件**（仅被 `import type` 引用，无运行时行为，如 `web/src/types/` 下多个文件）与**死代码**（如 `src/routes/hooks.ts`、`src/routes/web/control.ts` 全仓 0 引用、疑似未挂载的 webhook 端点），补测试前需人工甄别；死代码应删除而非补测试。

## 2. 覆盖原则与量化目标

### 2.1 覆盖率的原则：不是数字游戏

覆盖率数字本身没有意义，**领域不变量**才是测试的目的。写测试前先问：这段代码违反哪条不变量时，用户会损失什么？

- **多租户**：A 组织的数据出现在 B 组织的响应中 → 数据泄漏，最高优先级。
- **文件安全**：路径穿越 / symlink 逃逸读写宿主文件 → 安全漏洞，最高优先级。
- **并发**：并发上限失效、实例双重启动 → 资源耗尽或数据错乱，最高优先级。
- **恢复**：刷新后会话丢失、消息重复、Y.Doc 不可达 → 核心体验，高优先级。
- **错误路径**：吞错、日志泄露敏感信息、错误码语义混淆 → 可观测性红线。
- **常规路径**：参数正常、返回值正确 → 基础要求，但优先级低于以上。

因此覆盖优先级排序固定为：

```
领域不变量（隔离/安全/并发） > 错误与边界路径 > 恢复与幂等路径 > 常规成功路径
```

不要为了凑行覆盖率去断言 UI 结构或重复类型检查；宁可少而准，不可多而空。

### 2.2 量化目标（建议值，不是 KPI）

| 层级 | 目标 | 说明 |
|------|------|------|
| 纯逻辑模块（utils、validators、schema、映射函数） | 行覆盖 ≥ 90% | 输入输出可枚举，成本低，优先做满 |
| service / 领域编排层 | 关键路径 100%，行覆盖 ≥ 80% | 事务边界、幂等、竞态必须有断言 |
| route / 协议接入层 | 鉴权、参数校验、错误映射全覆盖 | 成功路径覆盖即可，不追求 100% |
| repository / 数据访问层 | 条件组合与分页边界 | 硬门槛见 §6.3（≥70%） |
| 前端纯逻辑（request、utils、store） | 行覆盖 ≥ 85% | 同上，成本低 |
| 前端组件 / 页面流程 | 关键交互与状态流覆盖 | 不写纯 UI 结构断言，见 §4.3 |

量化目标是参考，不是 KPI。**每条测试必须有业务意图**：注释说清"防止什么缺陷"，断言验证状态转换而不是实现细节。

## 3. 分层测试策略

测试按层级投入，层与层之间用不同的隔离手段，成本递增、数量递减：

```
L1 纯逻辑/工具      —— 直接执行，行覆盖 ≥90%，成本最低，做满
L2 服务/编排        —— stub 隔离外部依赖（现状做法正确），关键路径+失败路径必须断言
L3 repository       —— 内存 sqlite 真库（先例：`db-schema.test.ts`，推广为 `test-utils` fixture，见 §8），覆盖 SQL 行为、条件组合、迁移兼容
L4 route 接入       —— 鉴权/参数校验/错误映射，按域覆盖，不追求 100%
L5 端到端           —— 仅 P0 流程（认证、租户隔离、文件安全、YJS 恢复），每个领域 ≤3 条
```

**现状评估**：L1、L2 执行良好（这是 2613 个测试的主体）；L3 缺失（repository 层低覆盖的根因）；L4 按域分化（fs、api 系列健康，knowledge/workflow/channels 薄弱）；L5 部分依赖手工脚本（`test-openai-chat.sh`），未沉淀为自动化。

## 4. 覆盖重点清单

按领域列出必须覆盖的点，括号内为现有参考测试，新代码落入同一领域时参照补齐。

### 4.1 后端重点覆盖清单

#### 4.1.1 认证与多租户隔离（最高优先级）

- 三级认证降级链：session cookie → Environment Secret → better-auth API Key 的尝试顺序与失败语义（`auth.test.ts`、`acp-ws-auth.test.ts`）。
- active organization 提取优先级：`x-active-org-id` header → `activeOrganizationId` query → `active_org_id` cookie（`environment-role.test.ts`、`require-team-scope.test.ts`）。
- API Key 的组织上下文由 key metadata 恢复并重新校验成员关系；校验异常必须保守拒绝（`web-api-keys-routes.test.ts`、`api-agents-apikey-regression.test.ts`）。
- 跨租户越权访问：A 组织用户访问 B 组织资源（org / environment / agent / skill / knowledge base / workflow / instance）一律 403/404，且不得泄露资源存在性。
- 测试桩注入与复位：`setTestAuth()`、`setTestOrgContext()` 使用后必须 reset，防止状态泄漏到其他测试（`test-utils` 约定）。
- 系统密钥隔离：`RCS_SYSTEM_API_KEYS` 与 `RCS_API_KEYS`（skill 下载 token HMAC）用途不得混用（`skill-download-token.test.ts`、`system-admin.test.ts`）。

#### 4.1.2 并发、竞态与生命周期（最高优先级）

- 并发上限：全局 / 单用户 / 定时任务三条上限独立生效，终态（stopped/stopping/error）不计入（`agent-concurrency.test.ts`、`agent-chat-service-concurrency.test.ts`）。
- TOCTOU：检查与占用之间的竞态窗口，重复 spawn 不得发生（`agent-concurrency-toctou.test.ts`、`instance-lease.test.ts`）。
- 幂等：删除、清理、创建操作重复执行结果一致（`instances-delete-idempotent.test.ts`、`session-async-cleanup.test.ts`）。
- 引用计数：多标签页共享 relay handle，计数归零才释放；实例释放必须走生命周期管理，断连 ≠ 进程终止（`agent-relay-death-hook.test.ts`、`local-instance-death-cleanup.test.ts`、`session-state-service.test.ts`）。
- 背压与连接上限：WebSocket 发送背压阈值 64 KB、连接上限 200，超限行为明确（`external-relay.test.ts`、`transport-normalize.test.ts`）。

#### 4.1.3 文件系统安全（最高优先级）

- 路径词法校验：绝对路径、`..`、控制字符一律拒绝（`file-path-validator.test.ts`、`workspace-fs-tree.test.ts`）。
- symlink 逃逸：realpath 越界检查，链接指向 workspace 外必须拒绝（`fs-symlink-escape.test.ts`、`workspace-symlink-escape.test.ts`、`fs-upload-escape.test.ts`）。
- 上传与下载边界：大小限制、zip 内路径穿越、远程文件打包（`fs-upload-limit.test.ts`、`fs-download-zip.test.ts`、`fs-zip-remote.test.ts`）。
- 条件请求与并发写：ETag / If-Match / opid 语义（`fs-etag.test.ts`、`fs-opid-ifmatch.test.ts`）。
- 远程/本地分裂守卫：配置远程 machine 但 file-ws 未连接时必须返回明确错误，禁止静默回退本地 FS（`file-ws-handler.test.ts`、`remote-machine-id-three-way.test.ts`）。
- workspace 路径必须运行时计算（`resolveWorkspacePath`），DB `workspacePath` 历史字段不得参与推导（`workspace-resolver.test.ts`）。

#### 4.1.4 远程机器与实例编排

- `machineId` 三路 fallback：agent config `machineId` → `RCS_DEFAULT_MACHINE_ID`；无 `agentConfigId` 的 environment 同样必须 fallback（`remote-machine-id-three-way.test.ts`、`instance-machine-fallback.test.ts`）。
- 机器注册、心跳、stage 状态机流转与非法跳转（`acp-machine-register.test.ts`、`registry-machine-stages.test.ts`、`registry-service.test.ts`）。
- 机器死亡清理与实例 nodeId 归属，残留进程与 `EADDRINUSE` 的处置（`machine-cleanup-node-dispatch.test.ts`、`orchestration-machine-cleanup.test.ts`、`orchestration-instance-nodeid.test.ts`）。
- 编排失败回滚：spawn 失败时实例注册、锁、临时状态必须清理（`orchestration-instance-rollback.test.ts`）。

#### 4.1.5 ACP / relay / 会话生命周期

- JSON-RPC 兼容：原始 `{ jsonrpc: "2.0", ... }` 与包裹 `{ type, payload }` 两种格式统一走 `extractJsonRpc()`（`transport-normalize.test.ts`、`extract-acp-event.test.ts`）。
- 事件载荷位置：`session/update` 事件类型在 `params.update.sessionUpdate`，文本在 `update.content`；禁止读取不存在的字段（`chat-channel-*` 系列）。
- 会话全流程：`session/new` → `load` → `prompt` → 结束清理；异步清理不得泄漏实例（`chat-channel-session.test.ts`、`instance-session.test.ts`、`agent-executor.test.ts`）。
- idle 回收：超时回收、sweep 周期、活动计时更新（`acp-idle-monitor.test.ts`、`session-async-cleanup.test.ts`）。
- 认证与鉴权：acp-link 本地 WebSocket 始终需要认证，relay token 不得硬编码或记录（`acp-ws-auth.test.ts`）。
- 错误码语义：关闭码到用户可读错误的映射稳定，非终态码不中断普通流程（`yjs-frontend-snapshot-persist.test.ts`、`instance-response.test.ts`）。

#### 4.1.6 Skill / Agent 模板 / 配置

- Skill 是「元数据 + 源目录 + 归档」的组合存储：创建/导入必须走 `setSkill` / `importSkillDirectories` 完整编排，直接 `upsertSkill` 只更新元数据是缺陷（`skill-archive-lifecycle.test.ts`、`skill-storage-migrate.test.ts`）。
- 导入边界：同名覆盖、并行删除、共享校验、失败回滚（`skill-import-name-overwrite.test.ts`、`skill-import-parallel-deletes.test.ts`、`skill-import-shared-validation.test.ts`）。
- Agent 模板 frontmatter：必须用 `gray-matter` 解析，非法 frontmatter 给出明确错误，禁止手写正则（`skill-frontmatter.test.ts`、`agent-config-validators.test.ts`）。
- 配置资源访问：provider / model / skill / MCP / agent 五类 resource access 的权限矩阵与三态（ask/allow/deny）语义（`config-*-resource-access.test.ts`、`resource-permission-service.test.ts`、`model-provider-access.test.ts`）。
- zod 校验：非法输入拒绝且错误信息可诊断；空字符串默认值用 `??` 语义（`config-validators.test.ts`、`task-schema.test.ts`、`task-v2-validation.test.ts`、`env-validation.test.ts`）。

#### 4.1.7 数据库与迁移

- schema 与领域实体一致：枚举、默认值、唯一约束、级联删除（`db-schema.test.ts`、`engine-type-schema.test.ts`、`environment-schema.test.ts`）。
- 迁移幂等与历史数据兼容：旧数据按迁移语义转换、可回滚、可补偿（`data-migrate.test.ts`、`migrate-agent-config-model-id.test.ts`、`skill-storage-migrate.test.ts`）。
- 错误跨运行时语义：`instanceof Error` 等判断在 Bun / 子进程边界仍然成立（`task-timeout-instanceof-error.test.ts`、`error-class-semantics.test.ts`）。

#### 4.1.8 错误处理与可观测性

- 不吞错：catch 保留诊断上下文，日志可定位故障（`structured-logger.test.ts`、`error-handler.test.ts`）。
- 脱敏：密钥、token、密码、连接串不得进入日志与错误响应（`sanitize-execution-log.test.ts`、`config-system-admin-password.test.ts`）。
- 对外错误不泄露内部实现：HTTP 错误映射稳定，错误体不携带堆栈（`api-system-routes.test.ts`、`request-id-header.test.ts`）。

#### 4.1.9 时间与调度

- 定时任务：日期边界、时区、过期任务清理、幂等执行（`scheduler-invocation-date-guard.test.ts`、`scheduler-stale-job-cleanup.test.ts`、`workflow-runs.test.ts`）。
- 超时与取消：请求超时、空闲回收、取消后的状态一致性。

#### 4.1.10 外部协议与 Webhook

- OpenAPI 契约：`detail`、`params`、`query`、`headers`、`body`、`response` 完整性（`api-*-routes.test.ts` 系列）。
- hooks / MCP / ACP 入口的鉴权与参数校验（`mcp-route-resource-access.test.ts`、`mcp-inspector.test.ts`、`file-events-endpoint.test.ts`）。
- 远程 runtime 命令校验：不允许注入、不允许越权参数（`mcp-command-validation.test.ts`）。

### 4.2 前后端共享重点：YJS / Chat 一致性

前端交互式 Chat 的刷新恢复、多标签页一致、消息不重复依赖一组跨端不变量，**前后端各写各的测试，但必须共同覆盖**：

1. `rcsSessionId` 确定性生成：不得用 `Date.now()` / 随机值，否则刷新后旧 Y.Doc 不可达（`yjs-store.test.ts`、`session-sync-functions.test.ts`）。
2. 快照时机：WebSocket open 后、`relayReady = true` 前必须发送 Chat Doc 与 Session Doc 初始快照（`yjs-ws.test.ts`、`chat-channel-bootstrap.test.ts`）。
3. 重连恢复：从 `chatMeta.activeSessionId` 恢复 `entry.acpSessionId`；同一 ACP session 的 `load_session` 跳过 Agent 全量回放（`chat-visible-reconnect.test.ts`、`yjs-frontend-snapshot-persist.test.ts`）。
4. 消息双写防护：用户消息只由后端写入 Y.Doc，前端不得维护第二份 local 列表（`use-session-state.test.ts`）。
5. 广播隔离：Y.Doc 名 `chat:{rcsSessionId}` / `session:{rcsSessionId}`，禁止全局广播会话数据（`event-bus.test.ts`、`context-queue.test.ts`）。
6. 清理语义：`clearSessionDocContent` 在原事务内清理，禁止 destroy + recreate 制造异步竞态（`chat-channel-session.test.ts`）。
7. 背压与上限：发送背压 64 KB、连接上限 200，超限行为明确（`yjs-ws.test.ts`、`external-relay.test.ts`）。

### 4.3 前端重点覆盖清单

前端只测试**关键交互、状态和数据流**，不写纯 UI 结构断言、不写仅重复类型检查的测试。

#### 4.3.1 API 请求层

- `request.ts`：路径参数编码、query 序列化、错误标准化、响应 `{ success, data }` 解包（`request.test.ts`、`api-client.test.ts`）。
- 重试与退避：失败重试、指数退避、终止条件（`retry.test.ts`、`use-backoff-retry.test.ts`）。
- 上传 URL 构造与文件传输（`fs-upload-url.test.ts`、`drag-upload.test.ts`、`skill-upload.test.ts`）。

#### 4.3.2 状态与并发

- ahooks / `useRequest` 模式：重复请求去重、竞态覆盖、卸载后不 setState（`use-session-state.test.ts`、`use-workflow-events.test.ts`）。
- 队列与顺序：消息/事件按序处理，乱序到达不覆盖新状态（`context-queue.test.ts`）。
- 会话状态机：创建 → 运行 → 结束 → 清理的状态转换与恢复（`use-session-state.test.ts`）。

#### 4.3.3 关键业务流程（必须覆盖 loading / empty / error / retry / success）

- 资源访问授权流程：agent / skill / MCP / provider 四类 flow 的权限选择、提交与回显（`agent-resource-access-flow.test.ts`、`skill-resource-access-flow.test.ts`、`mcp-resource-access-flow.test.ts`、`provider-model-resource-access-flow.test.ts`）。
- 表单与对话框：校验错误展示、提交失败保留输入、成功后的导航与刷新（`new-session-dialog-form.test.ts`、`token-manager-dialog-form.test.ts`、`task-form-schema.test.ts`）。
- Workflow 运行页：事件流驱动进度、失败态、重试（`workflow-runs-page.test.tsx`、`workflow-params-outputs-flow.test.tsx`）。
- 文件选择与树：多选、禁用项、路径回显（`file-picker-dialog.test.tsx`、`file-picker-panel.test.tsx`、`tree-component.test.tsx`）。

#### 4.3.4 导航与路由

- 只使用 `<Link to>` / `useNavigate()` / `router.invalidate()`；路由守卫、参数解析（`config-routing.test.ts`、`config-mcp-routing.test.ts`、`config-agents-page.test.ts`）。
- 禁止 `window.location.*` / `history.pushState` 的回归断言（`auth-preference.test.ts`）。

#### 4.3.5 i18n

- 用户可见字符串必须走 `t()`：新增文案未接入 i18n 即失败（`i18n-import.test.ts`、`narrators-i18n.test.ts`）。
- 插值语法：`{{var}}` 生效、`{var}` 按字面文本处理（`narrators-helpers.test.ts`）。

#### 4.3.6 纯逻辑工具

- utils / helpers / normalize / 类型守卫：输入输出可枚举，行覆盖 ≥ 85%（`utils.test.ts`、`api-result-utils.test.ts`、`preview-utils-normalize.test.ts`、`token-stats.test.ts`、`permission-options.test.ts`、`extract-changed-files.test.ts`、`resolve-tool-card-kind.test.ts`）。

#### 4.3.7 组件（仅关键交互）

- 对话框开合与确认语义、表格分页与排序、树组件选择、日期边界（`confirm-dialog.test.tsx`、`config-datatable.test.ts`、`pagination.test.tsx`、`date-picker.test.tsx`、`cron-editor.test.tsx`）。
- 组件 memo 稳定性：`ChatView` / `EntryRenderer` 的 comparator 与 props 变更同步（见《前端开发规范》YJS 章节）。

## 5. 优先补齐计划（按风险排序，不是按覆盖率数字）

### P0 —— 安全与数据完整性，两个迭代内完成

| 目标 | 现状 | 动作 |
|------|------|------|
| `auth/encryption.ts` | 30%（函数 0%） | 补全加解密、IV/错误输入、密钥轮换语义测试 |
| `repositories/resource-permission.ts`、`share-link.ts` | 4.55% / 5.94% | 权限矩阵落库、分享链接越权面的 SQL 行为测试 |
| `repositories/environment.ts` | 5.11% | 环境 CRUD 与 org/user/environment 三级路径解析测试 |
| `services/instance.ts` | 32.90% | 实例生命周期状态机补全 |

### P1 —— 核心域全链路空白，一个季度内完成

| 目标 | 动作 |
|------|------|
| knowledge 域（service×5 + route + repo） | 以内存 sqlite 从 repo 起步，向上覆盖 service 与 route 主路径 |
| workflow 执行域（宿主侧 6 个文件） | 复用 `packages/workflow-engine` 的引擎测试资产，补宿主编排与触发 |
| channels / IM 通道域（3 个文件） | 补 channel-binding 与 route 的鉴权和消息流 |
| `transport/relay/relay-handler.ts` | 补 JSON-RPC 分发主路径 |
| acp-link client 6 个文件（行覆盖 3.65%~25.81%） | 补 spawn、协议适配、实例管理（涉及进程，用桩进程或录制回放） |
| plugin-ccb 7 个文件、plugin-claude-code 4 个文件 | 补 handler 与 runtime 主路径（可参照 plugin-opencode 的既有做法） |
| 前端 `OrgContext`、`theme.ts`、`CommandMenu`、`ModelConfigDialog`、`structured-to-thread` | 补状态流与关键交互 |
| 前端 `web/src/api/` 的 5 个低覆盖模块（22%~37%） | 随对应页面改动顺带补，不单独立项 |

### P2 —— 低风险或高成本，随功能演进

- `agent-generation`、`agent-templates`、`meta-agent`、`prod-view`、`tasks-v2`、`chat-channel-error-classify`、`event-service`、`core-bootstrap`、`mcp-inspector`、`ragflow-key`、`scheduler/http-executor`
- 页面级大组件（`AgentFormDialog` 4%、`ParamsEditor` 20%）：仅在有改动时补**改动涉及的路径**
- `acp-runtime-cli`、`plugin-sdk` 两个零测试包：纳入各自新功能开发时起步
- 前端 ui 薄包装组件：豁免（见 §6.4）

## 6. 门槛规则与质量红线（硬约束）

### 6.1 新代码

- L1/L2 层新增代码必须带测试，`precheck` 全绿才能提交（现状已强制，保持）。
- 新增 repository 必须带 L3 测试（内存 sqlite），否则不得合并——repository 层是当前唯一没有兜底机制的分层。

### 6.2 修改低覆盖或未加载文件

改动 §1 列出的低覆盖（行覆盖 <30%）或 §1.5 未加载文件时，**顺手补该文件的主路径测试**再提交，禁止"改裸代码、留裸测试"。

### 6.3 覆盖率门槛（模块级，不设全局门槛）

- L1：行覆盖 ≥90%。
- L2：关键路径与失败路径必须覆盖（不按百分比验收）。
- L3：新增 repository 行覆盖 ≥70%。
- 全局行覆盖不做硬性门槛——当前 71.2%（被加载文件口径）与 45.2%（计入未加载后整体）的全局数字会随新代码与未加载文件变动，模块级门槛才有约束力。

### 6.4 豁免清单（明确不补，注明理由）

- `web/components/ui/` 薄包装组件：shadcn 风格透传组件，测试成本高、业务价值低，由使用方测试间接覆盖。
- 纯声明文件（类型、常量、re-export index）。
- 明确标注的 dead code：应删除而非补测试。

### 6.5 测试质量红线（提交前自查）

1. 每个 `test(...)` 上方有一行中文注释，说明**业务意图**（防什么缺陷），不重复代码表面行为。
2. 禁止直接调用 `mock.module()`；一律复用 `src/test-utils/` 的 stub 与 reset（`resetAllStubs()`），测试结束必须复位，防止状态泄漏。
3. 断言状态转换而非实现细节：断言"结果正确、副作用发生、失败可诊断"，不锁定内部调用顺序。
4. 并发、重连、权限、租户隔离、迁移、失败回滚六类边界必须覆盖关键测试；新增涉及这些领域的代码，必须附带对应测试。
5. 前端不写纯 UI 结构断言；后端不写只验证类型重复的测试。
6. 测试命名与文件组织：`kebab-case`，后端 `src/__tests__/`，前端 `web/src/__tests__/`，跨领域逻辑可归入 `routes/`、`services/` 子目录。
7. 禁止 `as any` 绕过类型（第三方类型缺陷除外，需行级注释）；捕获错误必须保留诊断上下文。
8. 改动提交前必须运行 `bun run precheck`（含全部后端测试）；前端改动还需 `bun run build:web` 与相关前端测试。

### 6.6 变更时的覆盖要求

- 新功能按垂直切片交付：每层（schema → repository → service → route / 前端 API → store → 组件）至少一条关键路径测试 + 一条失败路径测试。
- 重构不改变行为的提交：测试必须保持全绿，允许补充边界测试；重命名/移动测试文件需同步更新引用。
- 修复缺陷的提交：先写复现该缺陷的回归测试（或确认已有测试能拦截），再修代码。
- 涉及 §4.1 / §4.2 领域不变量的改动：必须新增或更新对应不变量的测试，`precheck` 全绿才能提交。

## 7. 治理机制

- 覆盖率采集命令固定为 `bun run coverage:audit`（约 25s，可进 CI 或本地自检）。脚本内部执行 `bun test --coverage`，自动完成：按统一口径统计（行覆盖）、目录聚合、0%/低覆盖清单、**全量源文件 vs 报告对比（未加载文件）**；也可 `bun run coverage:audit -- --input <file>` 复用已有输出。
- 每季度复查一次 §1 的数据与 §1.5 未加载文件清单，P0/P1 项全部清零前不得新增 P2 立项。
- 新域（新 route/service/包）落地时必须先在 §1 登记，选择 P0/P1/P2 归属。
- **盲区排查顺序**（注意：Bun 报告不列出未加载文件，只看报告会漏掉最大盲区）：
  1. 运行 `bun run coverage:audit`，直接读取输出的"未加载文件"与"行覆盖 <30%"两个清单（脚本已完成全量对比）。
  2. 对照 §4.1 / §4.3 检查该层强制清单是否命中；未命中 → 按 §5 优先级补齐。
  3. 命中但未覆盖 → 检查是"不可达代码"（可考虑移除或注释说明）还是"缺测试"。
- 判定合格：**§4 清单覆盖的领域没有缺测场景，且所有测试有明确业务意图**，而不是覆盖率数字达到某值。

## 8. 与现有测试体系的关系

| 设施 | 关系 |
|------|------|
| `src/test-utils/` stub 体系 | L2 的隔离手段，继续使用；**不得**用 stub 替代 L3 的 repository 测试 |
| `db-schema.test.ts` 的内存 sqlite 先例 | L3 的模板，推广为 `test-utils` 的 sqlite fixture（`bun:sqlite` + drizzle，无需外部依赖） |
| `bun run precheck` | 提交门槛，覆盖 L1/L2/L4 的现有测试；L3 补全后自动纳入 |
| `bun run coverage:audit`（`scripts/coverage-audit.ts`） | 覆盖率采集与盲区排查的统一入口：按行覆盖口径统计、输出 0%/低覆盖/未加载清单（自动对比全量源文件），可进 CI |
