# ADR: workflow-v2 以 iframe + BFF 票据接入上游工作流引擎

- **日期**：2026-09-29
- **状态**：✅ 已确认（设计 §1.4 与 §5.6 的决策登记；实现进行中，进度见设计 §7 与任务清单）

## 背景

自研 workflow 前端（`packages/resources/workflow/web`，约 100 文件 / 1.7 万行）与基于 `@xyflow/react` 的画布已到能力与体验上限；上游工作流引擎（外部仓库 `/Users/konghayao/code/ai/workflow-studio`）提供成熟的画布（FlowGram）、节点体系、调试运行、版本发布与运行 trace，且其 Go 服务自带前端静态资源。

本次决策：删除我方全部 workflow 前端界面，新增 `workflow-v2` 模块转接上游的 workflow 能力——控制台用 iframe 嵌入上游画布页，画布内请求经同源反代**透传**给 workflow-v2，由 workflow-v2 以平台身份转接上游后端。架构细节见 [25-workflow-v2](../arch/25-workflow-v2.md) 与[设计文档](../design/2026-09-29-workflow-v2-upstream-studio-bridge.md)。

## 决策

### 1. 集成形态：iframe + 同源反代 + BFF 票据

**不拷贝上游前端源码进本仓，不做 Module Federation。**

- 拷贝源码等于承接其 20+ 子包、生成式 IDL 与内部设计系统的完整构建链与全部升级成本，与「删除自研前端以收敛维护面」的目标相悖。
- Module Federation 要求跨仓 lockstep 共享 React 与构建版本，运行时契约脆弱；且它无法约束子应用的网络行为——票据与参数注入必须在服务端收口，形态选择绕不开这一点。
- 同源反代（`/workflow-canvas/*` 落在控制台域下）带来三个直接收益：无 CORS、控制台会话 cookie 同站可用、票据只走请求头最简单。代价落在反代本身：上游除静态白名单外全站经 session 中间件，静态反代必须**出站**注入平台账号会话，同时**入站**剥离上游 `Set-Cookie`（两个方向不可混为一谈）。

### 2. 上游侧当黑盒：只改 `frontend/**`，不动 Go 后端，只用现成 HTTP API

> **（2026-10-09）一度存在的例外已撤回**：同日曾为运行日志的「执行列表」临时直连上游库（因为当时上游没有可
> 列举的读出口）；上游随后以 `3a028cf1` 实现 `list_spans`，平台按
> [该 ADR](./2026-10-09-workflow-v2-upstream-db-read.md)（已废弃）的移除条件删除了全部直连实现并切回 HTTP。
> 因此本节仍是**无条件成立**的口径：与上游的交互只改前端、只用现成 HTTP API。

### 3. 租户 → App（bot）映射：organization 1:1 App，workflow 挂在 App 下

- App 是上游侧唯一的资源物理边界——workflow 的 `project_id` 就是它，且 `workflow_list` 的 `project_id` 是硬过滤（不传则挂在该 App 下的 workflow 完全不出现）。不映射则所有租户的 workflow 混在平台空间里，无法分租户分页。
- 不用「每用户一个 App」：App 数量随用户数增长，而上游 **没有「按空间列 App」的接口**（`space/list` 的 `app_ids` 恒为 `null`），数量失控后无法盘点。
- 平台整体只用一个上游用户与个人空间：接入面只维护一条会话；代价是该账号**单会话**（重登踢旧键），多副本必须共享会话来源。

### 4. 归属真相源放本地注册表，不依赖上游校验

- 上游的 `checkUserSpace` 只证明「平台账号属于该 space」，**不校验 workflow ↔ App 归属**，也不表达我方用户；跨租户隔离若依赖它等于没有隔离。
- 因此 `workflow_v2_workflow` 是归属的唯一真相源：所有带 `workflow_id` 的请求先校验「存在 + 属于当前组织 + 有权」，未命中统一 404（不泄漏存在性）；上游参数（`space_id`/`project_id`/`bot_id`/`owner_id`/`login_user_create`/`creator`/`operator`）一律由服务端注入并 strip 客户端同名值。
- 这是安全边界而非实现细节：后续新增任何透传路径，都必须先回答「归属由谁判定」。

### 放弃条件与迁移路径

**放弃条件**（触任一条即回到设计评审，改用其它形态或更换方案）：

