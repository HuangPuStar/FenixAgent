# External Agent API v1 实施计划

> **面向 AI 代理的工作者：** 使用 `executing-plans` 按任务执行；如用户选择子代理方式，使用 `subagent-driven-development`。步骤使用复选框记录进度。本文件仅为计划，不代表实现完成。

**目标：** 交付设计确认的 35 项 v1 操作，让外部系统完成配置、ACP 连接、上传、SDK 对话与运行管理。

**架构：** owner 包维护 v1 DTO、协议 adapter 与应用入口，复用领域能力、事务原语和 runtime。Web 与 v1 分别维护契约，不强制共用 Facade；共享能力变更必须通过两面的行为回归。宿主只处理认证、协议错误、CORS、聚合和 OpenAPI。

**技术栈：** Bun、Elysia、Zod v4、Drizzle / PostgreSQL、既有 ACP relay、仓库现有 OpenAI SDK。

**规格：** [External Agent API v1 设计](./2026-10-29-external-agent-api-v1-design.md)。执行前同时阅读该设计、`CLAUDE.md`、后端开发规范与工程架构规范。

## 实施状态

代码位于隔离分支 `feat/external-agent-api-v1`，工作树 `.worktrees/external-agent-api-v1`；尚未提交。以下状态区分实现、自动验证与部署验收，不能视为已发布。

| 范围 | 状态 |
| --- | --- |
| 任务 1—10、12 的 35 项接口与文档 | 已实现，资源、协议、SDK、授权和生命周期回归已运行 |
| 任务 11 并发 | 自动回归与真实 runtime 2×2 并发通过；四路 MCP 执行区间重叠，续聊、取消与实例停止隔离通过 |
| PostgreSQL | 隔离测试库 8 项通过：完整 Agent 回滚、并发更新锁、严格创建冲突、MCP enabled 持久化、授权查询与范围更新的事务一致性 |
| 上传执行 | 本地与远端执行代码回归 34 项通过；Linux 目录描述符和 macOS 独立运行包验证通过 |
| 任务 13 收口 | 35 项真实路由 / OpenAPI 契约已冻结；全量门禁结果见执行记录 |
| 环境验收 | 本地独立服务连接用户 Docker 已通过：真实网关、Skill / MCP / 已有 KB 工具、远程上传后读取、ACP 直连、SDK JSON / SSE、2×2 并发与双组织/角色/用户隔离 |

执行记录保留在 `.superpowers/sdd/2026-10-29-external-agent-api-v1-plan/progress.md`，不随未提交工作删除。下方复选框保留原验收要求；未整体验收的复合步骤不标完成。

### 实施裁决

1. 使用独立分支而非原 `feat/openai`，保护用户当前修复；后续需要单独集成。
2. 模型绑定授权扩展既有 `ModelLookupPort`，避免 model-management 与 agent-config 装配环；若边界调整，须同步端口实现。
3. Agent 下实例路由参数统一名为 `:id`，避开 Elysia 同级动态参数冲突；线上 URL 不变，OpenAPI 参数名相应统一。
4. 安全上传在既有 plugin-sdk 新增仅服务端子入口，本地与 acp-link 共用；machine 增加一条 workspace 依赖，不增加第三方依赖。若归属调整，需要迁移两个消费方。
5. 108 MiB 由计数请求流执行，Bun 传输层放行至该适配器，保证超限响应符合协议；必须保留实际流量上限回归，不能只检查 Content-Length。
6. 续聊句柄仅保存在单进程，部署需会话粘滞；进程重启或请求落到其他进程会返回 SESSION_UNAVAILABLE。
7. 自动测试不替代真实 runtime、网关与远程验收；未完成环境验证前不视为可发布。
8. 系统 Bun 1.4.2 的完整 fastcheck 通过，但随后 precheck 的 package 进程发生 SIGSEGV；使用任务目录内的官方 Bun 1.4.3 复核，不替换系统运行器或项目依赖。部署使用的运行器版本仍需单独确认，不能把 1.4.3 的结果当作 1.4.2 的 precheck 结果。

### 真实环境验收

