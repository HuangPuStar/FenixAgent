# scripts/workflow-v2

workflow-v2（上游工作流接入面）的运维脚本。两个脚本用途不同，不要互相替代：

| 脚本 | 用途 | 对上依赖 |
|---|---|---|
| `upstream-contract-probe.ts` | 阶段 0 契约快照探针：直连上游，采集 `/api/workflow_api/*` 与引导接口的进/出参样本 | 上游服务 + 探针账号 |
| `canvas-e2e-check.ts` | 任务 1J 端到端联调验收：走**本平台**的画布面与控制台面，判三条验收判据 | 平台服务 + 上游服务 + 控制台账号 |

## 前置条件

**服务**

- 平台服务在跑（`bun run dev`，默认 `http://127.0.0.1:3000`）。
- 上游服务可达，且平台侧三枚必填模块配置已就绪：`WORKFLOW_V2_PLATFORM_ACCOUNT_EMAIL` /
  `WORKFLOW_V2_PLATFORM_ACCOUNT_PASSWORD` / `WORKFLOW_V2_TICKET_SECRET`（缺任一枚平台服务起不来，
  脚本会在第一步以「请求未完成」收场）。这三枚属于**部署方**的配置，不经本脚本传入。
- 组织至少绑定过一次上游应用（`workflow_v2_org_app` 有行）。没有绑定时脚本会补一次幂等建绑
  （见「副作用」）。

**环境变量**（只列变量名；脚本从不打印任何值）

| 变量 | 必需 | 说明 |
|---|---|---|
| `WORKFLOW_V2_E2E_BASE_URL` | 否 | 平台服务基址，默认 `http://127.0.0.1:3000` |
| `WORKFLOW_V2_E2E_SESSION_COOKIE` | 二选一 | 控制台会话 cookie（浏览器里复制 `better-auth.session_token=…`） |
| `WORKFLOW_V2_E2E_EMAIL` + `WORKFLOW_V2_E2E_PASSWORD` | 二选一 | 控制台账号；脚本自行登录（顺带验证登录链路） |
| `WORKFLOW_V2_E2E_FOREIGN_WORKFLOW_ID` | 否\* | 组织 B 名下的上游 workflow ID（判据 C 的对照） |
| `WORKFLOW_V2_E2E_EMAIL_B` + `WORKFLOW_V2_E2E_PASSWORD_B` | 否\* | 组织 B 的控制台账号；脚本登录后取该组织的第一个 workflow |
| `WORKFLOW_V2_E2E_WORKFLOW_ID` | 否 | 受测 workflow ID：给了就复用既有 workflow（不创建、不删除，编辑后写回还原） |
| `WORKFLOW_V2_E2E_ACTIVE_ORG_ID` | 否 | 多组织账号指定 active organization（经 `x-active-org-id` 下发） |
| `WORKFLOW_V2_E2E_TIMEOUT_MS` | 否 | 单请求超时，默认 `15000` |
| `WORKFLOW_V2_E2E_AUTO_BIND` | 否 | 置 `0`/`false` 关闭「未绑定时自动建绑」 |
| `WORKFLOW_V2_E2E_KEEP_RESOURCES` | 否 | 置 `1` 保留本次创建的临时 workflow（默认结束删除） |

\* 判据 C 需要**一个**对照来源：`WORKFLOW_V2_E2E_FOREIGN_WORKFLOW_ID` 或组织 B 的账号。两者都缺时，
判据 A、B 照常执行，判据 C 记为 SKIP，退出码 2（缺前置）。

## 一行运行

```bash
WORKFLOW_V2_E2E_EMAIL=ops@example.com WORKFLOW_V2_E2E_PASSWORD='***' \
  WORKFLOW_V2_E2E_FOREIGN_WORKFLOW_ID=<组织B的workflowId> \
  bun run scripts/workflow-v2/canvas-e2e-check.ts
```

`--json` 输出机器可读结果，`--out <path>` 额外落盘。密码与会话 cookie 只经环境变量传入。

## 三条判据

**A 打开 → 编辑 → 保存**（画布面真实路径）

