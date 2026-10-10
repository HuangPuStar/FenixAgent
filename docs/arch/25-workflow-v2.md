# Workflow V2 模块架构（workflow-v2）

> 状态：实现中（2026-09-29）。模块已进 `deploy/assembly/ce.json`（`resources` 与 `web` 两个列表），控制台已接线，自研 workflow 前端已删除；**画布端到端链路仍未跑通**（缺上游账号密码，见 §8）。
> 范围：模块定位、运行拓扑、身份与租户映射、归属真相源、四条路径面（含对外触发面）、票据链路、数据模型与补偿语义。
> 权威性：接口表、参数注入白名单、握手逐字段口径、节点白名单与删除计划以 [Workflow V2 设计](../design/2026-09-29-workflow-v2-upstream-studio-bridge.md)（下称「设计」）与 [接口冻结](../design/2026-09-29-workflow-v2-interface-freeze.md)（下称「冻结」）为准，本文只给结论与导航。
> 术语：**上游** 指外部仓库 `/Users/konghayao/code/ai/workflow-studio`（上游工作流引擎），**画布**指其 FlowGram 工作流编辑器页面。
> 命名：模块代码、环境变量、数据库列与用户可见文案一律用中立词（`upstream*` / `platform*` /「工作流空间」），不出现上游产品名；**唯一例外是上游契约**，见 §10。

## 1. 模块定位

`workflow-v2`（`@fenix/resource-workflow-v2`，`kind: "resource"`，能力 `resource.workflow-v2`）是上游工作流能力的接入模块，owner 身份映射、归属登记、票据、参数注入、透传与审计。

| 模块 | owner 什么 | 本期关系 |
|---|---|---|
| `packages/resources/workflow`（自研引擎，见 [17-workflow](./17-workflow.md)） | DAG 引擎与执行通道：`/web/workflow-defs`、`/web/workflow-runs`、`/api/workflows/:workflowId/execute`、`/hooks/:publicHash`、`/workflow-ui` 静态代理，以及全部 workflow 表 | **控制台前端已删除**（`web/**` 与 `exports["./web"]`，2026-09-29）；服务端与引擎保留，两个模块在装配面上并存 |
| `packages/resources/workflow-v2` | 上游接入面：身份与租户映射、归属真相源、票据、透传、审计 | 新增，与上者并存 |

边界：workflow-v2 **不解释 workflow schema、不执行节点、不落 workflow 定义**——定义、版本、运行、发布的权威实现是上游；上游侧按黑盒使用，只调其现成 HTTP API，改造仅允许落在其 `frontend/**`。

## 2. 运行拓扑

```mermaid
flowchart TB
    subgraph B["浏览器（控制台域）"]
        LIST["列表页 /agent/workflow"]
        HOST["画布宿主页 /agent/workflow/$id/edit<br/>持票 · 握手 · 续期 · 撤销"]
        FRAME["iframe /workflow-canvas/*<br/>上游画布 SPA"]
    end

    subgraph S["apps/server（我方可信边界）"]
        WEB["/web/workflow-v2/*<br/>控制台面（会话 cookie）"]
        BFF["/workflow-canvas/bff/*<br/>透传面（ticket）"]
        STATIC["/workflow-canvas/*<br/>静态反代 + storage/*"]
        REG[("workflow_v2_* 四张表<br/>归属与审计")]
        SESS["UpstreamSession（进程内）<br/>平台账号 session_key"]
    end

    UPSTREAM["上游工作流引擎（内网）<br/>/api/workflow_api/* 与静态资源"]

    LIST --> WEB
    HOST --> WEB
    HOST -->|"postMessage：code / ticket / signout"| FRAME
    FRAME --> BFF
    FRAME --> STATIC
    WEB --> REG
    WEB --> SESS
    BFF --> REG
    BFF --> SESS
    STATIC --> SESS
    BFF -->|"参数注入后的原样响应"| UPSTREAM
    STATIC -->|"出站注入 Cookie"| UPSTREAM
    SESS -->|"Cookie: session_key"| UPSTREAM
```

| 组件 | 负责 | 不负责 |
|---|---|---|
| 控制台（`apps/web` + `workflow-v2/web`） | 列表/创建/删除、上游发布状态与发布记录**只读**查看、iframe 宿主、握手与票据转发、错误与降级 UI | 不直连上游；不持有平台凭据 |
| workflow-v2（后端） | 身份映射、归属真相源、参数注入、票据签发与校验、上游会话、透传、审计 | 不解释 workflow schema；不执行节点 |
| 上游服务 | workflow 定义/版本/运行/发布的权威实现；画布静态资源 | 不感知我方租户与用户 |

## 3. 身份与租户映射

| 平台侧 | 上游侧 | 承载 |
|---|---|---|
| FenixAgent 平台整体 | 1 个上游用户，及其个人空间（space） | 凭据只存 env secret（`secret: true`）；`session_key` 只住在 workflow-v2 的会话存储（共享存储 Redis，未配置或不可用时降级为进程内单例，见 §6），不入库、不入日志、不进响应 |
| organization（租户） | 1 个 App（bot，`POST /api/draftbot/create`） | `workflow_v2_org_app`，`unique(organization_id)` / `unique(app_id)` |
| workflow | 租户 App 下的一个 workflow | 创建时注入 `space_id`=平台个人空间、`project_id`=租户 App |
| 平台用户 | **无对应物** | 上游侧 creator 恒为平台账号 → 用户归属只存在于本地注册表的 `owner_user_id` |