1. 服务使用主工作区只读环境配置，在同一 Docker PostgreSQL 内建立隔离测试数据库；不复制运行状态，Skill / workspace / 日志使用独立目录。
2. Provider/Model CRUD、网关只读查询、Skill 二进制导入与 metadata PATCH、MCP enabled 持久化、已有 KB 查询/绑定、Agent PATCH 保留关联全部通过。
3. 三路首次 connect 收敛到同一个默认实例与 Environment；远程 file-ws 上传后，真实 Agent 读取文件并返回独特标记；MCP 服务记录实际调用，Skill 指令读取与 KB 检索工具完成。
4. 两实例各两个不同会话混合 JSON / SSE，四路延时 MCP 调用执行区间共同重叠 10,596 ms；四个续聊各自保留历史。取消 A 会话不影响同实例 B 会话；停止实例 A 不影响实例 B；旧句柄失效，restart 增加代次并可新建会话。
5. 两组织、同组织 member/admin、同 Agent 不同用户实例隔离通过；角色升降级后同一 API Key 按当前成员角色授权。越权实例、上传与续聊均被拒绝。
6. 联调发现并修复：授权实现缓存根连接导致 Agent 事务创建后回读 404；ACP 认证前首帧丢失；包裹 ACP 请求未归一化导致下游不识别。真实 PostgreSQL 和真实 WebSocket 回归均先失败后通过。
7. 验证脚本和资源 ID / 时间证据位于忽略目录 `.superpowers/sdd/2026-10-29-external-agent-api-v1-plan/live/`；临时 API Key 仅在内存使用并于 finally 撤销。验证不修改用户原有数据库和 Docker 组件配置。
8. 最终 fastcheck 与完整 precheck 使用 Bun 1.4.3 通过：package 11,628 pass / 116 skip，server/script 1,031 pass，web 398 pass，均为 0 fail；显式 PostgreSQL 验证另行执行。前端生产构建与文档构建通过。
9. 完整门禁曾有一次未修改的 Workflow 进程取消测试因 macOS 瞬态 EPERM 失败；单文件 21 项通过，重复 10 次复现 1 次，最小进程组探针确认随后即 ESRCH 且无残留进程。未修改 Workflow 实现或测试来绕过；最终全量复跑通过，失败记录保留。
10. 清理确认：临时沙盒、API Key、测试账号均为 0；测试实例停止，独立服务保留在 `http://localhost:3301`，示例 Agent / Skill / MCP 配置保留在隔离数据库。

### 延后的小项

1. KB 旧列表服务有一条注释仍描述跨组织读取，v1 实现与测试实际限定当前组织。
2. Agent sidebar 与 Workflow Web API 各一条源码位置注释包含不存在的 `web/api/v1`；实际 import 已修正，运行路径不受影响。

## 1. 全局约束

1. 从 `feat/openai` 的 `5195a941f` 基线建立独立分支 `feat/external-agent-api-v1` 与 worktree；不要在用户正在修复的工作区直接落代码。
2. 普通接口 `/api/v1/*` 使用 `{ success: true, data }` / `{ success: false, error: { code, message } }`；Chat 使用 OpenAI 原生格式，ACP 不改为 Yjs。
3. 不改表结构、不新增第三方依赖、不重建 ACP 协议栈；共用安全上传只增加既有 workspace 包之间的依赖。不增加外部 Instance 创建 / 删除、KB 管理或工作流管理 API。
4. 每项任务随对应 v1 路由落地删除旧路由并迁移已知调用方；不保留双版本、转发 shim 或重定向。任务 13 负责最终核对，避免中途把删除遗漏隐藏到发布后。
5. `/api/system`、`/api/auth`、`/web`、ACP 和范围外协议保持各自契约；system / auth 继续从外部 OpenAPI 排除。
6. DTO 和默认值属于各版本，不从 Web schema 派生 v1 请求或返回类型。可复用现有稳定领域入口，但不能让 Web 默认值或视图字段成为 v1 的隐式依赖。
7. 列表默认 `page=1`、`pageSize=20`，最大 100；创建 201，更新 / 查询 / 删除 / connect / stop / restart 200，无数据为 `data: null`。Skill 覆盖及 Workflow 的例外按设计处理。
8. 测试使用既有注入接缝与 `apps/server/src/test-utils/`，不直接 `mock.module()`；每个 `test(...)` 上方写中文业务意图。涉及数据库原子性时增加真实 PostgreSQL 集成验证，不能只用空事务 stub 证明回滚。
9. 新增 / 重写文件不超过 500 行。优先改现有 owner 能力；只有版本语义确实不同才增加 v1 应用入口，不为每种资源机械复制一整套 Facade。
10. 每任务先补行为测试并确认失败，再实现并验证。执行阶段每任务运行相关测试与 `fastcheck`；代码提交前 `precheck` 全绿。提交和推送另按用户授权执行，不自动 commit。

## 2. 文件安排与职责

