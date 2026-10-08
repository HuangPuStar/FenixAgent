# Workflow V2：上游契约快照基线（阶段 0）

> 采集日期：2026-09-29 · 性质：**回归基线**（上游升级后重跑本探针并与本表逐行比对）
> 设计依据：[2026-09-29-workflow-v2-upstream-studio-bridge.md](./2026-09-29-workflow-v2-upstream-studio-bridge.md) §4.2、[2026-09-29-workflow-v2-interface-freeze.md](./2026-09-29-workflow-v2-interface-freeze.md) §6
> 采集工具：`scripts/workflow-v2/upstream-contract-probe.ts`（采集基建 `lib/probe-core.ts`，接口套件 `lib/probe-bootstrap.ts` / `lib/probe-workflow.ts` / `lib/probe-auxiliary.ts`）
> 原始结构化结果：`bun run scripts/workflow-v2/upstream-contract-probe.ts --json --out <path>`（建议与本文档同批归档）

## 1. 本次采集环境

| 项 | 值 |
|---|---|
| 上游仓库 | `/Users/konghayao/code/ai/workflow-studio` @ `fefb05ff27be1da939612fbf9faf5db62583b8ae`（`git log -1 --format='%ci'` → `2026-07-29 03:17:51 +0000`，`fix(infra): align statefulset servicename with actual service name (#2723)`） |
| 上游工作区 | **非干净**：`docker/docker-compose-debug.yml`、`frontend/packages/arch/bot-http/src/axios.ts` 已改，`frontend/packages/arch/bot-http/{src/host-bridge.ts,__tests__/axios-embedded.test.ts,__tests__/host-bridge.test.ts}` 未跟踪 —— 快照对应「HEAD + 上述改动」，比对时需先确认这些改动的去向 |
| 基址 | `http://127.0.0.1:18080`（Hertz，自带前端静态资源） |
| 中间件 | docker 中运行：mysql / redis / es / minio / etcd / nsq / milvus |
| 探针账号 | `fenix-probe-03@example.com`（本批次注册；密码不记录于仓库，只经环境变量传入，见 §4.1） |
| 探针资源 | 空间 `7690905315826466816`（注册自动创建的个人空间）、App `7690910442985619456`、workflow `7690910443052728320`（台账 `$TMPDIR/fenix-workflow-v2-probe-state.json`，脚本默认路径） |
| 采集时间 | 全量（含 create 链路）`2026-09-29T11:00:28.692Z` → `2026-09-29T11:00:28.955Z`；复用台账复跑 `2026-09-29T11:00:54.232Z` → `2026-09-29T11:00:54.866Z`（UTC，脚本 `meta.startedAt/finishedAt`） |
| 探针结果 | 全量 42 项：成功 40、失败 2、跳过 0；复用台账复跑 42 项：成功 39、失败 2、跳过 1（跳过项＝复用已建的探针 workflow，未重复 `create`）。两次失败项相同，见 §2 第 12、19 行 |
| 原始结果 | `/tmp/upstream-contract-snapshot.final.json`（全量，本表依据）、`/tmp/upstream-contract-snapshot.verify.json`（复用复跑）；由 `--json --out` 产出，未归档进仓库，重跑请自带 `--out` 路径 |

> 空间内另有三个早期探针 App（`7690907149618118656`、`7690908987364999168`、`7690909570184511488`）及各自的探针 workflow，随台账更换被弃用；上游没有「按空间列 App」接口，无法在 UI 外清理，属可忽略的探针残留。

> 采集时间是命令实际输出，不是人工填写；重复运行会得到新的时间戳与**新的资源 ID**，本表的 ID 只用于定位「同一次采集」。

## 2. 契约快照

「请求最小必填字段」= 本探针实测能拿到成功响应（或该接口的稳定样本）的最小集合；上游对缺必填一律返回 `code=400` 结构的错误或 `777777775`，**不接受**猜测的字段名。