`POST /web/workflow-v2/iframe-code` 取一次性 code → `POST /workflow-canvas/bff/session/exchange` 兑换票据 →
带 `X-Fenix-Workflow-Ticket` 透传：

1. `POST /api/workflow_api/canvas` 打开（刻意**不传 `space_id`**：服务端必须自行注入）；
2. 改写首个节点标题 → `POST /api/workflow_api/save` 保存草稿；
3. 复读 canvas，断言改写后的标题确实落库（这一步才证明「编辑→保存」真的生效，而不是 save 返回了 0）；
4. `POST /api/workflow_api/list_publish_workflow` 读发布记录。

每一步都断言响应是上游原生信封：HTTP 2xx + `code === 0` + 随行文案存在，三者缺一即 FAIL。文案键
**按端点如实兼容** `msg` 与 `message` 两种顶层键（`workflow_detail` 的上游原生形状是 `{code, data, message}`，
`canvas` 等是 `{code, data, msg}`；实测记录见 `docs/design/2026-09-29-workflow-v2-upstream-contract-snapshot.md`）。
两个键都缺失或均为 `null` 仍判 FAIL —— 放宽的只是「文案装在哪个键」，不是「有没有文案」。

**B 伪造参数被覆盖**

在 `canvas` 与 `workflow_detail` 两个请求里显式塞入伪造的 `space_id` / `project_id` / `bot_id` / `owner_id` /
`login_user_create` / `creator` / `operator`（值为带运行标记的哨兵串），断言三件事：

1. 请求仍然成功（伪造字段被剥离而不是把请求打坏）；
2. 响应里**一个伪造值都没出现**（深度扫描整份响应体，命中即报告 JSON 路径）；
3. `workflow_detail` 回显的 `project_id` 等于本地绑定里的租户 App ID（`GET /web/workflow-v2/org-app` 的
   `appId`）——即服务端注入的是权威值，不是客户端自报值。

**C 跨租户 404**

用组织 A 的票据（`claims.org` = A）访问组织 B 的真实 workflow：

1. 断言 `404` + `{code:404, msg:"not_found"}`；
2. 再对一个**随机生成的、不存在的** workflow 走同一条路径，断言两次响应体逐字相同（键序无关）——
   真正的判据是「不可区分」，而不是「都是 404」；
3. 对照：不带票据必须是真实 `401` + `{code:401, msg:"ticket_invalid"}`，否则前面的 404 可能只是
   「什么都拒绝」。

## 退出码

| 码 | 含义 |
|---|---|
| `0` | 三条判据全过 |
| `1` | 有 FAIL（含清理失败/未确认） |
| `2` | 缺凭据或缺前置（判据没跑满），含三条判据的对照数据缺失 |
| `130` | 用户中断（Ctrl+C；会先尝试清理临时资源） |

失败时每一步都会打印「期望 / 实际（已脱敏）/ 下一步建议」。

## 副作用与可重复性

- 默认**创建**一个临时 workflow（`POST /web/workflow-v2/workflows`），结束走
  `DELETE /web/workflow-v2/workflows/:id?force=true`（本地软删 + 上游删除；上游收敛失败由对账任务重试）。
  脚本不依赖上一次运行的任何残留，可以反复跑。
- 组织未绑定上游应用 时会补一次幂等建绑（等价于控制台「初始化工作流空间」）。**上游没有删除 App 的
  接口**，这次建 App 不可回收，因此脚本会在报告里明确写出；不接受该副作用时设
  `WORKFLOW_V2_E2E_AUTO_BIND=0`。
- 复用既有 workflow（`WORKFLOW_V2_E2E_WORKFLOW_ID`）时不创建、不删除：改写节点标题证明保存链路后，把
  开头读到的原始 schema 写回。
- 探针的 `upstream-contract-probe.ts` 只增不减（它创建探针 App 与 workflow 并复用台账），与本脚本的
  「用完即删」是两套口径，别把它们的结果混着解释。

## 执行现状与未验证项（不要高估覆盖度）