| 模块 | 修改现有文件 | 新增文件及职责 |
| --- | --- | --- |
| 统一协议 | `packages/platform/platform-sdk/src/index.ts`；`apps/server/src/plugins/{auth,error-handler,cors}.ts` | SDK `src/protocol/api-v1-envelope.ts`：独立版本的响应 schema；宿主 `src/protocol/api-response.ts`：普通 v1 / Chat / 其他协议的错误格式选择 |
| Provider / Model | `packages/resources/model-management/src/server/{routes/api/models.ts,schemas/api-model.schema.ts,facades/provider-facade.ts,services/provider-service.ts,services/model-service.ts,services/available-models-cache.ts}` 及 `assembly.ts`、`src/server.ts` | 同目录 `routes/api/providers.ts`：Provider CRUD；`services/api-v1-provider.ts`：v1 输入与输出转换，不持有领域规则 |
| Agent | `packages/resources/agent-config/src/server/{routes/api/agents.ts,schemas/api-agent.schema.ts,facades/agent-authoring-facade.ts,services/agent-associations.ts,repositories/agent-config-resource.ts}` 及 `runtime.ts` | 同目录 `facades/api-v1-agent-facade.ts`：v1 配置动作入口；`services/agent-config-write.ts`：无 actor 的事务保存编排，供经过授权的入口复用 |
| Instance | `packages/agent-runtime/src/{routes/api/instances.ts,schemas/api-instance.schema.ts,server/services/api-instance.ts,server/services/agent-instance-service.ts,server/repositories/agent-instance.ts,server/repositories/environment.ts,services/agent-chat-service.ts}` | `src/server/services/api-instance-resolution.ts`：connect / Chat 的授权与实例选择；`src/server/repositories/api-environment.ts`：默认环境锁内查询 / 创建所需持久化原语 |
| Chat | `packages/agent-runtime/src/{routes/api/openai-chat.ts,schemas/openai-chat.schema.ts,services/openai-response-mapper.ts,services/agent-prompt-turn.ts}` | `src/services/openai-history.ts`：纯文本历史适配；`src/services/api-chat-session-registry.ts`：受控续聊句柄 |
| Skill / MCP | 各 owner 的 `src/server/{routes/api/skills.ts,schemas/api-skill.schema.ts}`、`src/server/{routes/api/mcp.ts,schemas/api-mcp.schema.ts}` 及其现有 Facade / 内容服务 | 各自 `src/server/services/api-v1-skill.ts` / `api-v1-mcp.ts`：版本输入转换、公开 DTO 与脱敏；领域变更仍在原 owner 服务 |
| KB | `packages/resources/knowledge/src/server/{routes/api/knowledge-bases.ts,schemas/api-knowledge.schema.ts,facades/knowledge-base-facade.ts,services/knowledge-base-list.ts,services/agent-knowledge.ts,repositories/knowledge-base.ts}` | 不新增查询系统，深化既有组织查询和 provider 检查入口 |
| 文件 | `packages/resources/machine/src/{server/routes/api/workspaces.ts,schemas/api-workspace.schema.ts,server/facades/machine-workspace-facade.ts,server/services/api-workspace.ts,server/services/file-backends.ts,server/services/remote-file-service.ts}`；`packages/acp-link/src/client/file-operations.ts` | 不新增文件传输栈；删除 `api-workspace.ts` 中被公共执行面替代的重复实现 |
| Workflow | `packages/resources/workflow/src/server/{routes/api/workflows.ts,schemas/api-workflow.schema.ts}`；`packages/resources/workflow-v2/src/server/routes/api/workflows.ts` | `workflow-v2/src/server/schemas/api-workflow.schema.ts`：从 route 移出并版本化执行 DTO |
| 宿主及文档 | `apps/server/src/{openapi.ts,test-utils/route-faces.ts,__tests__/route-contributions.test.ts,__tests__/openapi-spec-generation.test.ts}`；各 owner `assembly.ts` / `src/server.ts` / 包 exports 按实际出口调整 | `apps/server/src/__tests__/external-api-v1-contract.test.ts`：认证、协议与版本契约；`docs/arch/external-api-v1.md`：实施完成后的稳定外部契约 |

以上相对路径均从仓库根起算。每任务的测试路径见下文；修改 manifest 仅限已有路由贡献所需，不迁移 owner，不手改生成 registry。Provider 原 route 已超长，借本次接口重写拆成 Provider 与 Model 两个文件。

## 3. 审查重点

1. 认证失败、schema 校验、413、未知路径会绕过正常 handler：仍须返回正确协议的错误，且不得改变 system / auth / Web。（任务 1、5、12、13）
2. 合法 UUID 引用了不可见资源，或保存中途失败：不允许越权绑定，也不能留下半个 Agent 或清空旧关联。（任务 3、8）
3. 请求取消后底层启动 / prompt 仍可能在途：必须收口租约，不能误停共享 runtime 或取消另一会话。（任务 4、5、10、11）
4. 多个上传写同一路径、路径在校验后被 symlink 替换：不得覆盖已有文件或越界；远端不可用不得落到本地。（任务 9）
5. Web 改默认值、错误或编排后，共享服务返回形状发生变化：v1 的固定契约测试仍通过；不能同步改预期掩盖破坏。（每资源任务及任务 13）

## 4. 顺序与交付点

1. **A：基础闭环**，任务 1 → 2 → 3 → 4 → 5：选择模型、创建 Agent、完成 SDK 对话。
2. **B：能力与文件**，任务 6、7、8 → 9：导入 Skill、配置 MCP、绑定已有 KB、上传后对话。默认顺序执行，未选择执行方式前不调度子代理。
3. **C：续聊与并发**，任务 10 → 11：生命周期失效、受控续聊、多实例 / 多会话隔离。
4. **D：Workflow 与交付收口**，任务 12 → 13：两个执行 API 格式统一、完整文档与真实验收。

每个交付点可在开发环境演示；35 项接口全部验收前，不把部分切片当作 v1 完整发布。

## 5. 实施任务

### 任务 1：Provider 查询贯通统一协议与真实认证

**文件：** 协议和 Provider 文件见 §2；修改 `apps/server/src/__tests__/{error-handler,round45-auth-plugin,openapi-spec-generation}.test.ts`；新增 `external-api-v1-contract.test.ts`；扩展 `packages/resources/model-management/src/__tests__/api-models-routes.test.ts`。

