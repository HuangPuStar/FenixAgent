# workflow-v2 对外触发：API 渠道登记与租户应用载体

- **日期**：2026-10-09
- **状态**：✅ 已实现并端到端实测通过
- **关联**：`.peri/plans/workflow-v2-external-run-diagnosis.md`（根因诊断）、`docs/arch/25-workflow-v2.md`、ADR `2026-09-29-workflow-v2-upstream-bridge.md`（**追加决策 2** 修订其「租户 App（bot）」口径）

## 1. 问题与根因

对外触发接口 `POST /api/workflow-v2/workflows/:id/run` 此前对**任何**工作流都失败：

```
POST /api/workflow-v2/workflows/{id}/run → 502 {"error":{"code":"UPSTREAM_REJECTED"}}
```

上游 `POST /v1/workflow/run`（运行已发布版本）在执行前校验渠道登记表
（`backend/domain/workflow/service/executable_impl.go` → `checkApplicationWorkflowReleaseVersion`）：

```sql
SELECT * FROM connector_workflow_version
WHERE connector_id = 1024 AND workflow_id = ? AND version = ?   -- rows:0 → 拒绝
```

- `1024` = `consts.APIConnectorID`；`version` = `workflow_meta.latest_version`（上游 `wf.LatestPublishedVersion`，PAT 路径取它）。
- 缺失时上游回 `777777778 ErrWorkflowSpecifiedVersionNotFound`；该码不在上游 `errnoMap` 里，`msg` 只给通用的
  `Service Internal Error`，因此平台只能按「上游拒绝」回 502，调用方无从判断能否自己修。
- 该表的**唯一写入路径**是「把应用发布到渠道」：`ReleaseApplicationWorkflows` →
  `BatchCreateConnectorWorkflowVersion`（`service_impl.go:963`），HTTP 端点是
  `POST /api/intelligence_api/publish/publish_project`（`connector_ids` 由请求体的 `connectors` 携带）。

本次新增的第二个根因（诊断文档未涵盖，实测确认）：**平台的租户「App」是上游的 bot，而不是应用**。
`ReleaseApplicationWorkflows` 按 `app_draft`（应用）取 workflow，而 `PublishAPP` 先做
`ValidateDraftAPPAccess(appID)` → `GetDraftAPP` 只读 `app_draft`；bot id 在那里没有行，发布直接回
`101000002 record not found`。另外实测 bot 的渠道发布（`/api/draftbot/publish`，connector 1024）**成功但不写**
`connector_workflow_version`（发布前后该表行数不变）。结论：**只要 workflow 挂在 bot 下，对外触发就不可能可用**。

## 2. 上游协议事实（全部实测，2026-10-09，opencoze@127.0.0.1:18080）

| 事实 | 证据 |
| --- | --- |
| 应用发布端点 `POST /api/intelligence_api/publish/publish_project`，体 `{project_id, version_number, connectors:{"1024":{}}}` | 实测返回 `{data:{publish_record_id}}` |
| 发布成功（`app_release_record.publish_status = 5 PublishDone`）时写入 `connector_workflow_version` 一行 | 实测：v0.0.2 发布后表里多出 `(app, 1024, workflow, v0.0.2)` |
| **同版本重复发布不幂等**：`CheckAPPVersionExist` 命中即回 `101000002` | 实测第二次发布同版本 → `{"code":101000002}` |
| **渠道行只为「这次新建的 workflow 版本」写入**：`GetVersion` 命中即 `continue`，不进 `workflowIDs` | 实测：先 workflow 级发布 `v0.0.3`，再按 `v0.0.3` 发布应用 → `publish_status=5`，但 `connector_workflow_version` 里没有 v0.0.3（**静默空转**） |
| **应用内任一 workflow 校验不通过 → 整次发布作废**（`publish_status=1 PackFailed`，什么都不建） | 实测：应用下放一个空画布 workflow（`start not connected`）后发布 → `app_release_record.publish_status=1`，渠道表零新增；删掉它后应用列表恢复干净 |
| 渠道行没有读接口（`GetVersionListByConnectorAndWorkflowID` 无 HTTP 出口） | 全仓调用点核对：仅 domain 层内部方法 |
| bot 渠道发布不写渠道行 | 实测 `/api/draftbot/publish` 前后 `connector_workflow_version` 行数不变（0 → 0 新增） |
| 应用实体 `101000002` = 记录不存在；`intelligence_type=2` 是应用 | `search/get_draft_intelligence_info` 实测：存在的应用回 `data.basic_info`，bot id 回 `101000002` |
| 应用发布成功、workflow 版本已推进时才真正可用 | 实测：登记后 `/v1/workflow/run` 回 `200 + execute_id`，`/v1/workflow/get_run_history` 里 `execute_status=Success, connector_id=1024` |

## 3. 设计

### 3.1 时机：运行前兜底 + 进程内冷却（发布后同步已于 2026-10-10 撤除）