- 空间 ID 由 `space/list` 选出个人空间（`space_type === 1`）后落 `workflow_v2_platform_account`，是建 App 与建 workflow 的 `space_id` 注入源。
- 登录面 `POST /api/passport/web/email/login/`：`session_key` **只出现在 `Set-Cookie`**，必须解析响应头而非 body；同一账号同时只有一个有效会话，重登即踢旧键——多副本各自登录会互相踢键，4B 起由共享存储 + 登录租约规避（见 §6 第 6 条）。
- **账号供给（2026-09-30 补记）**：账号由**引导路径自助注册**——`bootstrapPlatformAccount()` 在登录前调一次上游注册端点（`POST /api/passport/web/email/register/v2/`，邮箱已存在按成功处理，故顺次重复执行幂等），部署方只需注入 `WORKFLOW_V2_PLATFORM_ACCOUNT_EMAIL` / `WORKFLOW_V2_PLATFORM_ACCOUNT_PASSWORD`，**不必先人工建号**。注册**只**发生在「台账无行、需要现场确定账号身份」的引导路径，常规登录失败路径（`login()` / `ensureCookie()` / 鉴权失败重登）不触达——否则 env 邮箱写错会凭空造号。边界：账号必须按**保留账号**管理（任何人用同一邮箱在上游 UI 登录都会覆盖 `user.session_key` 并踢掉我方会话）；上游注册白名单存在缺陷（读错 env 变量），**不可依赖**。详见[平台账号供给设计](../design/2026-09-29-workflow-v2-account-provisioning.md)。

## 4. 归属真相源（本设计的核心安全约束）

上游不提供 workflow 级归属判定，跨租户隔离**必须**由 workflow-v2 承担：

1. `checkUserSpace` 只证明「平台账号属于该 space」，**不校验 workflow ↔ App 归属**，也不表达我方用户。
2. `workflow_list` 的 `project_id` 是硬过滤，但列表项**不回显归属**——出问题后也无法从上游反查。
3. 因此 `workflow_v2_workflow`（本地注册表）是归属的唯一真相源：所有带 `workflow_id` 的请求**先在注册表校验「存在 + 属于当前组织 + 当前用户有权」，未命中一律 404**（不泄漏资源存在性），再转发上游。
4. 客户端自报的 `space_id`、`project_id`、`bot_id`、`owner_id`、`login_user_create`、`creator`/`operator` 一律 strip；POST 只注入绑定的 `space_id` 与 `project_id`，GET 只补 `space_id`。本模块使用 App 上下文，`bot_id` 是与 `project_id` 互斥的 Agent 上下文，不得同时注入；`workflow_id` 只做归属校验、不改写。
5. 控制台不直连上游、不持有平台凭据；平台会话与租户映射不出现在浏览器侧。

## 5. 四条路径面

| 面 | 路径 | 鉴权 | 响应口径 |
|---|---|---|---|
| 控制台面 | `/web/workflow-v2/*` | 控制台会话 cookie（`web` 槽注入会话守卫） | 归一化为 `{ success, data }` / `{ success: false, error }` |
| 对外触发面 | `/api/workflow-v2/*` | 控制台 API Key（`rcs_*`，`api` 槽注入同一份会话守卫） | 域形状（成功） / `{ error: { code, message } }`（失败） |
| 画布透传面 | `/workflow-canvas/bff/*` | 请求头 `X-Fenix-Workflow-Ticket` | **上游原生 `{ data, code, msg }`**（含 HTTP status，原样回传） |
| 静态反代 | `/workflow-canvas/*`（`/workflow-canvas/storage/*` 映射存储域） | 无（同源） | 上游字节流 |

透传面只开放三条上游前缀，其余一律 404：`/api/workflow_api/`、`/api/common/upload/`、`/api/playground_api/get_imagex_url`（后两条来自阶段 0 实测，见设计 §9.1.1 第 5 条）。

控制台侧的上游读取一律走控制台面（`callUpstream`），**不开第二条透传路径**：列表行操作「日志」的发布记录与
上游当前发布版本由 `GET /web/workflow-v2/workflows/:id/publish-records` 转发应用级
`intelligence_api/publish/publish_record_list` 与 `canvas` 的 `data.workflow_version`。**平台不提供发布入口**
（2026-10-10 撤除：列表卡片菜单的「发布」与控制台面 `POST /workflows/:id/publish` 一并删除，发布动作在上游侧
完成——画布内按钮 / 上游控制台）：控制台只**读**上游发布状态（卡片状态列与版本号）与历史发布记录，画布宿主页
也不自带发布入口。页面级的**运行日志**由
`GET /web/workflow-v2/run-records` 转发 `list_spans`（`workflowId` 可选筛选；缺省时对组织内前若干个工作流有限
扇出后合并，查询窗口固定最近 7 天），同样只在读时转发、平台侧不落运行记录；入口在列表页页头而不是卡片菜单里。