- [ ] 补失败测试：Provider 列表 / 详情使用 `/api/v1/providers`，返回独立 DTO 与分页包装；网关读到 `kind/gatewayType`，无密钥、无 `resourceAccess`；未知路径返回 v1 404。
- [ ] 补完整宿主请求测试：无凭据 401、非法参数 400、输入过大 413、AppError 与未知异常均有正确包装及脱敏；同一 app 的 `/web`、system / auth 和原生 Chat 错误不被误包装。API Key 的组织来自 metadata，并按当前成员角色重新校验。
- [ ] 运行上述测试确认失败：`bun test apps/server/src/__tests__/external-api-v1-contract.test.ts packages/resources/model-management/src/__tests__/api-models-routes.test.ts --isolate`。
- [ ] 新增 `ApiV1OkSchema<T>`、`ApiV1ErrSchema`，形状按设计 §4；独立冻结 v1 契约，不以 Web schema 的未来变动决定 v1。复用平台已有授权 / 分页能力，v1 请求 query 使用 `.strict()` 且不引用 Web DTO。
- [ ] 宿主新增 `classifyApiResponse(pathname): "v1" | "openai" | "other"` 与 `formatApiError(...)`；只匹配 `/api/v1` 及边界，优先精确识别 `/api/v1/chat/completions`。认证守卫的提前返回和全局 onError 均调用格式选择，保留原认证顺序、HTTP 状态和日志。Workflow 的 422 在任务 12 保留其具体映射。未知 v1 路径同样处理，不遍历包装所有 JSON / Response。
- [ ] 实现 Provider GET，删除对应 `/api/models/providers` GET；写接口的替换随任务 2 完成。更新宿主路径清单和当前调用方，运行该组测试及 `bun run fastcheck`，确认其他协议不变。

### 任务 2：Provider / Model 配置与网关只读

**文件：** §2 Provider / Model 行；测试 `packages/resources/model-management/src/__tests__/{api-models-routes,provider-facade-model-scope,model-gateway-provider-service,round-config-providers-routes}.test.ts`。

- [ ] 补失败测试并运行：`bun test packages/resources/model-management/src/__tests__/api-models-routes.test.ts packages/resources/model-management/src/__tests__/provider-facade-model-scope.test.ts --isolate`。断言 displayName-only PATCH 保留 anthropic；子模型路径不匹配返回 404；网关及其模型所有写入拒绝；并发同组织同名创建仅一条成功，另一条 409。
- [ ] 实现 Provider POST / PATCH / DELETE 及模型五项 CRUD。创建和更新分别建 schema，PATCH 禁止 name / 上游 modelId 重命名、无默认 protocol、空更新 400。模型 DTO 明确区分数据库 `id` 与上游 `modelId`；密钥仅返回 `hasApiKey`。
- [ ] 在领域写入成功提交后失效可用模型缓存，复用同一缓存入口覆盖 Web / v1 / 网关同步；事务失败不发成功事件。调用方不重复实现授权、网关判断或名称 upsert。
- [ ] 删除原 `/api/models/providers/**` 对应路由及废弃 DTO；两面独立测试 DTO / 默认值，运行本任务四组测试与 `fastcheck`。操作计数此时为 Provider 5 + Model 5。

### 任务 3：Agent 五项 CRUD、权限与原子保存

**文件：** §2 Agent 行，以及 `repositories/{agent-config-skill,agent-config-mcp}.ts`；测试原 `api-agents-routes.test.ts` / `api-agent-schema.test.ts`，新增同目录 `api-v1-agent-write.test.ts`。

- [ ] 补失败用例：创建 201、同名冲突 409、无 name PATCH、modelId 是模型行 ID；读取真实 enableMemory；只改 prompt 保留绑定；null 清空、数组空值解绑、重复 ID 400；跨组织 / 不可见 Model、Skill、MCP、KB 不可绑定。
- [ ] 注入每个关联写入失败并断言 Agent 行、记忆开关和全部旧绑定均不变；并发 PATCH 不得形成半套关联。运行 `bun test packages/resources/agent-config/src/__tests__/api-v1-agent-write.test.ts --isolate` 确认失败。
- [ ] 实现 v1 Facade 的 `create(actor, input)` / `patch(actor, id, input)` / `get` / `list` / `remove`，input / result 分别从本包 v1 schema 推导。授权留在应用层，调用资源 owner 取得授权结论，不把 UUID 格式当权限。
- [ ] 提取无 actor 的 `saveAgentConfig(command)`：在 `agent-config-resource.ts` 新增严格创建原语，采用真正 INSERT 与唯一冲突映射，不调用现有冲突后更新的 create 分支，也不改坏其他入口的既有行为；更新锁定目标 Agent 行，`runInTransaction()` 内保存配置、显式关联和 memory，嵌套 owner 写入必须加入同一事务。先校验全部绑定，不在事务内调用远端 provider / 文件 / runtime。
- [ ] 既有 Web 写入入口复用原子保存能力并保持原 DTO / 默认值；保留删除的 built-in 保护及 strict stop 编排。v1 schema 与返回映射独立，name 不可 PATCH，不返回历史 model 文本 / 页面字段。
- [ ] 删除旧 `/api/agents` CRUD，迁移测试与调用方。运行本包相关测试、Web 配置回归、`fastcheck`；另用真实 PostgreSQL 验证故障回滚、唯一冲突和行锁，不以 stub 验证替代数据库证据。