| # | 接口 | 方法 + 路径 | 请求最小必填字段 | 成功响应关键字段 | 失败码样本 | 备注 |
|---|---|---|---|---|---|---|
| 1 | 平台账号登录 | `POST /api/passport/web/email/login/` | `email`,`password` | `data.user_id_str`,`data.email`,`data.name` | — | `session_key` **只在 `Set-Cookie`**；`domain` 带端口（非法），cookie jar 拒收，须手工解析后用 `Cookie: session_key=…` 回传 |
| 2 | 平台账号注册 | `POST /api/passport/web/email/register/v2/` | `email`,`password` | 同登录（`data.user_id_str`） | — | 注册自动创建个人空间；**登录不会自动注册**（邮箱不存在 → `700000003`，与密码错误同码）。**接入口径（2026-09-30 校准）**：我方在**登录之前**的引导路径上先调注册（幂等），不是「登录失败后回退」——本行原文的后半句写于采集当日、与实现不符，已按实现改正，详见[平台账号供给设计](./2026-09-29-workflow-v2-account-provisioning.md) |
| 3 | 空间列表 | `POST /api/playground_api/space/list` | `{}` | `data.bot_space_list[].id`,`data.has_personal_space` | — | 个人空间的 `app_ids` 恒为 `null`，**拿不到「空间下的 App 列表」**（见 F9） |
| 4 | App 详情 | `POST /api/playground_api/draftbot/get_draft_bot_info` | `bot_id` | `data.bot_info.bot_id/name/description/icon_uri`,`data.space_id` | `100000000`：`invalid parameter : agent <id> not found` | 唯一能按 id 校验租户 App 是否存活的入口 |
| 5 | 建 App（租户载体） | `POST /api/draftbot/create` | `space_id`,`name`,`description`,`icon_uri` | `data.bot_id`,`data.check_not_pass` | — | `icon_uri` 必填，用 `default_icon/default_app_icon.png` |
| 6 | 新建 workflow | `POST /api/workflow_api/create` | `name`,`desc`,`icon_uri`,`space_id` | `data.workflow_id` | — | 挂到租户 App 下需**额外传 `project_id`**；`data.name`/`data.url` 在新建响应里为空串、`data.status` 为 `0`，真实值必须走 canvas |
| 7 | 拉画布 | `POST /api/workflow_api/canvas` | `workflow_id`,`space_id` | `data.workflow.schema_json`（JSON 字符串，含 `nodes`/`edges`/`versions`）、`data.workflow_version`、`data.workflow.project_id` | — | 画布、保存、调试都从这里的 `schema_json` 出发；新建后立即 canvas 拿到的默认 schema **有缺陷**（见 F2） |
| 8 | 保存草稿 | `POST /api/workflow_api/save` | `workflow_id`,`space_id`,`submit_commit_id`（可为空串）+ `schema` | `data.name/url/status/workflow_status` | HTTP 400 `code=400`：`'submit_commit_id' field is a 'required' parameter…`；缺 `schema` → `720701011 data serialization/deserialization fail, please contact support team`（草稿保持不变） | `submit_commit_id` 无输入时传 `""` 即可；两个字段都不可省 |
| 9 | 重命名 / 改描述 / 改图标 | `POST /api/workflow_api/update_meta` | `workflow_id`,`space_id` | `code=0`（**无 `data`**） | — | 只返回 `{code,msg,BaseResp}`，调用方不得依赖回显 |
| 10 | workflow 列表 | `POST /api/workflow_api/workflow_list` | `space_id`（+`project_id`,`page`,`size`） | `data.workflow_list[]`,`data.auth_list`,`data.total` | `777777775`：`space id is required`（缺 `space_id`） | **不传 `project_id` 时 App 内 workflow 完全不可见**，且列表项**不回显 `project_id`**（见 F1） |
| 11 | 按 id 查 workflow | 同 `workflow_list` | `space_id`,`project_id`,`workflow_ids`,`page`,`size` | 同上 | `777777775`：`the number of page or size must be greater than 0…`（缺 `page`/`size`） | 归属校验（`findWorkflowByUpstreamId`）唯一可用形态；缺 `project_id` 不报错但返回空列表 |
| 12 | 版本历史 | `POST /api/workflow_api/history_schema` | `space_id`,`workflow_id`,`type` | （未取得成功样本） | `777777775`：`panic error: strconv.ParseInt: parsing "": invalid syntax` + Go 堆栈 | `type` 取 `0`/`1` 均 panic，缺有效 `commit_id` 时不可用（见 §5.2） |
| 13 | 画布校验 | `POST /api/workflow_api/validate_tree` | `workflow_id`,`space_id`,`schema`（thrift 里 `bind_project_id`/`bind_bot_id` 非必填，实测不传亦成功） | `data[].errors[].message/type`、`data[].workflow_id` | `777777775`：`validate tree schema is required`（缺 `schema`） | 只传 `workflow_id/space_id` 必失败；校验结果本身是「错误清单」，可空 |
| 14 | 节点类型 | `POST /api/workflow_api/node_type` | `space_id`,`workflow_id` | `data.node_types[]`,`data.nodes_properties[]` | schema 无效时 HTTP 500 + **纯文本** `code=777777775 message=…`（非 JSON） | 依赖已保存 schema；v2 需按白名单过滤 |
| 15 | 调试运行 | `POST /api/workflow_api/test_run` | `workflow_id`,`space_id`,`input`（可为 `{}`） | `data.execute_id`,`data.workflow_id` | `720701013`：`invalid BlockInputReference …`（schema 无效时） | App 内 workflow 可不带执行上下文独立调试；带上下文时 `project_id`（App）与 `bot_id`（Agent）互斥，不能同时发送（2026-09-30 核对上游 `ApplicationService.TestRun`） |
| 16 | 运行过程轮询 | `GET /api/workflow_api/get_process` | query：`workflow_id`,`space_id`,`execute_id` | `data.executeStatus`,`data.nodeResults`,`data.tokenAndCost`,`data.logID` | 用 POST 调用 → HTTP 404 `not found` | **只挂 GET**；`execute_id` 可换 `log_id` |
| 17 | 节点执行历史 | `GET /api/workflow_api/get_node_execute_history` | query：`workflow_id`,`space_id`,`node_id`,`node_type` | `data.nodeStatus`,`data.input/output`,`data.raw_output`,`data.tokenAndCost` | HTTP 400 `'node_id' … required`／`'node_type' … required` | 单节点粒度，补 `get_process` 的 `nodeResults:null` |
| 18 | 取消运行 | `POST /api/workflow_api/cancel` | `execute_id`,`space_id` | `code=0`（**无 `data`**） | — | 对已结束的 `execute_id` 也返回 `code=0`，调用方不能据此判断「确实取消了」 |
| 19 | 中断恢复 | `POST /api/workflow_api/test_resume` | `workflow_id`,`execute_id`,`event_id`,`data` | （未取得成功样本） | `720701013`：`panic error: strconv.ParseInt: parsing "": invalid syntax` + Go 堆栈 | 需真实中断事件（问答/中断节点）；空 `event_id` 直接 panic（见 §5.2） |
| 20 | 发布版本 | `POST /api/workflow_api/publish` | `workflow_id`,`space_id`,`has_collaborator` + `workflow_version` | `data.publish_commit_id`,`data.success` | `777777775`：`the version number is not self-incrementing, old version vX, current version vX`／`'s current draft needs to pass the test run before publishing`；`777777769`：`workflow version name is invalid`；`720700801`：`database operation failed` | **`has_collaborator` 必填**（bool）；**当前草稿未通过 `test_run` 时一律拒绝**（见 F11）；不带 `workflow_version` 只在该 workflow 从未发布过时成功（见 F3） |
| 21 | 已发布列表 | `POST /api/workflow_api/released_workflows` | `space_id` | `data:null`（探针账号无发布产品） | — | 空态是 `data:null` 而非空数组，调用方需容错 |
| 22 | 发布记录 | `POST /api/workflow_api/list_publish_workflow` | `space_id`,`size` | `data:null` | HTTP 400：`'size' field is a 'required'…` | `size` 必填；同样以 `data:null` 表示空 |
| 23 | 复制 workflow | `POST /api/workflow_api/copy` | `workflow_id`,`space_id` | `data.workflow_id`,`data.schema_type` | — | 副本名为 `原名_<n>`（计数器，跨运行累加，实测 `_3`）；探针在同一轮内删掉副本，避免堆积 |
| 24 | 删除引用策略 | `POST /api/workflow_api/delete_strategy` | `workflow_id`,`space_id` | `data:number`（`0`=可删） | — | thrift `DeleteType`：`0 CanDelete` / `1 RejectProductDraft`（首发审核中）/ `2 UnListProduct`（需先下架） |
| 25 | workflow 详情 | `POST /api/workflow_api/workflow_detail` | `space_id`,`workflow_ids` | `data[].name/project_id/version/inputs/outputs/create_time` | — | 唯一能一次拿到 `project_id` 与 `version` 的批量入口（canvas 亦含 `project_id`） |
| 26 | 节点模板列表 | `POST /api/workflow_api/node_template_list` | `{}`（可选 `need_types`/`node_types`） | `data.template_list[]`,`data.cate_list[]` | — | 不传 `need_types` 返回全部模板；v2 需按白名单过滤 |
| 27 | 节点面板搜索 | `POST /api/workflow_api/node_panel_search` | `search_type`,`space_id`,`search_key`,`page_or_cursor`,`page_size`,`exclude_workflow_id` | `data:null`（`search_key` 为空时） | — | thrift 里六个字段均非 optional（缺省行为未逐项验证）；v2 需按白名单过滤 |
| 28 | 图片签名 | `POST /api/workflow_api/sign_image_url` | `uri` | 顶层 `url`（不在 `data` 内）+ `code`/`msg` | — | 返回带 `X-Amz-*` 查询串的 minio 预签名 URL；查询串是签名，禁止入库/入日志 |
| 29 | 运行 span 列表 | `POST /api/workflow_api/list_spans` | `start_at`,`end_at`（毫秒）,`workflow_id` | `{spans:[…]}`（**顶层是裸对象，无 `code`/`msg`/`data`**） | — | 未命中时为 `{"spans":null}`；时间戳单位是**毫秒**（核销 §9.1 第 5 条的时间戳部分） |
| 30 | 运行 trace 详情 | `POST /api/workflow_api/get_trace` | query：`workflow_id`,`execute_id`,`start_at`,`end_at`（POST 请求体可空） | `{}`（无数据时为 Go 零值对象） | 用 GET 调用 → HTTP 404 `not found` | **POST + query 混合**，最容易接错的一个接口 |
| 31 | 删除 workflow | `POST /api/workflow_api/delete` | `workflow_id`,`space_id` | `data.status`（`0`=成功） | — | 返回 `data.status` 而非 `code` 语义，需单独判定 |
| 32 | 批量删除 | `POST /api/workflow_api/batch_delete` | `workflow_id_list`,`space_id` | `data.status` | — | 探针只用它删本轮创建的一次性 workflow |

