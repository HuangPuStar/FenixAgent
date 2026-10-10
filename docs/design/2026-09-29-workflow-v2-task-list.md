# Workflow V2 实施任务清单

> 日期：2026-09-29
> 设计依据：[2026-09-29-workflow-v2-upstream-studio-bridge.md](./2026-09-29-workflow-v2-upstream-studio-bridge.md)
> 用法：每条任务可直接派发给一个 subagent；`[泳道]` 标注文件域，泳道之间可并行，泳道内部按序。

## 并行泳道（文件域互斥，可同时开工）

| 泳道 | 独占文件域 | 说明 |
|---|---|---|
| A 后端 | `packages/resources/workflow-v2/**`（不含 `web/`）、`drizzle/**` | workflow-v2 服务端 |
| B 控制台 | `packages/resources/workflow-v2/web/**`、`apps/web/src/routes/agent/_panel/workflow*.tsx`、`apps/web/src/i18n/index.ts`、`apps/web/package.json` | 列表页 + 画布宿主页 |
| C 上游仓 | `/Users/konghayao/code/ai/workflow-studio/frontend/**` | 画布改造（独立仓） |
| D 部署 | `deploy/**`、反代配置、env 样例 | 反代、响应头、环境 |
| E 清理 | `packages/resources/workflow/**`、生成物、宿主快照测试 | 旧前端下线（独占批次） |

## 阶段 0：契约冻结与核验（先行，其余泳道等契约）

- [x] P0-1 `[契约]` 冻结三份契约：控制台接口表（设计 §4.3）、透传路由与注入规则（§4.2/4.7）、握手与票据协议（§5.2），产出 DTO/消息类型定义草案
- [x] P0-2 `[核验]` 部署上游服务并逐条核销设计 §9.1 的 8 条运行时验证项，回写文档
- [x] P0-3 `[核验]` 采集 `/api/workflow_api/*` 契约快照（进/出参样本），作为升级回归基线

## 阶段 1：画布可达

- [x] 1A `[A]` workflow-v2 包骨架：`fenix.module.ts`、路由贡献（web/canvas）、`envDefinitions`、db schema + 迁移、审计表 —— 阻塞 A/B 后续，先做
- [x] 1B `[A]` `upstream-session`：passport 登录、Set-Cookie 解析、内存持有、单飞重登、探活（与 1C/1D 并行）
- [x] 1C `[A]` `iframe-ticket`：code 签发/兑换/撤销、HMAC 校验、jti 去重（与 1B/1D 并行）
- [x] 1D `[A]` 透传最小集：`canvas`/`save`/`node_type` + 参数注入白名单 + 归属校验（依赖 1A；与 1B/1C 并行，接口先冻结）
- [x] 1E `[D]` 反代配置：`/workflow-canvas/*` 静态 + `/workflow-canvas/bff/*` 优先匹配 + `frame-ancestors` 注入
- [x] 1F `[C]` 上游前端：axios 注入 baseURL 与 `X-Fenix-Workflow-Ticket`；401 由整页跳转改为 `postMessage`
- [x] 1G `[C]` 上游前端：I18n/Theme Provider 自举、space/用户态注桩、全局常量兜底（与 1F 在 `page.tsx` 上串行）
- [x] 1H `[C]` 上游前端：路由 basename 与资源前缀（依赖 P0-2 结论）
- [x] 1I `[B]` 画布宿主页：iframe、握手状态机、骨架/超时/降级、`navigate-out` 返回导航
- [x] 1J `[联调]` 端到端联调：打开 → 编辑 → 保存；伪造 `space_id`/`project_id` 被覆盖、跨租户 404
      —— **已通过（2026-09-30）**：在本机以 `RCS_PORT=3100` 的独立平台实例对真实上游
      （`http://127.0.0.1:18080`）执行 `scripts/workflow-v2/canvas-e2e-check.ts`，**24 PASS / 0 FAIL / 0 SKIP、
      退出码 0**。三条判据——A 打开 → 编辑 → 保存：改写首个节点标题后**复读 canvas**，确认标题真落库（画布
      刻意不传 `space_id`，服务端注入的权威值经回显 `project_id` 核对）；B 七个伪造字段（`space_id` /
      `project_id` / `bot_id` / `owner_id` / `login_user_create` / `creator` / `operator`）被覆盖或 strip：
      7 个哨兵串对整份响应体深度扫描零命中，且 `workflow_detail` 回显的 `project_id` 等于本地绑定 App；
      C 组织 A 的票据访问组织 B 的**真实** workflow → 404，且与「随机不存在的 workflow」的 404 逐字同形，
      另有「无票据 → 真实 401」对照排除「什么都拒绝」的假过。
      跑法：控制台侧新账号经 `POST /api/auth/sign-in/email` 登录；平台上游账号由引导路径**自助注册**
      （人工建号已不必要，三枚 `WORKFLOW_V2_UPSTREAM_ACCOUNT_*` / `WORKFLOW_V2_TICKET_SECRET` 配在 `.env`）；
      判据 C 的对照来自 `WORKFLOW_V2_E2E_FOREIGN_WORKFLOW_ID`。
      步骤数 24 而非 27：组织已绑定，脚本不进 `P3`/`P4`/`P5` 的建绑分支（**不登记为 SKIP**，不影响退出码）。
      **未覆盖**：组织 B 账号登录分支、多组织 `x-active-org-id` 路径、浏览器 iframe 渲染、调试类接口、节点
      白名单与图片直链改写、上游删除的实际收敛、部署形态（多副本 / 反代 / 容器）——逐条清单见
      `scripts/workflow-v2/README.md` 的「执行现状与未验证项」。