工程口径：

- **三种响应口径在路由层分界，不得混用**：控制台面 `{success,data}`、对外触发面 `{executeId,…}` / `{error:{code,message}}`、画布面上游信封；画布 SDK 按上游信封解析，而上游信封本身**并不统一**——`list_spans` 是顶层扁平信封 `{code,msg,spans}`（无 `data` 包装，2026-10-09 上游 `3a028cf1` 起；此前是桩实现），`sign_image_url` 的 `url` 在顶层而非 `data` 内，`update_meta`/`cancel` 没有 `data`——任何「统一包一层」都会打断它（冻结 §6）。
- **限流在服务层判定、路由层落头**：画布透传按票据 `sub` 计数（`WORKFLOW_V2_BFF_RATE_LIMIT_PER_MINUTE`，默认 1200），免票的 `session/exchange` 与无有效票据的 `refresh`/`revoke` 按来源地址计数（`WORKFLOW_V2_SESSION_RATE_LIMIT_PER_MINUTE`，默认 60）；超限是**真实 HTTP 429 + `Retry-After`**。按 `sub` 而非来源地址是因为反代之后全站往往共用同一个入口 IP，按来源限流会把「一个用户在刷」放大成「同源用户一起被拒」。桶住在进程内，多副本下实际阈值 ≈ 配置值 × 副本数，全局阈值归部署层。
- 路由声明序：`bff` 必须先于静态反代——后者是通配路由，顺序错会吞掉透传请求。
- 静态反代**出站**注入平台账号 `session_key`：上游除静态白名单外全站经 session 中间件，`/workflow-canvas/*` 不带 cookie 时连 JS 资源都 401。**入站**剥离上游 `Set-Cookie` 并注入 `frame-ancestors`；两个方向不可混为一谈。
- 两处例外改写（均属「无法只靠透传解决」，须在代码内注明移除条件）：上游 panic 响应（`code 777777775`，`msg` 含 Go 堆栈与内部路径）替换为固定文案；图片/附件直链是存储服务内网地址，按已知 origin 前缀改写为 `/workflow-canvas/storage/*`，不做泛化重写。
- 节点范围裁剪的权威在服务端：`node-scope.ts` 对 `node_type` / `node_template_list` / `node_panel_search` 按 **fail-closed 许可集**（节点类型为数字字符串）过滤，客户端无法绕过。

### 5.1 对外触发面（`POST /api/workflow-v2/workflows/:id/run`）

外部系统按控制台的工作流主键触发**已发布版本**的运行，平台只做鉴权、归属校验与转发（不做业务处理、不解释入参语义）。

- **身份与归属**：调用方用控制台 API Key（`rcs_*`，Bearer），与面板会话共用宿主的同一份守卫实例（`slot: "api"` 的贡献注入 `authGuardPlugin`）；`:id` 是**本地主键**（UUID，非 UUID 在边界即 422），归属用 `findWorkflowById(orgId, id)` 判定，跨组织与不存在同形 404（不泄漏存在性）。上游的 `checkUserSpace` 只证明「PAT 所属用户属于该 space」，**不构成租户隔离**（ADR §4），隔离完全由本地注册表兜住。
- **请求体**：`parameters`（JSON 对象或它的 JSON 字符串）、`isAsync`（默认 false）、`ext.user_id`（受控透传，作为上游运行时用户）。`parameters` 在本地先判一次（必须是 JSON 对象），必然失败的请求不打到上游。
- **响应**：成功归一化为 `{ executeId, data, token, cost, debugUrl }`（字段缺失为 null，不省略键；`data` 是上游原样的 JSON 字符串），**不**原样回传上游信封；失败 `{ error: { code, message } }`。上游业务码 `6031`（未发布）→ 409 `WORKFLOW_NOT_PUBLISHED`，`4000`（参数不合法）→ 422 `INVALID_PARAMETERS`，其余非 0（含 panic `777777775`）→ 502 `UPSTREAM_REJECTED`（上游 `msg` 绝不进响应）；传输与会话失败沿用控制面同一张表（504 / 502 / 503），熔断打开同样 503。
- **上游凭据是 PAT，不是会话**：`/v1/*` 只接受 `Authorization: Bearer pat_*`（会话 cookie 被 OpenAPI 中间件拒绝）。PAT 由平台账号会话换取（`POST /api/permission_api/pat/create_personal_access_token_and_permission`，`duration_day` 是**字符串天数**，取 30 天，不用 `permanent`），权威副本与登录态一样放共享存储（Redis）并以跨副本租约收口换取，进程内 5s 缓存；剩余不足 1/3 主动重建，重建成功后**尽力吊销**被替换的旧令牌（失败只告警——不让一次清理失败把可用的新令牌判死）；上游判定失效（HTTP 401 或业务码 `700012006`）时 `invalidate()` + 单飞重建 + **重放一次**。PAT 与 `session_key` 同等对待：不落库、不进日志/响应/错误文案。
- **限流与审计**：按**调用方身份**（API Key 恢复出的用户）计数，阈值 `WORKFLOW_V2_API_RATE_LIMIT_PER_MINUTE`（默认 60，外部重试会产生真实运行，故收紧）；超限是真实 429 + `Retry-After`。真正打到上游的请求落 `workflow.run.external` 审计（组织、调用者、上游 workflow ID、结果与错误码；**不记入参与输出原文**），前置校验失败与限流拒绝只留日志。
- **前端入口**：列表卡片「更多 → 调用接口」打开弹窗，展示地址（`window.location.origin` + 本地主键）、认证方式、curl 示例（同步/异步）与参数说明；纯静态内容，不取数，复制反馈覆盖成功与失败。