### 任务 4：connect、实例列表 / 详情 / stop / restart

**文件：** §2 Instance 行；`packages/agent-runtime/src/server/transport/relay/external-relay.ts`；测试既有 `api-instance-{service,routes}.test.ts`、`external-relay.test.ts`、`instance-manual-stop.test.ts`，新增 `api-instance-resolution.test.ts`。

- [ ] 补失败测试：显式实例先反查所属 Environment，再校验组织 / owner / Agent / 来源；禁止 workflow 来源；自动选择仅 `api/primary`；多环境按 createdAt / id 稳定选；并发首次 connect 与 Chat 只产生一个默认环境及实例。
- [ ] 补只读与生命周期测试：GET 不建环境 / 不启动；分页查询过滤 owner / organization / Agent / creationSource；strict stop 失败不报成功；手动停止后 connect / Chat 409，restart 保留 ID 并推进 generation。运行 `bun test packages/agent-runtime/src/__tests__/api-instance-resolution.test.ts packages/agent-runtime/src/__tests__/api-instance-routes.test.ts --isolate` 确认失败。
- [ ] 新增 `resolveApiAgentInstance(owner: InstanceOwner, agentConfigId: string, options: { instanceId?: string; signal?: AbortSignal }): Promise<ResolvedApiAgentInstance>`；在同文件定义结果 `{ agentConfigId: string; environmentId: string; instance: AgentInstanceRecord }`，`AgentInstanceRecord` 引用本包现有类型，结果只在完成全部授权后返回。connect 与 HTTP Chat 共用该 v1 选择策略；Workflow / Web Chat 不切换默认来源。
- [ ] 默认 Environment find-or-create 经仓储原语取得组织 / 用户 / Agent 的事务级 advisory lock；锁内复查并创建，自动名称包含用户区分，提交后才 ensure runtime。复用实例唯一约束与 Coordinator，取消后确认已启动 runtime 的占用能收口，不以请求 dispose 停机。
- [ ] 实现五项 Instance API，body 改为 `instanceId`；列表 / 详情投影字段按设计 §7.2、日期 ISO UTC。relay URL 继续 `/acp/relay/{environmentId}?instanceId=...`；外部 ACP 的 cwd 按认证 Environment 注入 / 校验，拒绝逃逸。重复连接不向日志或响应暴露 token / 原始 session ID。
- [ ] 删除旧 connect 路由，运行本任务测试与 `fastcheck`。真实 PostgreSQL 并发验证默认环境唯一，ACP 用不同请求 ID 验证握手 / prompt / update 和归属，不能只断言返回了 URL。

### 任务 5：无状态 OpenAI SDK 对话，完成 A 闭环

**文件：** §2 Chat 行中的历史与 mapper，`services/{agent-chat-service,agent-turn-events}.ts`；测试 `openai-{chat-routes,chat-service,response-mapper}.test.ts`，新增 `openai-history.test.ts`、`openai-sdk-v1.test.ts`。

- [ ] 补失败用例：body.model 为 Agent ID；仅接收 model / messages / stream / n=1；最后一条为非空 user；system / developer 只在开头；多模态、tools、采样参数等按设计 §8.1 返回原生 400。完整历史按角色和顺序送入 Agent，不只发送最后 user，不允许历史文本伪造上下文分隔符。
- [ ] 使用现有 `openai` SDK 实际请求 Elysia 测试 HTTP 服务，覆盖 stream=false / true；断言原生结构、assistant 首块、finish_reason、`[DONE]`、无伪造 usage、无工具 XML / 内部思考。运行 `bun test packages/agent-runtime/src/__tests__/openai-sdk-v1.test.ts packages/agent-runtime/src/__tests__/openai-history.test.ts --isolate` 确认失败。
- [ ] 将路由替换为 `POST /api/v1/chat/completions`。`adaptOpenAIHistory(messages): Parameters<PromptTurn["prompt"]>[0]` 使用现有 turn 的 ACP 内容块类型，messages 类型取本包请求 schema 推导；只负责文本上下文编码，不另建模型消息 / ACP 协议栈。Agent 系统约束仍权威，文档不声称等价原生多角色模型输入。
- [ ] `openAgentSession` 增加可选 instanceId，并改用任务 4 解析入口；开始请求即建立默认 300 秒总预算，覆盖权限、runtime、握手和读取。先确认握手再发流式成功头；stream 开始后失败不伪造正常终块。
- [ ] 映射 end_turn→stop、长度终止→length；取消 / 断连 / 超时只处理当前 turn，有界背压与资源释放，不自动重试 prompt。保留 Web / Workflow 对既有 turn API 的调用行为。
- [ ] 删除 `/api/agents/:agentId/v1/chat/completions` 旧路由及旧原始 sessionId 输入，临时不暴露续聊句柄，任务 10 补齐。运行 SDK、turn 生命周期、宿主错误测试与 `fastcheck`；用真实网关完成 A 闭环，记录测试 Agent / Instance / requestId，不记录凭据或正文。

### 任务 6：Skill 导入、更新与文件补偿