## 阶段 2：CRUD 闭环与旧前端下线

- [x] 2A `[A]` 租户 App 映射：`org-app` 创建/查询/绑定 + 管理面接口
- [x] 2B `[A]` 本地注册表：列表/创建/重命名/删除 + 创建补偿 + `pending_delete`
- [x] 2C `[A]` 节点白名单过滤（`node-scope`，覆盖三类节点接口）
- [x] 2D `[B]` 列表页：表格、创建、删除确认、loading/empty/error+retry
      ——2026-10-09 改为**卡片网格**（点卡片进画布、「更多」菜单收纳日志 / 调用接口 / 重命名 / 删除；发布入口于 2026-10-10 撤除；「新建工作流」
      移到页面 header 的 actions 槽位，页面壳 `AppPage`/`AppHeader` 由包内页面渲染、宿主路由退化为 `Suspense` 壳）
- [x] 2E `[C]` 上游前端：壳裁剪（header 按钮、发布简化）、节点面板兜底过滤、埋点静默
- [x] 2F `[E]` 删除批次（独占）：旧 `web/` 目录、宿主路由、i18n、exports、宿主测试、deploy 清单、生成物重跑 —— 与 2D 串行（同文件域）
- [x] 2G `[门禁]` `bun run precheck` + `bun run build:web` 全绿

## 阶段 3：调试与发布

- [x] 3A `[A]` 调试透传：`test_run`/`test_resume`/`cancel` + 过程轮询（含退避预算）
- [x] 3B `[A]` 发布与 trace：`publish`（版本递增）、发布记录、`list_spans`/`get_trace`
      ——控制台发布入口与日志查看于 2026-10-09 补齐（卡片菜单内的「发布」与两个日志弹窗、`GET /workflows/:id/publish-records` 与运行日志读路径）；
      发布记录取上游**应用级** `publish_record_list`（工作流级 `list_publish_workflow` 是桩实现，契约快照 F12），运行日志的「列出执行历史」上游没有读出口（见 arch 25 §7）
      ——**2026-10-09 结案（上句「没有读出口」随之失效）**：上游同日以 commit `3a028cf1` 补实现在 `list_spans`（契约见 `docs/design/2026-10-09-workflow-v2-upstream-run-list-api-request.md` §7），平台同日切回 HTTP（读路径见 `docs/arch/25-workflow-v2.md` §8），本条完成
      ——**2026-10-10 收口：控制台发布入口整体撤除**（发布是旧有逻辑，动作在上游侧完成）：卡片菜单的「发布」与 `publish.*` 文案、控制台面 `POST /workflows/:id/publish` 及其服务端闭环（含发布后的渠道主动同步）一并删除；保留发布记录读路径、卡片的上游发布状态展示与版本号算术（对外触发链路的运行前自愈仍用，见 `docs/arch/25-workflow-v2.md` §8）
- [x] 3C `[A]` 审计与指标接入；错误映射与 503 熔断降级
- [x] 3D `[B]` 宿主侧错误兜底与用户提示（`web/pages/canvas/canvas-status-views.tsx`：骨架、初始化超时、上游不可用、会话失效、未绑定引导）
- [x] 3E `[A]` **平台账号 `spaceId` 投影（P0，画布可达的前置）**：`routes/web/platform-account.ts` 的
      `spaceId` 已改为读平台账号台账（`findPlatformAccount()`）；台账无行回 `null`（画布页判 `space-missing`），
      读库失败回 500 而不降级为 `null`（画布页判 `probe-failed`）——静默 `null` 会让「DB 不可用」与「尚未
      引导账号」在页面上塌成同一个死局。用例：`upstream-session-platform-account.test.ts` 的「回显台账里的
      spaceId」/「台账无行时 spaceId 为 null」/「台账读取失败时返回 500 且不回显内部细节」三条。
      连带确认（同批落地）：列表页未绑定态的「初始化工作流空间」入口（`workflow-list-page.tsx` 调
      `POST /web/workflow-v2/org-app`，幂等），否则用户永远走不到 `POST /org-app`。