**验证状态（2026-10-09）**：本部署的上游可达性已用**低风险探针**实测——平台账号登录、PAT 换取（`duration_day: "1"`）、`/v1/workflow/run` 的鉴权与信封形态（对不存在的工作流返回 `720702004`，`{code,msg,data,token,cost,debug_url,execute_id}` 结构完整；探针令牌已用 `delete_personal_access_token_and_permission` 清理）。**成功路径（真实运行一次已发布工作流）未实测**：本机台账里 `published_version` 为 null 的工作流在上游实际已发布 `v0.0.1`（画布内发布不回写本地，见 §7），因此「未发布」当时无法由本地列推断；现在发布状态改读上游（`workflow_detail_info`）后可按接口直接确认，探针据此在确认发布状态后主动停止，避免触发真实运行与成本。上线前建议按「选一个已发布且无 LLM 节点的工作流 → `isAsync: true` 调本接口 → 核对 `executeId` 与上游运行历史」验证一次。

## 6. 票据链路

1. 宿主（控制台）以会话 cookie 调 `POST /web/workflow-v2/iframe-code` 取**一次性 code**（60s，绑定 user + org + workflow）。
2. code 经 `postMessage` 下发，**不进 URL**（URL 会进 referrer、历史与代理日志）；兑换 `POST /workflow-canvas/bff/session/exchange` 得到 **HMAC 票据**（payload 含 `sid/sub/org/wf/iat/exp/jti`，TTL 15 分钟）。
3. 画布所有透传请求携带 `X-Fenix-Workflow-Ticket`；票据只存内存，不入 cookie/storage/URL，日志只记 `sid`/`jti` 前缀。
4. 续期与撤销：`session/refresh`（不超过原过期时间）、`session/revoke`（登出/切组织）——两者都要求票据头，因此**票据持有方决定续期与撤销能力**。宿主页据此走 `token` 路径（票据在宿主内存，两条链路都在宿主侧闭环）；`bind` 是画布侧保留的兼容路径，用它则撤销不可达（冻结 §7）。
5. 换票触发口径：画布只在 `error.response.status === 401` 时发 `refresh-request`，因此 BFF 的票据失败**必须是真实 HTTP 401**；`HTTP 200 + {code:401}` 会走业务错误分支、永不换票。同理**限流必须是真实 429**（带 `Retry-After`）而不得用 401 表达：429 落进画布的普通失败分支正是我们要的，被当成票据失效只会让它去换一张同样被限的票（冻结 §6）。
6. 多副本会话：权威副本在共享存储（Redis），进程内 5s 缓存；登录走 `SET NX PX` 租约 + Lua 比删释放，抢不到租约的副本在等待窗口内等对方发布会话，等不到再抢一次、仍失败才如实回 `busy`；`loggedInAt` 作失效水位，避免「读得到、删不掉」时复活本进程刚判定失效的会话。Redis 不可用时降级为进程内单例并**节流告警**（不静默改变鉴权语义：降级只影响谁能复用登录态，票据与归属判定不经过它）。

## 7. 数据模型与一致性

四张表归本包 `db/schema.ts`（迁移 `drizzle/0030_workflow-v2-init.sql`；`drizzle/0031_workflow-v2-audit-action-index.sql` 为补偿标记的反查补索引）：

| 表 | 职责 | 关键约束 |
|---|---|---|
| `workflow_v2_platform_account` | 平台账号与个人空间台账（单行） | `unique(platform_user_id)`；**不存 `session_key`** |
| `workflow_v2_org_app` | 租户 ↔ App 映射 | `unique(organization_id)`、`unique(app_id)` |
| `workflow_v2_workflow` | 归属注册表（本模块的真相源） | `unique(upstream_workflow_id)`、`index(organization_id, deleted_at)`；含 `owner_user_id`、`visibility`、`sync_state`；`published_version` 为**遗留列**（发布版本改由上游提供，见下） |
| `workflow_v2_audit_log` | 审计流水（只追加） | `index(organization_id, created_at)`、`index(action, upstream_workflow_id)`（对账反查补偿标记用，迁移 0031）；不记 body 与凭据 |

一致性策略：