- **为什么不做「主动检查—必要时发布」**：上游没有读接口能回答「这个版本登记了吗」，主动检查在成功路径上既做不到、
  也无法验证，却要付出多次出站；而失败回执（`777777778`）本身就是最可靠的探测信号，成本为零。
- **运行前兜底**（`routes/api/workflows.ts`）：运行被拒且错误码为 `WORKFLOW_NOT_REGISTERED_TO_API_CHANNEL` 时，
  触发一次自愈；只有自愈返回 `released` 才重试运行，且**同一请求内只重试一次**。
- **发布后同步（2026-10-09 落地，2026-10-10 撤除）**：控制台发布入口曾于发布成功后调用
  `syncApiChannelAfterPublish`——同一实现、同一份单飞，只是**不受冷却窗口约束**（发布是用户显式动作且刚推进了
  版本）。控制台发布动作整体撤除后（发布回到上游侧完成），该函数与它的「忽略冷却」变体一并删除：本模块只保留
  运行前兜底这一条时机。
- **进程内冷却**：失败（含 `unverified`）后该 workflow 进入 30s 冷却，避免「上游持续拒绝」时每次调用都打一轮上游。
- **副作用（需知）**：上游的「发布到渠道」会为该应用生成一个新的 workflow 版本（内容取当前草稿），因此渠道登记
  （含运行前自愈）会让工作流的当前发布版本再前进一格——这是上游语义（一次应用发布 = 该应用全体 workflow 的一个
  新版本）。

### 3.2 服务：`src/server/services/api-channel-release.ts`

```
inspectApp(appId)                    // search/get_draft_intelligence_info，intelligence_type=2；101000002 → app_not_publishable
readAppWorkflowIds(appId, spaceId)   // workflow_api/workflow_list（分页，≤5 页）
readWorkflowVersions(...)            // workflow_api/workflow_detail_info（复用 workflow-publish-state 的批量读）
readAppPublishVersions(appId)        // intelligence_api/publish/publish_record_list
target = max(以上所有版本) + 1         // 复用 workflow-publish-version 的 nextPublishVersion（口径唯一）
publish_project(appId, target, connectors={"1024":{}})
verifyWorkflowVersion(target)        // 目标 workflow 的当前版本必须推进到 target，否则 unverified
```

**幂等与并发**：进程内按 **App** 单飞（一次发布覆盖该 App 下全部 workflow，键不能落在 workflow 上）；
跨副本靠上游的版本占用天然互斥（抢输的一方拿到 `101000002`，刷新记录后重算一次，有界 2 次尝试）。

**失败隔离**：函数**永不抛错**，一律返回结构化结果（`released` / `app_not_publishable` / `cooldown` /
`rejected` / `unavailable` / `unverified` / `version_unparseable`）；调用方只在 `released` 时重试运行，
其余情况保留原始 409，原始错误不被掩盖，只多一条日志。

**多租户**：只接受「路由已按组织谓词解析出来的」`upstreamWorkflowId` 与 `appId`（注册表列），请求体里的
`app_id` / `project_id` 一律不参与；发布使用平台账号会话，操作对象是租户自己的应用（上游 `ValidateDraftAPPAccess`
校验 owner）。

**预算**：总预算 15s（超出只影响本次返回值，在途发布不取消）；读接口 5s、发布接口 10s。

### 3.3 载体：租户 App 必须是上游「应用」（`services/app-carrier.ts` + `org-app-binding.ts`）

- 租户绑定改为创建上游**应用**（`draft_project/create`），workflow 的 `project_id` 由此指向应用，
  渠道发布链路才成立；探测用 `search/get_draft_intelligence_info`（`intelligence_type=2`），删除用
  `draft_project/delete`。
- **兼容旧载体**：应用接口不可用（HTTP 404，老构建）时退回 bot 载体，绑定与控制台照常可用，只有对外触发会
  明确报出缺少渠道登记。移除条件：固定镜像的上游构建确定提供应用接口后删除 `LEGACY_BOT_CARRIER` 分支。
- 载体差异（端点、请求体、id 字段、不存在码）集中在 `app-carrier.ts`，绑定生命周期（单飞、落库、降级）
  仍在 `org-app-binding.ts`。

### 3.4 错误码

| 上游码 | HTTP | 平台码 | 含义 / 调用方动作 |
| --- | --- | --- | --- |
| 6031 | 409 | `WORKFLOW_NOT_PUBLISHED` | 工作流还没发布，先发布 |
| 4000 | 422 | `INVALID_PARAMETERS` | 参数不合法，改参数 |
| **777777778** | **409** | **`WORKFLOW_NOT_REGISTERED_TO_API_CHANNEL`** | 当前发布版本未登记到 API 渠道；平台已尝试自动补登记，稍后重试 |
| 其他（含 panic 777777775） | 502 | `UPSTREAM_REJECTED` | 上游拒绝本次请求 |

## 4. 存量迁移（本地 dev 数据已执行，生产需按 runbook 逐组织执行）

现有工作流挂在 bot 载体下，**无法在运行时被「收养」到应用里**（上游 `project_id` 只在创建/复制时写入，
没有 HTTP 移动接口），因此存量迁移是一次性运维动作：