1. 出现必须与宿主共享 React context / DOM 的深度交互；
2. `bind` / `refresh` 握手失败率长期 > 1%；
3. 上游前端无法完成必要裁剪（登录闸门、壳裁剪、basename 与资源前缀）。

**迁移路径**：① 同源反代 + 票据（本次）→ ② 拆子域 + 强 sandbox + CORS（需要更硬隔离时；显式 origin 白名单、`credentials:false`、仅收 header 票据）→ ③ 若深度集成确有必要，把上游的 workflow 包以 npm 依赖引入本仓，**BFF 与票据协议不变**，iframe 退化为降级路径。

## 考虑过的替代方案

| 方案 | 结论 |
| --- | --- |
| 把上游前端源码拷进本仓 | ❌ 承接 20+ 子包与生成式 IDL 的构建链与全部升级成本，与「删除自研前端」的目标相悖 |
| Module Federation 运行时组合 | ❌ 跨仓 lockstep 共享 React / 构建版本，契约脆弱；子应用网络行为不受控，票据与注入仍需服务端 |
| 自研画布继续演进 | ❌ 即本次被替换的现状，能力上限与维护面既定 |
| 每用户一个 App，或全局单 App | ❌ 前者 App 数量失控且无接口盘点；后者丢失租户物理边界，`project_id` 过滤失效 |
| 归属校验交给上游（只靠 space 成员关系） | ❌ 不构成多租户隔离：平台账号能读到该空间下任意租户的 workflow |
| 把上游 workflow 包作为 npm 依赖直接引入 | ⏳ 迁移路径第 ③ 步，仅在放弃条件触发时启用 |

## 后果

**积极后果**：自研 workflow 前端可整块下线，界面维护面收敛为列表页 + 宿主页；编辑、调试、发布与 trace 直接复用上游；平台凭据不出 workflow-v2，租户隔离判定集中在一处（本地注册表）。

**风险与缓解**：

| 风险 | 缓解 |
| --- | --- |
| 上游升级导致契约漂移 | 固定镜像 digest；升级前重跑 `scripts/workflow-v2/upstream-contract-probe.ts` 与契约快照逐行比对；按组织灰度 |
| 平台账号单点（全平台 workflow 依赖一条会话） | 主动探活 + 单飞自动重登 + 告警；只读降级到本地元数据视图；多副本共享会话来源（~~未落地~~ **已落地（2026-09-29，4B）**：会话权威副本在共享存储 Redis + 登录租约，见 [25-workflow-v2](../arch/25-workflow-v2.md) §6 第 6 条） |
| iframe 同源共享 origin，sandbox 不构成安全边界 | 真实边界 = CSP `frame-ancestors` + 短 TTL 可撤销票据 + BFF 归属校验 |
| 归属校验遗漏 → 跨租户越权 | 校验集中在 Facade 与透传入口；用例覆盖伪造 `space_id`/`project_id` 与跨租户 `workflow_id`（一律 404） |
| 反代路由顺序错误（透传请求被静态反代吞掉） | 声明序固定 `bff` 先于静态反代，并纳入部署检查清单 |
| 存储直链改写成为长期特例 | 只按已知 origin 前缀替换、不做泛化；代码内注明移除条件（上游可配置对外存储域即删） |

## 追加决策：对外触发面与平台 PAT 凭据生命周期（2026-10-09）

### 背景

需求方要求「工作流支持对外接口，外部系统可以触发工作流运行」。上游确实有对外触发端点 `POST /v1/workflow/run`（运行已发布版本），但它与画布/控制台面**不是同一种鉴权**：`/v1/*` 只接受 `Authorization: Bearer pat_*`，平台账号的会话 cookie 会被 OpenAPI 中间件直接拒绝；平台侧此前零 PAT 支持（`upstream-session` 只有 `session_key`，`callUpstream` 只覆盖 `/api/*` 且只注入 cookie）。studio-bridge 设计的 §9.3 开放问题 #2 正是这件事，阻塞条件写的是「先定对外身份与凭据生命周期（PAT 轮换、失效降级）与归属口径」。

### 决策