| 数据 | 真相源 | 同步策略 |
|---|---|---|
| workflow schema、版本、发布状态、运行记录 | 上游 | 透传读取；列表以上游分页结果为主；**发布记录不落本地**——控制台的「发布记录」经控制台面取上游**应用级**渠道记录 `intelligence_api/publish/publish_record_list`（工作流级 `list_publish_workflow` 是上游桩实现，不调用；见下文「发布记录」一条），记录为空是上游现状、不是平台丢数据，弹窗空态按此写明；**当前发布版本**取 `workflow_detail_info` 的 `data[].latest_flow_version`（与 `canvas` 的 `workflow_version` 同源，见 `services/workflow-publish-state.ts` 的选型说明）：列表卡片状态与渠道自愈的版本自增都以它为唯一基准，读不到时状态列呈现「未知」、自愈不发布 |
| 归属（org/app/owner）、本地可见性、审计 | 本地 | 创建走「先上游后本地 + 失败补偿删除」；本地缺失时按需补写 |
| 删除 | 双方 | 本地软删 + 调上游删除；上游删除失败置 `sync_state = pending_delete`，由对账任务重试 |

列表卡片状态列的三态判定（2026-10-09 真机反馈后收敛）：`published` / `unpublished` 由上游条目决定，`unknown` 只出现在两处、且都能从日志排查——① 上游读取失败（warn 日志「列表发布状态读取失败 / 被上游拒绝」，带 stage 与上游码）；② 绑定不可用（warn 日志「租户绑定不可用」，带 `reason`）。**不许**把「读不到」渲染成「未发布」。绑定解析与创建/删除、运行日志、发布记录**同一口径**（`resolveBinding`）：台账缺行 + 绑定行还在时按需引导自愈；早前列表直接用原始仓储读、缺行即静默降级为未知，于是出现「卡片状态未知、同一时刻发布日志却读到 v0.0.4」的两个真相（已修，回归用例见 `workflow-publish-state.test.ts` 的按需引导自愈一组）。

`sync_state` 因此是**补偿状态机**而非业务状态：`active` / `pending_delete` 两值，`pending_delete` 表示「本地已不可见、上游对象可能仍在」，只能由对账任务收敛（4A 已落地：上游确认后硬删本地行并写 `workflow.delete.upstream` / `reconciled` 审计，双闸预算与退避见 §8）。发布版本**不再持久化到本地**：上游 `workflow_version` 必须严格自增，递增基准改为读上游当前版本（`workflow_detail_info` 的 `latest_flow_version`）——本地 `published_version` 只在控制台发布成功时回写，画布内发布不经过平台，按它自增会被上游以「版本号非自增」拒绝（2026-10-09 实测：上游 `v0.0.4`、本地 `v0.0.1`）。该列已无读写方，待单独排期迁移删除。

## 8. 现状（2026-09-29）

**已落盘（工作区，未提交）**：包骨架与模块清单（三条路由贡献 `web-control` / `canvas-bff` / `canvas-static` + 十二枚 `envDefinitions`）；`db/schema.ts` 与迁移 0030；服务层（上游会话、一次性 code 与票据、本地注册表、租户 App 绑定、节点白名单、透传、静态反代、审计、发布与熔断）；控制台界面（列表页、画布宿主页、握手与降级视图）；包内测试；宿主侧配置投影（`apps/server` 的 `module-configs.ts` 已含 `workflow-v2` 块）；**装配面启用与控制台接线（2F，2026-09-29）**——`deploy/assembly/ce.json` 的 `resources` 加入 `workflow-v2`、`web` 列表改由本包贡献（id 沿用 `workflow`），`apps/web` 的路由、i18n、依赖与生成物一并指向本包，旧 `packages/resources/workflow/web/**` 与宿主 `/agent/workflow/$id/versions` 已删除（删除台账见该包 `README.md` 末条）；**门禁（2G，2026-09-29）**——`bun run precheck` 16 步全绿（server/script 916、package 8812、web-app 259 用例全过）与 `bun run build:web` 均通过，连带重生成 `deploy/manifests/**` 并同步 `frontend-development.md` 里随旧前端失效的引用（SSE 例外点、file-events 域模块落点）；**对账与多副本加固（4A/4B，2026-09-29）**——周期对账任务（`pending_delete` 硬删重试 + `reconciled` 审计、孤儿补写、创建补偿收敛）随模块装配启动、经 `registerCleanup` 停止且**无手工触发端点**，单行重试退避 30s × 2ⁿ、封顶 30min；上游会话改由共享存储（Redis）承载，不可用时降级进程内并节流告警；画布透传与票据端点加进程内令牌桶限流，超限返回真实 429 + `Retry-After`；**平台账号自助注册（2026-09-30，`54831be59`）**——引导层在登录前调一次上游注册端点（邮箱已存在按成功处理），部署方不再需要人工建号；注册只在台账无行的引导路径发生，`login()` / `ensureCookie()` / 鉴权失败重登分支均不触达（env 邮箱写错不会凭空造号），上游关注册时仍照常尝试登录以兼容「人工建号 + 关注册」的既有部署；本轮**未新增 env**，仅更新两枚账号 env 的描述文案与三份生成样例（详见[平台账号供给设计](../design/2026-09-29-workflow-v2-account-provisioning.md)）。