**文件：** §2 Skill 行及现有 import / archive 服务；测试 `api-skills-routes.test.ts`、`skill-{upload-binary,import-name-overwrite,archive-lifecycle}.test.ts`。

- [ ] 补失败测试：multipart manifest 与文件一一对应，保留二进制；创建 201 / 默认同名 409 / 有权限 overwrite 200 且 ID 和受众不变；跨组织覆盖拒绝；同 Skill 并发覆盖不得混合文件。
- [ ] 补按 ID PATCH content / description / metadata / publicReadable、字段缺席保留和 metadata 整体替换用例；注入文件、元数据、归档失败，断言补偿后无半成品。运行 `bun test packages/resources/skill/src/__tests__/api-skills-routes.test.ts --isolate` 确认失败。
- [ ] 完成 `/api/v1/skills` 五项操作及独立 DTO；版本转换调用现有完整内容编排（setSkill / importSkillDirectories），不直接 upsert 元数据；在既有内容 owner 内串行同资源覆盖，不新建全局锁框架。
- [ ] 删除旧 Skill 路由、迁移示例，运行本任务四组测试和 Web Skill 回归、`fastcheck`。列表 / 详情不返回源绝对路径。

### 任务 7：MCP 完整配置与独立启停

**文件：** §2 MCP 行；测试 `round47-api-mcp-routes.test.ts`，新增 `api-v1-mcp-patch.test.ts`。

- [ ] 补三种 config 的创建 / 读取测试；local environment 不丢失；enabled-only PATCH 保留 command / environment / headers / OAuth；半个 config 和启停 / 替换混用 400，原值不变；只有 disabled 标记的旧记录不能直接启用。
- [ ] 对照脱敏断言：不回传敏感 environment / headers 值或 clientSecret，返回键名与已配置状态；重复创建 409，不覆盖旧连接。运行 `bun test packages/resources/mcp/src/__tests__/api-v1-mcp-patch.test.ts --isolate` 确认失败。
- [ ] 实现 `/api/v1/mcp-servers` 五项操作；strict 联合 schema 区分启停、完整 config 替换和仅受众更新；版本入口调用已有权限与配置服务，完整替换不做隐式深合并。配置生效仍要求实例重启。
- [ ] 删除旧 `/api/mcp` 路由和 PUT，更新调用方。运行两组 API 测试、MCP Web 配置回归与 `fastcheck`，验证 Web 变化不改变 v1 PATCH 语义。

### 任务 8：已有 KB 查询与绑定，完成能力闭环

**文件：** §2 KB 行；任务 3 Agent 绑定入口；测试 `api-knowledge-bases-routes.test.ts`、`api-v1-agent-write.test.ts`，新增 knowledge 包 `api-v1-knowledge-status.test.ts`。

- [ ] 补两组织查询 / total / 分页测试：只返回凭据当前组织已有 KB；远端存在 / 不存在 / 不可达分别为 true / false / null；单库超时不拖死整页，查询不修改本地 ready 状态或回填记录。
- [ ] 补绑定失败回归：已有绑定不因非法 ID、跨组织 ID 或持久化异常被清空；远端临时离线仍允许合法本地绑定。运行 `bun test packages/resources/knowledge/src/__tests__/api-v1-knowledge-status.test.ts packages/resources/agent-config/src/__tests__/api-v1-agent-write.test.ts --isolate` 确认失败。
- [ ] `/api/v1/knowledge-bases` 复用组织查询，count 与 items 同谓词；对当前页复用 provider 检查，初始并发上限 4、单库超时 3 秒，AbortSignal 终止检查并释放槽位，不无界后台挂起。以上为本计划的实现预算，不新增部署变量。
- [ ] knowledge owner 先验证本地归属，再在调用者事务内替换绑定；不泄露远端账户 / lastError。删除旧查询路由的全表读取路径，运行本任务测试、Web KB 回归与 `fastcheck`。
- [ ] 真实配置一个包含 Skill / MCP / KB 的 Agent，重启其自有实例完成工具对话；不能只以配置保存成功宣称工具可用。

### 任务 9：统一文件执行能力并验证上传后对话

**文件：** §2 文件行；测试 `packages/resources/machine/src/server/__tests__/api-workspace-routes.test.ts`、`packages/acp-link/src/__tests__/file-operations.test.ts`；新增 machine 包同测试目录 `api-v1-workspace-upload.test.ts`。

- [ ] 补失败测试：认证用户可上传自己的 Environment，拒绝其他用户 / 组织；仅 user 子树；relativePaths 数量不符、重复目标、绝对路径 / .. / 控制字符 / symlink 越界均在写入前拒绝。
- [ ] 验证单文件 92 MiB、整请求 108 MiB、远端批次 92 MiB 的独立限制；本地 / 远端已存在或两请求同时写同路径时至多一个成功，另一个 409，原文件不变。远端 file-ws 离线为 503，未落本地文件。
- [ ] 运行 `bun test packages/resources/machine/src/server/__tests__/api-v1-workspace-upload.test.ts packages/acp-link/src/__tests__/file-operations.test.ts --isolate` 确认失败；实现 v1 上传入口调用 AgentFileService，保留 actorId、source=api、变更事件与路径安全检查，路径 / 容量 / 错误由 v1 契约限定。
- [ ] 远端若未提供原子排他创建，在现有上传动作增加并落实不覆盖语义至 acp-link 写盘；不能用 stat 后普通写入代替。更新该动作两端 schema / 测试，不新建文件协议。对执行中部分成功返回明确失败，不承诺批次事务、不自动重试。
- [ ] 删除旧重复写入 / 校验路径与旧 HTTP 路由，更新边界豁免和 machine README 的实际完成事实。运行相关文件测试、`fastcheck`；真实本地和远端各上传一次，经 SDK Chat 读取文件回答，确认停止 / 普通重启后文件语义不变。