## 阶段 4：对账与加固

- [x] 4A `[A]` 对账任务：`pending_delete` 重试、孤儿补写、告警
      —— **已落地（2026-09-29）**：编排在 `src/server/services/reconciliation.ts`（`runReconciliationOnce` 单飞，
      周期任务随模块装配启动、经 `registerCleanup` 停止，**没有手工触发端点**），两段收敛分别为
      `reconciliation-pending-delete.ts`（待删重试）与 `reconciliation-orphans.ts`（孤儿补写与创建补偿收敛），
      端口与失败分类在 `reconciliation-ports.ts`；每轮一条结构化汇总日志 + 进程内快照（`getReconciliationStatus`）。
      **待删段**：上游确认删除后硬删本地行，并写 `workflow.delete.upstream` / `reconciled` 审计；预算是**双闸**——
      次数上限 5（进程内，重启即重置）与年龄上限 24h（按 `deleted_at`，重启后仍拦得住），任一超限即停止重试并
      告警；退避 30s × 2ⁿ、封顶 30min。
      **孤儿段**：归属判据只来自「平台账号 `space_id` × 本地 `workflow_v2_org_app.app_id`」的反查；列表项
      自报 `project_id` 不符、身份已被他组织登记、缺 `workflow_id` 一律 **fail-closed**（只计数 + 告警，不补写）。
      带未收敛补偿标记的对象按「应当删除」处置——删除并追加 `workflow.create.compensation` / `cleaned` 终结标记，
      绝不在补写路径上被认领（补偿标记所属组织与绑定行不符时同样只计数 + 告警）。
      连带：新迁移 `drizzle/0031_workflow-v2-audit-action-index.sql`（含 `meta/0031_snapshot.json` 与 journal）
      为补偿标记的反查加 `(action, upstream_workflow_id)` 索引；新键 `WORKFLOW_V2_RECONCILE_INTERVAL_SECONDS`
      （默认 300，`0` 禁用；首轮在一个周期之后）。
      用例：`src/__tests__/reconciliation.test.ts`（26 条，四组：待删收敛、孤儿补写、创建补偿收敛、生命周期与
      失败隔离——含 `reconciled` 审计与硬删、退避窗口、次数/年龄双闸、`project_id` 不符与跨组织拒补写、单飞重入、
      熔断跳过孤儿扫描、周期为 0 时不排定时器）。
      **未验证**：`workflow_list` 列表项的真实字段形态只按契约快照实现；真实形态不同则扫描 fail-closed 成
      「跳过 + 告警」，不会误写归属。
- [x] 4B `[D]` 限流/压测/多副本会话方案（依赖 P0-2 结论）
      —— **已落地（2026-09-29）**：多副本会话在 `src/server/services/upstream-session-store.ts`——权威副本在共享存储
      （Redis），进程内 5s 缓存；登录走 `SET NX PX` 租约 + Lua 比删释放，抢不到租约的副本在等待窗口内轮询等
      对方发布会话，等不到再抢一次、仍失败才如实回 `busy`（不做第三次尝试）；`loggedInAt` 作失效水位，避免
      「读得到、删不掉」时复活本进程刚判定失效的会话。Redis 未配置或命令出错时降级为进程内单例（语义回到
      4B 之前），**降级必告警**（10 分钟窗口节流）。
      限流在 `src/server/services/rate-limit.ts`（令牌桶，容量 = 每分钟阈值）：画布透传按票据 `sub` 计数
      （`WORKFLOW_V2_BFF_RATE_LIMIT_PER_MINUTE`，默认 1200）；免票的 `session/exchange` 与无有效票据的
      `refresh` / `revoke` 按来源地址计数（`WORKFLOW_V2_SESSION_RATE_LIMIT_PER_MINUTE`，默认 60）；超限返回
      **真实 HTTP 429 + `Retry-After`**。
      **关键契约**：画布只在 401 时换票，**429 不得被当成票据失效**——做成 401 会让它去换一张同样被限的票，
      做成 200 又会被当成业务错误。
      **已知限制**：桶住在进程内，多副本下实际阈值 ≈ 配置值 × 副本数；全局阈值归部署层（反代），不做分布式计数。
      用例：`src/__tests__/upstream-session-multi-replica.test.ts`（11 条：共享读写、租约等待与接手、等待窗口耗尽抛
      `busy`、失效清共享存储、无 Redis / 命令失败降级、并发只登录一次）与 `src/__tests__/rate-limit.test.ts`
      （6 条：容量与等待秒数、等待后恢复、键间隔离、键数上限回收、新键必放行、`reset` 回满桶）。