**对外触发面（2026-10-09）**：新增第四条路由贡献 `workflow-v2.external-api`（`slot: "api"`）与一枚 env（`WORKFLOW_V2_API_RATE_LIMIT_PER_MINUTE`）；平台账号 PAT 的生命周期服务（换取、共享存储、单飞、主动轮换、失效重放、尽力吊销）与 `/v1/*` 上游出口 `callUpstreamOpenApi` 一并落地；列表卡片「更多 → 调用接口」弹窗提供接入信息。详见 §5.1。**未落地与已知边界**：
- **1J 已在本机真实跑通，但部署面仍需自证（2026-09-30 更新）**：1J（打开 → 编辑 → 保存、伪造 `space_id`/`project_id` 被覆盖、跨租户 404）三条判据已在本机以 `RCS_PORT=3100` 的独立实例真实执行完毕，**24 PASS / 0 FAIL、退出码 0**（上游 `http://127.0.0.1:18080`；控制台侧为新账号经 `POST /api/auth/sign-in/email` 登录；平台上游账号由引导路径**自助注册**，账号本身**不需要预先存在**，注入任意邮箱/密码即可）。**部署方仍需注入三枚 env**（`WORKFLOW_V2_PLATFORM_ACCOUNT_EMAIL` / `WORKFLOW_V2_PLATFORM_ACCOUNT_PASSWORD` / `WORKFLOW_V2_TICKET_SECRET`，缺失即启动失败），且本机结论只覆盖「单进程实例 + 单组织账号 + 本机上游」这一形态：本机 `.env` 未配 `RCS_REDIS_URL`（会话退回进程内单例），**多副本会话共享、反代与容器等部署形态下的行为仍未验证**。（画布可达的服务端前置——`GET /web/workflow-v2/platform-account` 的 `spaceId` 投影——已于 3E 落地：改读平台账号台账，未引导账号回 `null`、读库失败回 500，画布页据此区分 `space-missing` 与 `probe-failed`。）
- **对账已落地，但有三处边界**：① 孤儿扫描以「本地已绑定 App」为入口，`workflow_list` 的 `project_id` 是硬过滤，因此**只看得到挂在某个租户 App 下的对象**——平台账号直接建在个人空间、不属于任何 App 的对象不在扫描范围内（没有 `project_id` 就没有可反查的归属，补写只会是猜测）；移除条件：上游提供「按 space 列出全部对象并回显归属」的接口时，改为按 space 全量对账。② `workflow_list` 列表项的真实字段形态**只按契约快照实现、尚未用真实响应验证**：真实形态不同则扫描 fail-closed 成「跳过 + 告警」，不会误写归属。③ 待删重试的**次数**预算住在进程内（重启即重置），只有**年龄**预算（按 `deleted_at`）持久——重启后同一行最多再被重试 5 次，最终由年龄闸兜底收敛。
- **平台账号供给的三处边界（2026-09-30 补记）**：① 邮箱拼错仍会在**首次引导**按错邮箱建出账号（自助注册的固有代价；触发面已收窄到「台账无行」这一条路径，整条部署生命周期最多建错一次，但该邮箱会被占用，纠错需改 env 后重新引导 + 人工清理上游旧号；移除条件：上游支持按邮箱删号，或改回「人工建号 + 关注册」）。② 上游注册默认开放，建号窗口内「谁先注册谁拥有该邮箱」；生产建议建号后关闭注册（`DISABLE_USER_REGISTRATION=true`），但上游 `ALLOW_REGISTRATION_EMAIL` 白名单读错了 env 变量（开关一开白名单必失效），因此「只允许特定邮箱注册」这个中间档当前不可用。③ 账号必须登记为**保留账号**：`user.session_key` 按用户只存一个值、登录即覆盖，任何人在上游 UI 用同一邮箱登录都会踢掉我方会话（我方拿到 `700012006` 后重登，双边会互相顶键）。并发注册的败者撞上游唯一索引、以 HTTP 500 归为 `failed`，无功能故障（账号已由赢家建出，随后登录照常）。
- **限流是进程内的**：令牌桶住在各副本自己的进程里，多副本下实际阈值 ≈ 配置值 × 副本数。这是显式接受的取舍——不做分布式计数（每次请求一次 Redis 往返的代价与本模块流量规模不成比例）；需要全局阈值时应在反代层做，本模块不承担。
- **技术债：`src/server/services/canvas-passthrough.ts` 605 行**，超出「单文件 ≤ 500 行」指引（既有状况，4A/4B 本轮未拆）。影响范围：透传面是租户隔离的唯一权威，该文件同时住着「票据与归属校验、上游路径分类、panic 脱敏、节点白名单调用、`get_process` 轮询预算、三个会话端点、限流取值」；风险是安全关键逻辑继续在同一文件里增长，后续改动容易被无关段落淹没、review 难以聚焦。移除条件：把「调试运行的轮询预算（`get_process`）」与「会话端点（`handleSessionExchange` / `handleSessionRefresh` / `handleSessionRevoke`）」两段各拆成独立模块即可回到阈值内（两段合计约 150 行，拆出后约 455 行）。
- **运行日志：列表走 HTTP `list_spans`（上游 2026-10-09 已实现），平台侧补一段审计记录**。历史脉络与口径：
  - 该端点在上游曾是**桩实现**（只 bind 后返回空），平台当时的穷尽核对确认「无可列举的读出口」，因此曾短暂
    采用「只读直连上游库」的过渡方案（ADR `2026-10-09-workflow-v2-upstream-db-read.md`）。
  - 上游随后以 commit `3a028cf1` 补实现（仓储 `ListRootExecutions` 只取根执行 `parent_node_id IS NULL OR = ''`、
    支持时间窗/状态/模式/input 过滤、排序带 id 兜底、select 不含大字段；应用层做窗口默认值与 `limit` 钳制并组装
    tags；handler 返回扁平 `{code,msg,spans}`，非法参数 400）。**平台已按 ADR 的移除条件整体删除直连实现**
    （适配器、五枚 `WORKFLOW_V2_UPSTREAM_DB_*`、运维文档与相关测试），当前口径如下。
  - 请求：`workflow_id` 必填 → 一个工作流一次调用，「全部工作流」= 有限扇出（`RUN_LOG_WORKFLOW_LIMIT` = 10）
    后平台合并；窗口 `start_at = now − 7d`、`end_at = now`（毫秒，**服务端显式传**，不依赖上游默认值）、
    `limit = 20`、`desc_by_start_time = true`。
  - 响应与映射：`HTTP 200 + code === 0` 为成功（非 2xx 或 `code≠0` 是上游业务失败）；平台字段一半取自 span、
    一半取自 `tags`——`executeId` = `span.span_id`；`logId`/`version`/`errorCode` **只认 tags**（空串 → null；
    span 侧的 `log_id` 在上游为空时会拿 span id 兜底，那不是真实日志 ID）；`mode` = tags.mode（1 试运行 /
    2 发布运行 / 3 节点调试）；`status` = tags.status（上游 `WorkflowExeStatus` 原值：**1 运行中 / 2 成功 /
    3 失败 / 4 取消 / 5 中断**）；`durationMs`/`createdAt` 取 tags（回退 span 的 `duration`/`start_time`）；
    `nodeCount` 取 tags；`workflowId`/`workflowName` 是查询主体。`span.status_code` 只有「成功 0 / 其余 1」两档，
    精度不如 tags，**不消费**。
  - 失败语义：任一目标失败即整批失败（走 `workflow-http.ts` 的统一映射 502/503/504）；上游为空是合法空态。
  - 分页与「还有更早的运行」：上游没有 `has_more`/游标，平台按**页满**推断——扇出后**任一**目标本次返回
    `spans.length === limit`（20）即置 `hasMoreUpstream = true`，界面在 `truncated_hint` 旁提示「可能还有更早的
    运行」（文案只说「可能」）。它与 `truncated`（平台侧 50 条上屏裁剪）**相互独立、可同时为真**；已知假阳性：
    某工作流在窗口内**恰好** 20 条时也会置真（上游不区分「正好装满」与「被裁掉」）。
  - 平台侧那一段（`platformRuns`）来自本地审计（`workflow.run.external`），回答「平台触发过几次、结果如何」；
    与上游清单分开展示，画布内的试运行不在其中（不伪造）。