### 2.1 认证与失败形态样本（BFF 错误分支的依据）

| # | 场景 | 方法 + 路径 | 观测结果 | 备注 |
|---|---|---|---|---|
| A1 | 无 Cookie | `POST /api/workflow_api/canvas` | HTTP **401** + `{code:401,msg:"missing session_key in cookie"}` | 唯一走 HTTP 语义的失败分支 |
| A2 | 无效（伪造）`session_key` | 同上 | HTTP **200** + `{code:700012006,msg:"authentication failed: access denied"}` | 会话失效走**业务码**而非 HTTP |
| A3 | 过期/被踢的 `session_key` | 同上 | HTTP 200 + `{code:700012006,msg:"authentication failed: session not exist"}` | message 与 A2 不同，可用于区分「伪造」与「被踢」 |
| A4 | 重新登录后用旧会话 | 同上 | 同上（`session not exist`） | **重新登录会踢掉旧 `session_key`**（核销 §9.1 第 3 条，见 F4） |
| A5 | 缺必填（thrift 层） | `POST /api/workflow_api/save` | HTTP **400** + `{code:400,msg:"'x' field is a 'required' parameter…"}` | 字段名与类型来自 thrift，可读性好 |
| A6 | 业务层拒绝 | `POST /api/workflow_api/workflow_list` | HTTP 200 + `{code:777777775,msg:"…: space id is required"}` | `777777775` = Go 侧 panic/校验兜底，**不是**服务故障，但要当作可预期的错误分支 |
| A7 | 运行期错误 | `POST /api/workflow_api/test_run` | HTTP 200 + `{code:720701013,msg:"Workflow execution failure: …"}` | 运行域错误码段 `720xx` |
| A8 | 方法不对 | `POST /api/workflow_api/get_process` | HTTP **404** + `{code:404,msg:"not found"}` | 路由按 method 注册，错方法不是 405 |