- [x] 4C `[文档]` 更新 `docs/arch/` 或 ADR，登记开放问题（设计 §9.3）：`docs/arch/17-workflow.md`、
      `docs/arch/25-workflow-v2.md`（§8 列已落盘/未落地）与 [ADR](../adr/2026-09-29-workflow-v2-upstream-bridge.md) 已就位
- [x] 4D `[A]` 平台账号自助注册：引导层在登录前调上游注册端点（幂等），部署方不再需要人工建号
      —— **已落地（2026-09-30，`54831be59`）**：注册报文、业务码判定（`700000001` 已存在按成功、
      `700000008` 关注册、其余归 `failed`）与四态归一在 `src/server/services/platform-account-registration.ts`；
      编排在 `src/server/services/platform-account-bootstrap.ts` 的 `bootstrapPlatformAccount()`（注册 → 登录 →
      取个人空间 → 落台账）。**注册只在台账无行的引导路径发生**——`login()` / `ensureCookie()` / 鉴权失败重登
      分支不触达，env 邮箱写错不会凭空造号；上游关注册时不立刻判死、仍尝试登录（兼容「人工建号 + 关注册」的
      既有部署）；注册响应顺带下发的 `session_key` **不采信**（会话仍只由登录链路产生）。本轮**未新增 env**，
      只更新两枚账号 env 的描述文案与三份生成样例。用例：`src/__tests__/platform-account-registration.test.ts`
      （8 条）与 `org-app-binding.test.ts` 的「台账已有账号行时不注册也不登录」。设计与上游取证见
      [平台账号供给设计](../design/2026-09-29-workflow-v2-account-provisioning.md)。

### 2F 实测前置条件（2026-09-29 复核，派发前必读）

换 web 贡献**不能只改 `deploy/assembly/ce.json` 的 `web` 列表**——`scripts/generate-web-contributions.ts`
的 `selectContributions()` 会拒绝「web 模块的服务端模块未启用」（`Web 模块 ${webId} 的服务端模块 ${id} 未启用`），
而 `enabledIds` ＝ 固定槽位 ＋ `resources` 列表。因此 2F 必须**同批**把 `workflow-v2` 加进 `resources`。

连带两处必改，漏掉即门禁红：

1. `apps/server/src/__tests__/assembly-env.test.ts` 的 `baseInput` 只有 `DATABASE_URL` / `RCS_API_KEYS`；
   模块启用后其声明的**三个必填键**（`WORKFLOW_V2_PLATFORM_ACCOUNT_EMAIL` / `WORKFLOW_V2_PLATFORM_ACCOUNT_PASSWORD` /
   `WORKFLOW_V2_TICKET_SECRET`）进了聚合面，`resolveAssemblyEnv({ input: baseInput })` 会解析失败，
   该文件里三条用例连带失败。fixture 必须补齐这三个键。
2. 本地 `.env` 也必须补上这三个键，否则 `bun run dev` 起不来（这三枚无默认值，缺失即启动期拒绝）。
   仓库里 `.env.example` / `deploy/env/rcs.example` / `docker/prod/.env.example` 已由 1A 写好并过
   `generate-env-example --check`，不需要再改。

另：`web.id` 在 `createModuleRegistry` 里是**全局唯一键**（重复即构建期抛错），这就是 2F 必须是
「摘旧包 web 块 + 挂新包 web 块」同一批、不能分两次落的原因。

## 冲突域速查（同一时刻只允许一个 subagent 写）

| 文件/目录 | 约束 |
|---|---|
| `apps/web/src/routes/agent/_panel/workflow*.tsx`、`apps/web/src/i18n/index.ts` | B 与 E 互斥，2F 必须等 2D 落盘 |
| `packages/resources/workflow/**` | E 独占（2F 一批完成） |
| `apps/generated/**`、`apps/web/src/routeTree.gen.ts` | 只由生成命令重跑，禁止手改；随 2F 同批 |
| `drizzle/**` | A 独占 |
| 上游仓 `bot-http/src/axios.ts` | 1F 独占 |
| 上游仓 `workflow/adapter/playground/src/page.tsx` | 1F、1G 串行 |
| 上游仓 `workflow/playground/src/workflow-playground.tsx` | 1G 独占 |
| 上游仓路由与构建配置 | 1H 独占 |

## 派发约定

每个 subagent prompt 必须包含：设计文档对应章节引用、本任务的文件域（越界即冲突）、验收标准、禁止改动清单；完成后回报「改动文件 + 验证命令与结果」。