1. **接口落在 workflow-v2 的 `api` 槽贡献**（`POST /api/workflow-v2/workflows/:id/run`），宿主只按槽聚合；对外身份用控制台 API Key（`rcs_*`，与既有 `/api/*` 一致），**不是** `RCS_SYSTEM_API_KEYS`。
2. **租户隔离仍由本地注册表判定**：`:id` 是本地主键，跨组织与不存在同形 404。上游只做 `checkUserSpace`（PAT 用户属于该 space），拿它当隔离等于没有隔离——这是 §4「归属真相源放本地」在新增路径上的同一结论。
3. **运行语义固定为「已发布版本」**，不提供草稿/调试通道（后者语义是 `test_run`，且对模型配置有硬依赖）；同步/异步由请求体的 `isAsync` 选择，平台不承载 SSE。
4. **平台持有一枚平台账号 PAT**（而非让部署方注入 env）：用平台账号会话换取，权威副本与登录态一样放共享存储（Redis）+ 跨副本租约单飞，进程内短缓存；剩余时长不足 1/3 主动轮换，轮换成功后尽力吊销被替换的旧令牌；上游判定失效时 `invalidate()` + 重建 + 重放一次。PAT 按密钥材料对待：不落库、不进日志/响应/错误文案。
5. **响应归一化**为 `/api/*` 的域形状（`{executeId,data,token,cost,debugUrl}` / `{error:{code,message}}`），**不**沿用画布面的「原样回传上游信封」（那是画布 SDK 的协议要求，与对外合同无关）；上游业务码只映射能据此行动的两枚（未发布 409、参数不合法 422），其余归入 502，绝不透出上游 `msg`（panic 分支含 Go 堆栈）。

### 考虑过的替代方案

| 方案 | 结论 |
| --- | --- |
| 部署方注入平台 PAT env（`WORKFLOW_V2_PLATFORM_PAT`） | ❌ 轮换要人工重启，且与「平台账号自助注册」的自动化取向冲突；只在换取通道不可用时才值得回退 |
| 用会话 cookie 调 `/api/workflow_api/test_run` | ❌ 语义不符：`test_run` 是草稿调试运行，不是「运行已发布版本」 |
| 平台侧承载 SSE（`/v1/workflow/stream_run`） | ❌ 需要独立的长连接协议面与背压设计，本期只要「触发 + 拿结果/执行 ID」 |
| 原样透传上游信封给外部调用方 | ❌ 上游信封形状不统一（裸对象 / `data` 包裹 / 非 JSON panic）且是上游内部契约，会把我方对外合同绑死在别人的实现细节上 |

### 后果

**积极后果**：外部系统可用统一的 API Key 语义触发工作流；上游长期凭据由平台自管（换取、轮换、吊销都在一处）；归属与错误映射沿用既有口径，没有第二套判定。

**风险与缓解**：

| 风险 | 缓解 |
| --- | --- |
| PAT 是长寿命凭据（30 天） | 主动轮换 + 轮换后吊销旧令牌 + 不与 `session_key` 混存键位；只进 Redis 与出站头，不进日志/响应/错误文案 |
| `/v1/*` 未纳入契约快照基线，升级无回归保护 | 已登记为待办：把 `/v1/workflow/run` 的请求/响应字段补进契约快照并纳入升级回归 |
| 上游无幂等键，调用方重试会重复运行 | 按调用方身份限流（`WORKFLOW_V2_API_RATE_LIMIT_PER_MINUTE`），并在对外接口文档里写明「重试等于再跑一次」 |
| 本地 `published_version` 与上游发布态漂移（画布内发布不回写） | **已消除**（2026-10-09）：列表状态列与发布版本自增都改读上游 `workflow_detail_info` 的 `latest_flow_version`，本地列已无读写方；409 的判定仍取上游业务码 |
| 成功路径未实测（真实运行有成本） | 已用低风险探针实测鉴权、信封与错误码；成功路径的验证步骤与判据写在 §5.1，上线前执行一次 |

## 相关文档

- 设计与契约：[设计](../design/2026-09-29-workflow-v2-upstream-studio-bridge.md)（§1.4 决策摘要、§5.6 方案取舍）、[接口冻结](../design/2026-09-29-workflow-v2-interface-freeze.md)、[契约快照基线](../design/2026-09-29-workflow-v2-upstream-contract-snapshot.md)
- 架构：[25-workflow-v2](../arch/25-workflow-v2.md)、[17-workflow](../arch/17-workflow.md)（自研引擎，服务端保留）
- 任务：[Workflow V2 实施任务清单](../design/2026-09-29-workflow-v2-task-list.md)