### 2.2 成功信封的文案键不统一：`msg` 与 `message`（2026-09-30 补采）

**采集方式**：**绕过 workflow-v2 平台直连上游** —— 用平台账号 `POST /api/passport/web/email/login/` 取 `session_key` 后直接打 `/api/workflow_api/*`。因此下表是上游的**原生形状**，不含透传面的任何加工（透传面只做 panic 脱敏 / 节点白名单 / 图片直链改写，不重命名字段）。

**采集环境**：上游 `/Users/konghayao/code/ai/workflow-studio` @ `01aa6726`（`git log -1 --format=%h` → `01aa6726`，`2026-09-30 09:00:33 +0800`，`fix(infra): restore executable bit on build_fe.sh`）；工作区**非干净**（`docker/docker-compose-debug.yml`、`frontend/infra/plugins/pkg-root-webpack-plugin/lib/index.d.ts` 已改，均与 `workflow_api/*` 的响应形状无关）；基址 `http://127.0.0.1:18080`。

| 端点 | 请求最小必填字段 | 成功响应顶层键集合 | 文案键与取值 |
|---|---|---|---|
| `POST /api/workflow_api/workflow_detail` | `space_id`,`workflow_ids` | `code`, `data`, `message` | `message` = 空串 |
| `POST /api/workflow_api/canvas` | `workflow_id`,`space_id` | `BaseResp`, `code`, `data`, `msg` | `msg` = 空串 |