### 任务 10：受控续聊句柄与实例生命周期联动

**文件：** §2 `api-chat-session-registry.ts`、Chat route / service、`agent-prompt-turn.ts`、`apps/server/src/plugins/cors.ts`；新增 `packages/agent-runtime/src/__tests__/api-chat-session-registry.test.ts`，扩展 SDK 与生命周期测试。

- [ ] 补失败测试：句柄 fcs_ 绑定组织 / 用户 / Agent / Environment / Instance / generation；不同句柄可各自续聊，同句柄重入 409；带句柄且 messages 非单 user 为 400；原始 ses_*、跨主体、错实例 / Agent、过期统一 SESSION_UNAVAILABLE，不创建替代会话。
- [ ] 假时钟断言闲置 30 分钟过期、每组织 / 用户 256、进程 10000 条，先预留再 prompt，活跃条目不被 LRU 淘汰，满员活动时 429；取消 / 失败 / stop / restart / generation 改变失效，进程重启后不恢复。
- [ ] 运行 `bun test packages/agent-runtime/src/__tests__/api-chat-session-registry.test.ts --isolate` 确认失败。实现 `reserve(owner)` / `confirm(reservation, session)` / `acquire(handle, owner)` / `release(lease, outcome)` / `invalidateInstance(instanceId)`；注入时钟用于边界验证，不新增存储。owner 包含上述完整绑定，confirm 只接受服务端 ACP 握手确认的 session。
- [ ] `PromptTurn` 仅对内部调用者提供已确认 session 信息，实际 session/new / load / prompt 继续复用既有实现；不把原始 ACP session ID 置于响应、句柄或日志。容量失败、握手失败及取消均释放预留；未确认 cancel 的 turn 不提前释放会话锁。
- [ ] 输出 X-Instance-Id / X-Session-Id / X-Session-Expires-At / X-Request-Id；CORS 允许 X-Instance-Id / X-Session-Id 请求头并暴露响应头及 Retry-After，不扩大 origin 或凭据策略。运行 SDK、CORS、session、manual-stop、generation 相关测试与 `fastcheck`。

### 任务 11：多实例、多会话真正并发与失败隔离

**文件：** 新增 `packages/agent-runtime/src/__tests__/api-v1-concurrent-chat.test.ts`；复用 `fixtures/in-memory-agent-relay.ts`，扩展 `agent-chat-service-concurrency.test.ts`、`external-relay.test.ts`、`agent-session-admission.test.ts`；缺陷修复仅限实例 / relay / turn owner。

- [ ] 构造 2 个已授权已有 Instance，每实例 2 个不同 ACP 会话；用屏障确认 4 个 turn 均已进入执行后才推送带不同标记的交错回执 / update。验证 4 路请求不串正文、历史、工具事件、结束标志或句柄；不能只使用 Promise.all 后检查成功码。
- [ ] 分别覆盖同实例两个新会话、两个不同续聊句柄、多实例流式 / 非流式混合、ACP 直接客户端多会话；确保配额足够，不因实例级锁整体串行。只有同一会话重入应 409，超配额请求 429 不替换已有请求。
- [ ] 对单会话注入取消、断连、超时、relay 错误，其余会话继续并可续聊；实例 A stop / restart 使 A 全部会话结束 / 句柄失效，实例 B 保持运行。全部收口后 listener / lease / 并发计数回基线，单会话完成不 stop runtime。
- [ ] 运行 `bun test packages/agent-runtime/src/__tests__/api-v1-concurrent-chat.test.ts --isolate`，先观察失败再修复；重点沿用 `extractJsonRpc`、sessionId + RPC ID 过滤、session 级 admission、请求级消费 lease，禁止另造协议栈或实例级对话锁。
- [ ] 运行既有生命周期 / relay / Workflow transport / Web Chat 关键回归与 `fastcheck`。真实 runtime 再执行 2×2 场景，记录不含正文和原始 ACP ID 的 requestId、Instance、句柄摘要及开始 / 结束时刻，证明至少两路执行区间重叠。共享 Environment 不承诺文件隔离。

### 任务 12：两个 External Workflow 执行接口

**文件：** §2 Workflow 行；测试 `packages/resources/workflow/src/__tests__/api-workflow-execute.test.ts`、`packages/resources/workflow-v2/src/__tests__/workflow-external-api.test.ts`。