- **已在本机真实执行通过（2026-09-30，退出码 0）**：24 PASS / 0 FAIL / 0 SKIP，三条判据全过——A 打开 →
  编辑 → 保存（改写首个节点标题后复读 canvas，确认标题真落库）、B 伪造 `space_id`/`project_id`/`bot_id`/
  `owner_id`/`login_user_create`/`creator`/`operator` 被覆盖或 strip（7 个哨兵串深度扫描零命中，回显
  `project_id` 等于本地绑定 App）、C 组织 A 的票据访问组织 B 的真实 workflow → 404 且与「不存在」的 404
  逐字同形、无票据对照为真实 401。跑法与本次姿态：`RCS_PORT=3100` 起独立平台实例（避开本机既有的 3000 /
  3001 / 3002 占用）、上游 `http://127.0.0.1:18080`、控制台侧用**新建账号经
  `POST /api/auth/sign-in/email` 登录**（未用 `WORKFLOW_V2_E2E_SESSION_COOKIE`），平台上游账号由引导
  路径**自助注册**（`WORKFLOW_V2_UPSTREAM_ACCOUNT_*` 三枚已配在 `.env`，无需人工建号）。判据 C 的对照来自
  `WORKFLOW_V2_E2E_FOREIGN_WORKFLOW_ID`。
  步骤数是 24 而不是 27：组织已绑定，脚本不进 `P3`/`P4`/`P5` 的建绑分支（**不登记为 SKIP**，因此不影响退出码）。
- **组织 B 账号分支（`WORKFLOW_V2_E2E_EMAIL_B` + `PASSWORD_B`）未跑**：上面的执行走的是环境变量给定对照
  workflow 的那条路，脚本自行登录组织 B、再取该组织首个 workflow 的分支没有覆盖。
- **多组织账号的 active organization 路径未跑**：本次是有单组织账号，组织上下文走的是宿主
  `services/org-context` 的「回退到第一个可用组织」；`WORKFLOW_V2_E2E_ACTIVE_ORG_ID`（`x-active-org-id`）
  这条显式选择路径没有验证。
- `creator` / `operator` / `owner_id` / `login_user_create` 在上游没有语义位点，服务端只做 strip、没有可
  回显的权威值：对这四个字段只能断言「未出现在响应里」，**不能**证明「上游一定没收到」。
- 调试类读接口（`get_process` / `get_node_execute_history`）需要真实 `execute_id` 或节点执行记录；触发调试
  运行会在上游侧留下运行数据，因此本脚本不跑调试，改以发布记录读接口覆盖「调试/发布相关的读接口」。
- 节点白名单过滤（`node_type` / `node_template_list` / `node_panel_search`）与图片直链改写
  （`sign_image_url` / `get_imagex_url` → `/workflow-canvas/storage/*`）不在本脚本的判据内。
- 静态反代面（`/workflow-canvas/*` 的 SPA、`Set-Cookie` 剥离、`frame-ancestors`）不在本脚本的判据内：
  它验证的是 API 链路，不是 iframe 是否能在浏览器里渲染。
- **上游删除是否真收敛未回查**：清理步骤只看到 `DELETE /web/workflow-v2/workflows/:id?force=true` 返回
  `{"deleted":true,"strategy":0}` 与 `workflow.delete.upstream` 审计行，没有再回上游侧确认临时 workflow
  确实消失（上游收敛失败由对账任务重试，重试结果同样不在本脚本判据内）。
- **部署面未验证**：脚本跑的是本机单进程实例（`bun run dev` 形态），反代/多副本/容器镜像等部署形态下的
  行为（尤其会话共享依赖的 `RCS_REDIS_URL`）不在覆盖范围内。
- 登录走 `POST /api/auth/sign-in/email`（better-auth 协议面）。脚本刻意**不发** Cookie 与 `Sec-Fetch-*`
  请求头——这正是 better-auth 放行非浏览器客户端的条件（带 Cookie 时会强制校验 Origin，而可信来源在部署间
  不一致，猜一个只会带来假失败）。若部署改了登录路径或关闭了邮箱密码登录，请改用
  `WORKFLOW_V2_E2E_SESSION_COOKIE`。

## 测试

纯逻辑（配置解析、响应判读、伪造值扫描、schema 标记、脱敏）有单测覆盖，不依赖网络与真实服务：

```bash
bun test scripts/__tests__/canvas-e2e-logic.test.ts
```