- **发布记录：读出口从「上游工作流级桩实现」换成「上游应用级真实记录 + 平台侧动作」（2026-10-09）**。上游的 `workflow_api/list_publish_workflow` 与 `released_workflows` 在该构建都是桩实现（实测带真实 workflow 仍回 `data:null`），且上游前端**从不调用**前者；上游控制台真正在用的是**应用级** `intelligence_api/publish/publish_record_list`（`studio/workspace/project-publish/src/hooks/use-publish-status.tsx:150`）。因此 `GET /web/workflow-v2/workflows/:id/publish-records` 改为：当前发布版本（canvas，不变）+ 应用级渠道发布记录（版本号 / 渠道结果 / 打包失败明细，**不显示**该构建恒为 0 的记录级 `publish_status`，也不显示上游没有的时间与操作人）+ **平台侧发布动作**（本地审计 `workflow.publish`：时间 / 操作人展示名 / 结果 / 错误码）——最后一段是控制台发布动作的唯一可见处（上游只记录发布产物，不记录控制台动作）。
- **控制台发布入口整体撤除（2026-10-10）**：发布是旧有逻辑，动作在上游侧完成（画布内按钮 / 上游控制台），平台不再触发。撤除范围：列表卡片菜单的「发布」与 `publish.*` 文案、控制台面 `POST /web/workflow-v2/workflows/:id/publish` 及其服务端闭环（版本自增 + 上游 `publish` 调用 + 业务拒绝分类）、发布成功后的渠道主动同步（`syncApiChannelAfterPublish`）与该动作的审计常量。保留三样：① `workflow-publish-version.ts` 的版本号算术——对外触发链路的运行前自愈（`api-channel-release.ts`）仍需要「严格大于当前版本」的新版本号；② 发布记录读路径与 `workflow.publish` 审计常量的登记——「平台发布动作」段读历史行，不再产生新行；③ 列表卡片的上游发布状态展示（`publishState` / `publishedVersion`）。**代价与兜底**：发布后不再主动登记 API 渠道，发布后的第一次外部调用会先吃一次 `777777778`、再由运行前自愈登记并重试一次（功能可用，只是多一次失败回执）。
- **绑定门的两条读路径曾不一致，已于 2026-10-09 收敛**：列表页的门是 `GET /org-app` → `findOrgAppBinding`（只读 `workflow_v2_org_app`），而运行日志/发布记录/创建/删除的门是 `resolveBinding` → `findTenantBinding`（要求**平台账号台账行 + 绑定行都在**）。平台账号台账（`workflow_v2_platform_account`，全局单行）的唯一写入点是引导路径，该行一旦丢失（历史库清理、库重建、迁移演练），就会出现「列表页照常显示卡片、点运行日志却收到 409 `ORG_APP_NOT_BOUND` +『请先在列表页完成初始化』」——而列表页因为已绑定**根本没有那个按钮**，用户被指到一个不存在的入口。现改为：`resolveBinding` 在「绑定行在 + 台账缺行」时先跑一次有界按需引导（与 `GET /platform-account` 同一套 `ensurePlatformAccountWithinBudget`，单飞 + 预算 + 失败不抛），成功即恢复；仍失败则回 503 `PLATFORM_ACCOUNT_NOT_PROVISIONED`（用户修不了的状态不得再引导去初始化）。真正的未绑定（没有绑定行）保持立即 409 且零出站。
- **降级标记曾是无 `where` 的全表更新，已于 2026-10-09 收敛**：`platform-account-bootstrap.markPlatformAccountDegraded` 早先是一条不带 `where` 的 UPDATE，会把 `workflow_v2_platform_account` 的**所有行**（含其它部署/共享库里的真实行、以及测试用例自己的行）一并标成 `degraded`。台账按部署只应有一行，但存储层只保证 `platform_user_id` 唯一，改邮箱、换账号、多部署共库都会留下多行，因此必须按主键定位：现改为先读「读路径认定的那一行」（`findPlatformAccountRow`，与 `findTenantBinding` 同口径）再按 `id` 更新，台账本来没有行时不写任何东西（纯首次引导失败只记日志）。
- **上游仓侧**（外部仓库，工作区未提交）：`frontend/**` 的宿主桥与 axios 注入、rsbuild 资源前缀与路由 basename、画布注桩、头部裁剪与埋点静默已改（清单见[前端改造记录](../design/2026-09-29-workflow-v2-upstream-frontend-changes.md)）。