- [ ] 补新路径与包装体失败测试：旧引擎 success=true + data.status=SUCCESS / FAILED / TIMEOUT，async 保留 runId / version；新引擎保留 data.data 字符串和五个 nullable 结果字段，不改请求参数。
- [ ] 覆盖认证 / 参数 422、跨组织同形 404、409、429 + Retry-After、502 / 503 / 504；保留旧引擎超时后后台继续、新引擎渠道自愈只重试一次和已有审计，不把工作流 FAILED 误当 HTTP 请求失败。
- [ ] 运行 `bun test packages/resources/workflow/src/__tests__/api-workflow-execute.test.ts packages/resources/workflow-v2/src/__tests__/workflow-external-api.test.ts --isolate` 确认失败；仅替换 URL 与 HTTP DTO，复用现有领域执行及错误映射，明确 framework 校验 422 的具体规则，避免任务 1 通用 400 覆盖它。
- [ ] 删除 `/api/workflows/:workflowId/execute` 和 `/api/workflow-v2/workflows/:id/run`；替换为设计 §9.1 的两个 `/api/v1` 路径，仍归 External Workflow 分组。运行上述测试、渠道发布回归、宿主认证 / 文档回归与 `fastcheck`。

### 任务 13：契约冻结、旧路径清单与真实验收

**文件：** §2 宿主及文档行；新增 `apps/server/src/__tests__/external-api-v1-retirement.test.ts`；更新 `.agents/skills/agent-platform-api/references/{config,environment,knowledge,workflow}.md` 中实际引用的 External API 段落，不增删技能目录；其他调用方按搜索结果逐项迁移。

- [ ] 建立最终 35 条 method + path 清单，与设计 §5 逐项比对；测试真实 route contribution / OpenAPI 的路径与 schema，普通 response 均包装，Chat 200 声明 JSON / SSE，multipart 是 binary，Bearer security 正确，system / auth 根及子路径继续排除。
- [ ] 用替换清单覆盖旧 Agent / Model / Skill / MCP / KB / connect / 上传 / Chat / 两 Workflow 路径，断言旧 handler 不可达且无重定向，不能只用全局 SPA fallback 的 200 判断。Web、system、auth、ACP、hooks 等范围外入口仍可按原协议调用。
- [ ] 固定 v1 契约测试包含 DTO、字段缺省 / null、PATCH 保留、权限范围、状态码、错误、安全脱敏、副作用和分页；独立提供 Web 与 v1 的不同输入 / 返回示例，确认共享服务调整后两面各守其约定。测试预期来自批准的契约，不从当前 Web schema / 输出动态生成。
- [ ] 运行 `bun test apps/server/src/__tests__/external-api-v1-contract.test.ts apps/server/src/__tests__/external-api-v1-retirement.test.ts apps/server/src/__tests__/route-contributions.test.ts apps/server/src/__tests__/openapi-spec-generation.test.ts --isolate`；确认失败后补齐装配 / 文档 / 调用方，运行至通过。
- [ ] `rg` 搜索范围内旧 HTTP URL，逐处迁移脚本、引用、SDK baseURL、示例与测试；归档 / 历史设计中的旧路径说明可保留，运行调用与对外指南不能残留。现有指南更新为 v1 配置 → connect → 上传 → SDK / ACP → stop / restart 的可执行流程。
- [ ] 实施完成后新增 `docs/arch/external-api-v1.md`，更新同目录 `04-agent-config.md`、`06-config-provider.md`、`06-config-skills.md`、`06-config-mcp.md`、`11-knowledge.md`、`12-files.md`、`22-agent-instance-management.md`；只记录最终事实，不把迁移过程或单次计划塞回 CLAUDE / 通用规范。
- [ ] 真实验证使用两个组织、同组织不同角色、同 Agent 不同用户、本地 / 远程文件、真实网关和已有 KB，完成 A—D 闭环与任务 11 并发。缺基础设施则列明未验收项，不以 stub 代替。
- [ ] 收尾依次运行 `bun run fastcheck`、`bun run docs:build`、提交前 `bun run precheck`；若实际修改前端再运行 `bun run build:web`。全量检查失败先定位，不改超时或减少覆盖来宣称通过。

## 6. 覆盖自检与交接

| 设计章节 / 验收 | 实施任务 |
| --- | --- |
| §4 版本、包装、认证、错误、秘密 | 1；各资源任务；13 |
| §5 Provider 5 + Model 5 | 1—2 |
| §5 Agent 5、§6.1 原子配置 / 关联 | 3、8 |
| §5 Skill 5、MCP 5、KB 1 | 6—8 |
| §5 Instance 5、§7 ACP / 生命周期 | 4、10—11 |
| §5 文件 1、§7.3 本地 / 远端执行 | 9 |
| §5 Chat 1、§8 历史 / SDK / 续聊 | 5、10 |
| §9 Workflow 2 | 12 |
| §10.2 多实例、多会话、取消 / 配额 / 回收 | 4、10—11 |
| 版本契约独立、旧路由替换、OpenAPI 与消费者 | 每资源任务、13 |

交付不包含 DDL、依赖安装或新技能。实现开始前确认执行方式；本计划不授权自动提交或推送。发布回退须同步服务与受控调用方版本，不恢复跨组织 KB 全表可见，也不修改资源数据来补偿协议回滚。