1. 让组织的绑定指向新的上游应用（重建绑定：删除本地绑定行 → 控制台 `POST /web/workflow-v2/org-app`
   走新代码路径建应用并绑定；或管理员 `POST /web/workflow-v2/org-app/rebind` 指向已存在的应用）。
2. 在应用下重建 workflow 并搬运画布：`workflow_api/create`（`project_id` = 应用）→ `workflow_api/save`
   （画布 schema）。
3. 把本地注册表的 `upstream_workflow_id` 与 `app_id` 指到新对象（本次为 dev 数据直接 UPDATE，生产应走脚本 +
   审计）。
4. 旧 bot 载体下的 workflow 可以保留（对账按绑定应用扫描，不会误删也不会误补写）。

## 5. 验证

- 单测：`src/__tests__/workflow-api-channel-release.test.ts`（版本推导、发布与校验、空转识别、非应用实体、
  版本占用重试、并发单飞、冷却、传输失败）、`workflow-external-api.test.ts`（错误码映射、自愈后重试一次、
  自愈未完成不重试、自愈对象取自注册表而非请求体）。
- 端到端（实测，见任务报告；控制台发布已于 2026-10-10 撤除，此处记录当时的闭环，自愈路径本身不变）：控制台发布 `v0.0.1` → 首次外部触发 `777777778` → 自愈发布应用 `v0.0.2`
  → 重试 `200 + executeId` → 上游 `/v1/workflow/get_run_history` 回 `execute_status=Success, connector_id=1024`；
  第二次触发直接 `200`，不再产生发布记录。

## 6. 存量载体（旧环境 bot 绑定）的实际行为与迁移

- **对外触发**：`POST /api/workflow-v2/workflows/:id/run` → 409 `WORKFLOW_NOT_REGISTERED_TO_API_CHANNEL`。
  平台会尝试补登记，但承载对象是 bot（`search/get_draft_intelligence_info` 回 `101000002`）⇒ 判定为
  **永久性**缺失、不重试，文案为「…且平台无法自动补登记；请联系平台管理员处理」（不含「稍后重试」暗示）。
  用户**不能自行修复**：需要把该组织迁到应用载体（见 §4），或由平台后续提供一键迁移。
- **控制台其它功能照常可用**：绑定探测（bot 探测分支）、列表与发布状态（读上游当前版本）、画布（iframe + 透传，
  发布按钮在上游侧）、运行日志（原文写「上游 `list_spans` 恒空是既有事实」——**该结论随上游 `3a028cf1`（2026-10-09）失效**，`list_spans` 已实现且平台同日切回 HTTP，读路径见 `docs/arch/25-workflow-v2.md` §8）都不依赖载体类型；只有「渠道登记」这一步
  在旧载体下无解。
- **迁移要点与风险**：见 §4；可脚本化（建应用 → 建 workflow 并搬运画布 → 改本地注册表的
  `upstream_workflow_id`/`app_id` → 删旧对象），风险点是「上游没有 HTTP 移动接口，workflow 身份（上游 id）必然
  变化」，因此必须同步改写本地注册表并确认没有外部系统把上游 id 写死。

## 7. 已知边界与后续

- **运行日志仍恒空**：上游 `list_spans` 是桩实现（既有事实，不在本任务范围）。**2026-10-09 更正**：该结论随上游 `3a028cf1`（2026-10-09）失效——`list_spans` 已实现，平台同日切回 HTTP，读路径见 `docs/arch/25-workflow-v2.md` §8；本节其余条目不受影响。
- **`publish_records` 列表的状态列**：上游发布记录里的 `publish_status` 在「空转」场景仍是 5，不能单独作为
  「已登记」的证据；本模块以「目标 workflow 的当前版本是否推进」作为校验口径，`unverified` 时再读一次发布记录
  的状态进日志（`1` = PackFailed ⇒ 应用内有 workflow 校验不通过；`5` = 版本已存在被跳过）。
- **应用级共命运**：一次应用发布覆盖该应用下全部 workflow，任一 workflow 校验不通过会阻断整次发布；运营上应避免
  在租户应用里留下校验不通过的 workflow（本次实测的探测对象已清理）。
- **多副本**：单飞与冷却都是进程内的；跨副本靠上游版本占用收敛（有界重试）。若后续需要全局收敛，应把
  「已登记版本」的短期状态放进共享存储（当前无此需求：一次成功自愈后该版本不再需要自愈）。
- **发布后同步（已撤除）**：该接线于 2026-10-09 落地、又随控制台发布入口于 2026-10-10 整体删除（见 §3.1）；本模块现只保留运行前兜底。代价是发布后的第一次外部调用会先吃一次 `777777778` 再由自愈补救，功能不受影响。
- **会话单点**：平台账号在上游是单会话（重登踢旧键）。同时运行多个服务实例时，各自都会登录并互相踢键，
  表现为间歇 503（`PLATFORM_SESSION_UNAVAILABLE`）。本机验证需避免同时跑两个实例。