- 两次采样均为 HTTP 200 + `code=0`；**文案键在成功样本上是空串**，即「键存在但无内容」是正常形态，判读不能把空串当成缺文案。
- 同一份采样里，缺 `space_id` 的 `workflow_detail` 返回 HTTP 200 + `{code:777777775, msg:<长文本>}` —— 即**失败样本仍用 `msg`**。两个键名不是「成功 / 失败」的分野，只是端点间的实现差异。

含义：把「所有端点都按 `{code, msg}` 判读」的调用方（回归基线脚本、任何统一信封判据）会把 `workflow_detail` 的**成功**响应误判成「缺文案」；判读必须按端点兼容两种键，同时**不得**把「两键皆缺或均为 `null`」也当成成功。

## 3. 关键事实（设计需据此调整）

**F1 · `workflow_list` 的 `project_id` 是硬过滤，且列表项不回显归属。**
只传 `space_id` 时，挂在 App 下的 workflow **完全不出现**（实测同一 workflow：`space_id` 单查 `total=0`，加 `project_id` 后 `total=1`）；而返回项里没有 `project_id` 字段。含义：workflow-v2 的本地注册表**必须自己存 `project_id`**，否则列表页会「丢数据」，也无法靠上游反查归属。

**F2 · `create` 生成的默认 schema 有缺陷，直接保存后跑不通。**
新建 workflow 的 End 节点入参引用为 `{"source":"block-output","blockID":"","name":""}`，导致 `node_type`（HTTP 500）、`validate_tree`、`test_run` 全部报 `invalid BlockInputReference`。探针的规避办法是把该引用改指 Start 节点的首个输出后再 `save`（`repairDefaultSchema`）。含义：workflow-v2 若允许「建了就跑」，要么在 create 后补一次规范化 save，要么在前端建图时补全连线。

**F3 · `publish` 的 `workflow_version` 实际是必填且必须严格自增。**
不带 `workflow_version`：该 workflow 从未发布过（且草稿已过 `test_run`）→ 成功，但 `data.publish_commit_id` 为空串；已发布过 → `777777769 workflow version name is invalid`（另观察到一次 `720700801 database operation failed`）。带旧版本号 → `777777775 the version number is not self-incrementing, old version v1.0.x, current version v1.0.x`。含义：设计文档「`workflow_version` 由 workflow-v2 递增生成」是**必需项**而非优化项；由于上游侧没有可靠的「当前版本」读接口（`workflow_detail.version` 在发布前后均为空串，实测），递增版本只能由本地注册表持久化。

**F4 · 重新登录会踢掉旧会话（单会话）。**
用旧 `session_key` 调 canvas 得到 `700012006 session not exist`。含义：workflow-v2 的「内存持有 + 单飞重登」假设成立，但**多副本部署会互相踢**，必须由单副本（或分布式锁）独占登录，否则两个副本会反复互踢。

**F5 · 失败响应有两种编码，不能只按 HTTP 状态判定。**
业务失败多为 HTTP 200 + `code≠0`；thrift 必填缺失为 HTTP 400 + `code=400`；无 Cookie 为 HTTP 401/`code=401`；而 Go panic 兜底在 `test_run`/`node_type` 场景会返回 **HTTP 500 + 纯文本 `code=… message=…`（非 JSON）**。BFF 的错误处理必须同时覆盖「HTTP 状态」「JSON 业务码」「非 JSON 文本」三种形态。