阶段划分与任务编号见 [任务清单](../design/2026-09-29-workflow-v2-task-list.md)。

## 9. 相关文档

- 设计：[Workflow V2：接入上游工作流引擎画布与工作流平台设计](../design/2026-09-29-workflow-v2-upstream-studio-bridge.md)
- 契约：[接口冻结](../design/2026-09-29-workflow-v2-interface-freeze.md)、[上游契约快照基线](../design/2026-09-29-workflow-v2-upstream-contract-snapshot.md)、[上游前端改造记录](../design/2026-09-29-workflow-v2-upstream-frontend-changes.md)
- 决策：[ADR: workflow-v2 以 iframe + BFF 票据接入上游工作流引擎](../adr/2026-09-29-workflow-v2-upstream-bridge.md)
- 相邻：[17-workflow](./17-workflow.md)（自研引擎）、[14-user-org](./14-user-org.md)（租户）、[03-auth](./03-auth.md)（控制台会话）

## 10. 命名边界：有意保留的上游契约

模块的内部标识（代码标识符、文件名、环境变量、数据库列、日志命名）与用户可见文案在 2026-09-30 的
「内部标识中性化」中统一改为中立词（`upstream*` / `platform*` /「工作流空间」「工作流应用」），不再出现
上游产品名。以下四类**有意保留**，不是清理遗漏：

1. **上游线协议**（改即断链）：三个透传前缀 `/api/workflow_api/`、`/api/common/upload/`、
   `/api/playground_api/get_imagex_url`；上游信封 `{code,msg,data}` 与其中的 `msg` / `message` 键；
   注入白名单字段名 `space_id` / `project_id` / `bot_id` / `owner_id` / `creator` / `operator` /
   `login_user_create`；上游自身的路由字面量（如 `/api/permission_api/coze_web_app/impersonate_coze_user`）。
2. **迁移与历史痕迹**：已发布的 drizzle 迁移文件（`drizzle/00*`）与其 snapshot 记录的是**当时**的列名，
   改写它们等于篡改已执行的历史；列改名只以新迁移 `0032_workflow-v2-rename-upstream-identifiers.sql`
   表达（`RENAME COLUMN`，保数据）。
3. **上游仓库路径与存储常量**：上游源码路径（`backend/api/router/coze/api.go`、
   `apps/coze-studio/**`、`frontend/apps/coze-studio/**`、`@coze-studio/app`）与对象存储桶
   `opencoze`（部署模板 `STORAGE_BUCKET` 的取值，直属上游 MinIO 路径 `/opencoze/...`）。
4. **上游产品自身的名称**：仅在「外部仓库位置/构建方式」这类必须指名道姓的排障与改造说明里出现。