**F6 · 运行历史的响应形状不统一（核销 §9.1 第 7 条）。**
`list_spans` 是**裸对象**（顶层只有 `spans`，无 `code`/`msg`/`data`，未命中为 `{"spans":null}`）；`sign_image_url` 的 `url` 在**顶层**而非 `data` 内（仍带 `code`/`msg`）；`get_process`/`get_node_execute_history` 是标准包裹；`get_trace` 无数据返回 `{}`。含义：BFF **原样透传**的规则（冻结文档 §6）在这几个接口上尤其重要——任何"统一包一层"或"以 `data` 取值"的改写都会破坏画布 SDK 的解析。

**F7 · 时间戳单位确认。**
`list_spans` 的 `start_at`/`end_at` 是**毫秒**（thrift 注释与实测一致）；`workflow.create_time`/`update_time` 是**秒**。混用会导致 trace 查询永远为空。

**F8 · `update_meta` / `cancel` 无 `data` 字段，`delete` / `batch_delete` 用 `data.status`。**
成功判定的形状不统一（`code=0` / `data.status=0` / 无 `data`），workflow-v2 的响应归一化要逐接口处理，不能假设统一包体。

**F9 · 上游没有「按空间列出 App」的接口。**
`space/list` 的 `app_ids` 实测恒为 `null`（含个人空间），`draftbot` 侧只有按 `bot_id` 查询的 `get_draft_bot_info`（不存在的 `bot_id` → `code=100000000`，`msg="invalid parameter : agent <id> not found"`）。含义：`organization ↔ App` 映射必须由 workflow-v2 的 `workflow_v2_org_app` 持久化；探针本身也因此需要本地台账（`--state`）才能重复运行。

**F10 · 设计文档 §4.2 中 `latest` / `submit` 两个接口在本上游版本不存在。**
`idl/workflow/workflow_svc.thrift` 共 42 个 `workflow_api/*` 路由，其中没有 `latest`、`submit`，也没有 `commit` 相关的独立路由（版本历史只有 `history_schema`，且缺 `commit_id` 时 panic）。含义：「提交版本 / 冲突检查」这一行需要回到设计文档修订（要么改用 `save` + `history_schema`（当前不可用），要么确认是否来自更高版本的上游）。

**F11 · `publish` 的前置条件是「当前草稿已通过一次 `test_run`」。**
新建 workflow 直接 `publish`（无论带不带 `workflow_version`）返回 `777777775 …'s current draft needs to pass the test run before publishing`；同一 workflow 在 `test_run` 跑完（`get_process.executeStatus=2`）后立刻成功。含义：控制台的「发布」动作不能只调 `publish`，必须串起 `test_run` → 轮询 `get_process` 至终态 → `publish`；错误提示也要区分「草稿未验证」与「版本号非法」两种 `777777775`。

## 4. 如何复跑

### 4.1 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `WORKFLOW_V2_PROBE_BASE_URL` | 否 | 上游基址，默认 `http://127.0.0.1:18080` |
| `WORKFLOW_V2_PROBE_EMAIL` | 是 | 探针账号邮箱，缺省即报错退出 |
| `WORKFLOW_V2_PROBE_PASSWORD` | 是 | 探针账号密码，**只经环境变量传入**，源码与本文档均不记录 |

### 4.2 命令

```bash
WORKFLOW_V2_PROBE_EMAIL=<探针邮箱> WORKFLOW_V2_PROBE_PASSWORD=<探针密码> \
  bun run scripts/workflow-v2/upstream-contract-probe.ts \
  --out /tmp/upstream-contract-snapshot.json \
  --state /tmp/fenix-workflow-v2-probe.state.json
```

- 默认打印人类可读摘要；`--json` 改为输出 JSON 到 stdout；`--out <path>` 额外落盘 JSON。
- `--state` 是探针资源台账（默认 `$TMPDIR/fenix-workflow-v2-probe-state.json`），记录本次的 `spaceId/appId/workflowId`。**保留它 = 复用同一组探针资源**；删掉它 = 下一轮会新建一个探针 App 与 workflow（`draftbot/create` 也会重新被覆盖）。
- 退出码：引导阶段（登录/空间/探针资源）失败为 `1`，接口级失败不影响退出码——接口失败是基线要记录的事实。

### 4.3 复跑后的比对口径

1. 先比 `summary.failed` 与本文档 §2 的「失败码样本」列：上游升级后**新增**的失败项即为回归风险。
2. 再比每条的 `shape` 字段（关键字段形状）：字段消失/类型变化会直接打断 BFF 与画布 SDK。
3. 最后比 §3 的 F1–F11：这些是「设计已依赖」的行为，任何一条翻转都要同步改设计文档与 workflow-v2 实现。
4. 脚本内建的脱敏（会话键、URL 查询串、Go 堆栈）必须保持开启，否则基线不可入库。

## 5. 未覆盖 / 未验证

### 5.1 接口层（本版上游的 `workflow_api/*` 共 42 个路由，本次覆盖 26 个）

未覆盖（16 个）及其原因：

| 未覆盖接口 | 原因 |
|---|---|
| `workflow_api/upload/auth_token` | 需要真实上传链路；画布首版不做文件上传（核销 §9.1 第 8 条留待阶段 1） |
| `workflow_api/nodeDebug` | 需要前端节点级调试上下文，探针无法构造最小载荷 |
| `workflow_api/llm_fc_setting_merged`、`workflow_api/llm_fc_setting_detail` | 依赖模型与插件凭据；本环境未配置模型 |
| `workflow_api/project_conversation/{create,update,delete,list}` | 属 chatflow 会话定义，首版不做 |
| `workflow_api/chat_flow_role/{create,delete,get}` | 同上（chatflow 角色） |
| `workflow_api/copy_wk_template`、`workflow_api/example_workflow_list` | 模板市场链路，非 v2 首版范围 |
| `workflow_api/apiDetail` | 属发布为 API 的链路，v2 走发布版本而非 API 详情 |
| `workflow_api/workflow_references`、`workflow_api/workflow_detail_info` | 与已覆盖的 `workflow_detail` / `delete_strategy` 重叠度高，避免重复探测 |
| `/v1/workflow/get_run_history`（PAT 通道） | 属外部 OpenAPI 通道（PAT 认证），与 BFF 的页面会话通道不同源；§9.1 第 7 条的对照留待有 PAT 的环境 |

### 5.2 场景未验证

| 场景 | 原因 / 影响 |
|---|---|
| `history_schema` 成功样本 | 缺有效 `commit_id`（`save` 不回传 commit_id，`canvas` 也不返回）；当前只记录 panic 样本 |
| `test_resume` 成功样本 | 需要一个会中断的工作流（问答/输入节点）与 `event_id`；探针用 start→end 空跑，取不到中断事件 |
| `released_workflows` / `list_publish_workflow` 的非空样本 | 需要把 App 作为「产品」发布上架（上游审核链路），超出探针范围 |
| `list_spans` / `get_trace` 的有数据样本 | 空跑工作流无有效 span 落 ES，本批次 3 次运行均为空；带真实节点（LLM/HTTP/代码）的 trace 留待阶段 3 |
| 白名单节点的执行与 `node_type` 细节 | 探针只跑默认的 start→end 空图，`node_type` 返回的 `nodes_properties` 未覆盖 llm/http/code 等节点的真实字段；节点白名单（2C）需在阶段 1 用真实节点补测 |
| 并发与限流（§9.1 第 5 条） | 未做压测；单会话限制已由 A4 证实，配额上限未知 |
| 多副本并发登录（§9.1 第 3 条） | 单进程验证了「重登踢旧会话」，多副本行为需部署后验证 |
| 静态资源响应头 `X-Frame-Options`/CSP 与 basename 改造（§9.1 第 6 条） | 属阶段 1 的反代验证，与接口契约无关 |
| Origin/CSRF/UA 校验（§9.1 第 1 条） | 探针本身就是「无浏览器上下文」的服务端调用（无 Origin/Referer，UA=Bun fetch），全部接口可用，**该条据此可判为通过**；但未逐一枚举带 Origin 的反例 |
| 数据隔离（跨账号读他人的 `workflow_id`） | 只有一个探针账号，未构造跨账号越权样本；`checkUserSpace` 的实际边界待 workflow-v2 的归属校验测试覆盖 |
