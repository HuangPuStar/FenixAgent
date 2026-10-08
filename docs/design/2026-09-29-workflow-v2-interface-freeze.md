# Workflow V2 接口冻结（实现契约）

> 日期：2026-09-29 · 状态：**冻结**（实现必须与本文件一致；偏离必须先改本文件并说明原因）
> 设计依据：[2026-09-29-workflow-v2-upstream-studio-bridge.md](./2026-09-29-workflow-v2-upstream-studio-bridge.md)
> 任务清单：[2026-09-29-workflow-v2-task-list.md](./2026-09-29-workflow-v2-task-list.md)

## 1. 文件与 owner（并行开发边界）

| 路径（相对仓库根） | owner 任务 | 说明 |
|---|---|---|
| `packages/resources/workflow-v2/{package.json,tsconfig.json,fenix.module.ts,db/schema.ts}` | 1A | 骨架与 schema |
| `packages/resources/workflow-v2/src/server/{config.ts,assembly.ts,module.ts,server.ts,testing.ts}` | 1A | 组合根与配置 |
| `.../src/server/services/upstream-session.ts`（+ test） | 1B | 会话 |
| `.../src/server/services/upstream-client.ts`（+ test） | 1B | 上游调用（会话消费方） |
| `.../src/server/services/iframe-ticket.ts`（+ test） | 1C | 票据 |
| `.../src/server/services/workflow-registry.ts`、`.../repositories/*`（+ test） | 2B | 注册表 |
| `.../src/server/services/node-scope.ts`（+ test） | 2C | 节点白名单 |
| `.../src/server/routes/web/*`（控制台面） | 1A 建骨架，1B/1C/2A/2B/3A/3B 各自只改自己 handler 的函数体 | 路由文件由 1A 一次性建齐 |
| `.../src/server/routes/canvas/bff.ts`（+ test） | 1D | 透传 |
| `.../src/server/routes/canvas/static-proxy.ts` | 1E | 静态反代 |
| `packages/resources/workflow-v2/web/**` | 1I/2D | 控制台界面 |
| `apps/web/src/**`（路由/i18n/依赖/测试） | 2D→2F 串行 | 2F 独占批次 |
| `packages/resources/workflow/**` | 2F | 旧前端删除（服务端保留） |
| `drizzle/**` | 1A 独占（生成） | 其他任务不得手改 |

## 2. 包骨架

- 目录 `packages/resources/workflow-v2`，包名 `@fenix/resource-workflow-v2`，`private: true`。
- `exports`（与既有资源包同形）：`"."` → `./src/index.ts`、`"./db"` → `./db/schema.ts`、`"./module"` → `./fenix.module.ts`、`"./server"` → `./src/server.ts`、`"./server/testing"` → `./src/server/testing.ts`、`"./web"` → `./web/index.ts`、`"./web/contribution"` → `./web/contribution.ts`、`"./web/i18n"` → `./web/i18n/index.ts`。
- 依赖：`@fenix/platform-sdk`、`@fenix/logger`、`drizzle-orm`、`elysia`、`zod`（v4）；前端 `web/**` 追加 `@fenix/ui-components`、`@fenix/web-runtime`、`lucide-react`，peer 与既有包一致（react/i18next/react-router）。
- 模块 id：`workflow-v2`；`kind: "resource"`；`capabilities: ["resource.workflow-v2"]`；`dependsOn: []`（叶子模块；跨包只允许 `import type` 与未注册基础包）。
- `web.contribution`：`{ id: "workflow", namespace: "workflows" }` 说明符字符串（与既有包同形，见 `packages/resources/workflow/fenix.module.ts` 的 `web` 块）；**上线时必须与旧包 web 贡献同批互斥**（不能同时存在两个 `workflow` 导航项）。
- 域名注册：`deploy/manifests/modules.json` 新增条目（id `workflow-v2`、manifest 路径、package），再跑 `bun run generate:module-registry` 与 `bun run generate:web-contributions`；`deploy/assembly/ce.json` 的 web 列表在 2F 批次替换。

### 2.1 route 贡献（声明顺序即挂载顺序）

| id | slot | 工厂 | 路径 |
|---|---|---|---|
| `workflow-v2.web-control` | `web` | `createWorkflowV2WebRoutes(host)` | `/web/workflow-v2/*` |
| `workflow-v2.canvas-bff` | `app` | `createWorkflowV2CanvasBffRoutes(host)` | `/workflow-canvas/bff/*` |
| `workflow-v2.canvas-static` | `app` | `createWorkflowV2CanvasStaticRoutes(host)` | `/workflow-canvas/*`（必须跳过 `bff/` 前缀） |

`app` 槽贡献不带认证守卫（如既有 `/workflow-ui/*`）；`web` 槽注入 `authGuardPlugin`（同 `WorkflowRouteDependencies` 形态）。

### 2.1.1 静态反代必须出站注入上游会话（P0-2 实测，设计 §9.1.1 第 2 条）

上游除 `/`、`/static`、`/static/`、`/sign`、`/favicon.png`、`/explore/`、`/admin/`、`/space/` 白名单（`request_inspector.go` 的 `isStaticFile`）外，**全站经 `SessionAuthMW`**。
实测：不带上游 cookie 请求 `/workflow-canvas/`、`/workflow-canvas/static/js/*.js`、`/workflow-canvas/favicon.png` → 全部 `HTTP 401`；同源路径 → `200`。

因此 `createWorkflowV2CanvasStaticRoutes` 必须：

- **出站**注入 `Cookie: session_key=<平台账号会话>`（经 `UpstreamSession.ensureCookie()`），SPA 深链（`/workflow-canvas/?wf=..`）同样依赖它；
- **入站**剥离上游 `Set-Cookie`（不得把上游会话泄给浏览器），并注入 `Content-Security-Policy: frame-ancestors <控制台 origin>`；
- SPA fallback：上游 404 且请求非静态资源时回退到上游 `/`，保持前端路由可达。

「剥离 `Set-Cookie`」仅指入站方向，与「出站注入会话」不矛盾，二者不可混为一谈。

### 2.2 envDefinitions（键的 owner 唯一，宿主不得重复声明）

| 键 | 类型/默认 | secret |
|---|---|---|
| `WORKFLOW_V2_UPSTREAM_BASE_URL` | string，默认 `http://127.0.0.1:18080` | 否 |
| `WORKFLOW_CANVAS_UPSTREAM_URL` | string，默认 `http://127.0.0.1:18080` | 否 |
| `WORKFLOW_V2_PLATFORM_ACCOUNT_EMAIL` | string 必填 | 否 |
| `WORKFLOW_V2_PLATFORM_ACCOUNT_PASSWORD` | string 必填 | 是 |
| `WORKFLOW_V2_TICKET_SECRET` | string 必填（min 1） | 是 |
| `WORKFLOW_V2_IFRAME_CODE_TTL_SECONDS` | number，默认 60 | 否 |
| `WORKFLOW_V2_IFRAME_TICKET_TTL_SECONDS` | number，默认 900 | 否 |
| `WORKFLOW_V2_UPSTREAM_TIMEOUT_MS` | number，默认 10000 | 否 |
| `WORKFLOW_V2_NODE_WHITELIST` | string，默认见 §5 | 否 |
| `WORKFLOW_V2_RECONCILE_INTERVAL_SECONDS` | number（非负），默认 300；`0` = 禁用对账 | 否 |
| `WORKFLOW_V2_BFF_RATE_LIMIT_PER_MINUTE` | number（正），默认 1200；画布透传按票据 `sub` | 否 |
| `WORKFLOW_V2_SESSION_RATE_LIMIT_PER_MINUTE` | number（正），默认 60；票据端点按 `sub`、无票按来源地址 | 否 |

上表十二枚（4A/4B 前为九枚）均声明 `restartRequired: true`：装配期投影固化进模块配置，改值需重启进程。`reconcileIntervalSeconds = 0` 是唯一被接受的「关闭」取值（schema 用 `nonnegative`）；两个限流键是 `positive`（不接受 0）。

配置投影：`getWorkflowV2Config()` 从模块 `config.ts` 读取（宿主经 `module-configs.ts` 投影 `workflowV2: {...}`，路线 A，与 workflow 模块同形）。

## 3. 数据模型（`db/schema.ts`，Drizzle + PostgreSQL）

| 表 | 字段（全部 snake_case 列名） |
|---|---|
| `workflow_v2_platform_account` | `id` pk、`platform_user_id` text unique、`platform_space_id` text、`email` text、`status` text（`active`/`degraded`）、`last_login_at`、`last_probe_at`、`last_error` text、`created_at`、`updated_at` |
| `workflow_v2_org_app` | `id` pk、`organization_id` text unique、`app_id` text unique、`name` text、`status` text、`created_at`、`updated_at` |
| `workflow_v2_workflow` | `id` pk（uuid）、`organization_id` text、`upstream_workflow_id` text unique、`app_id` text、`name` text、`owner_user_id` text、`visibility` text default `'private'`、`published_version` text、`sync_state` text default `'active'`（`active`/`pending_delete`）、`deleted_at`、`created_at`、`updated_at`；索引 `(organization_id, deleted_at)` |
| `workflow_v2_audit_log` | `id` pk、`organization_id`、`actor_user_id`、`action`、`upstream_workflow_id`、`request_id`、`result` text、`error_code` text、`created_at`；索引 `(organization_id, created_at)` |

迁移：`drizzle.config.ts` 的 `schema` 数组追加本包出口 → `bun run db:generate --name workflow-v2-init` → 审查 → `bun run db:migrate`。

## 4. 服务签名（跨任务共享的内部契约）

```ts
// src/server/config.ts
export interface WorkflowV2Config {
  upstreamBaseUrl: string; canvasUpstreamUrl: string;
  accountEmail: string; accountPassword: string;
  ticketSecret: string; codeTtlSeconds: number; ticketTtlSeconds: number;
  upstreamTimeoutMs: number; nodeWhitelist: string[];
}
export function getWorkflowV2Config(): WorkflowV2Config;

// src/server/services/upstream-session.ts（1B）
export interface UpstreamSession {
  /** 返回可用的上游 Cookie 头（`session_key=...`）；失效时单飞重登。 */
  ensureCookie(): Promise<string>;
  /** 主动失效（收到上游鉴权失败时调用）。 */
  invalidate(): void;
  /** 轻量探活；false 表示会话不可用（不重登）。 */
  probe(): Promise<boolean>;
}
export function getUpstreamSession(): UpstreamSession;

// src/server/services/upstream-client.ts（1B）
export interface UpstreamCallInput {
  path: string;                      // 以 /api/ 开头
  method?: "GET" | "POST";
  query?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}
export interface UpstreamCallResult { status: number; body: unknown }
/** 单次上游调用（不含重试）；鉴权失败自动 invalidate + 重登 + 重放一次。 */
export async function callUpstream(input: UpstreamCallInput): Promise<UpstreamCallResult>;
/** 上游会话失效的唯一业务码。实测：HTTP 200 + `{"code":700012006}`，不是 401。 */
export const UPSTREAM_AUTH_FAILED_CODE = 700012006;
/** 上游 panic 业务码：响应体含 Go 堆栈，**透传前必须剥离**（见 §6）。 */
export const UPSTREAM_PANIC_CODE = 777777775;
```

**鉴权失败判定（P0-2 实测，见设计 §9.1.1 第 1 条）**：仅 `HTTP 401`（完全无 Cookie）或 `body.code === 700012006`（键非法/被踢/过期）算会话失效，两者都触发 `invalidate()` + 单飞重登 + 重放一次。
`400`（缺参数）与 `777777775`（上游 panic）**不得**计入鉴权失败，否则参数错误会触发重登风暴。

```ts
// src/server/services/iframe-ticket.ts（1C）
export interface TicketClaims {
  typ: "wf-canvas"; sid: string; sub: string; org: string; wf: string;
  iat: number; exp: number; jti: string;
}
export function issueCode(input: { userId: string; orgId: string; workflowId: string }): { code: string; expiresIn: number };
export function redeemCode(code: string): { ticket: string; expiresAt: number; claims: TicketClaims } | null;
export function verifyTicket(ticket: string): TicketClaims | null;
export function revokeSession(sid: string): void;

// src/server/services/node-scope.ts（2C）
/** 过滤节点面板响应中的所有节点列表字段；保持响应其余结构不变。 */
export function filterNodePayload(payload: unknown, endpoint: string): unknown;
export function isNodeAllowed(type: string): boolean;

// src/server/services/workflow-registry.ts（2B）
export interface WorkflowRecord {
  id: string; organizationId: string; upstreamWorkflowId: string; appId: string;
  name: string; ownerUserId: string; visibility: string;
  publishedVersion: string | null; syncState: "active" | "pending_delete";
}
export function findWorkflowByUpstreamId(orgId: string, upstreamWorkflowId: string): Promise<WorkflowRecord | null>;
export function registerWorkflow(input: Omit<WorkflowRecord, "id" | "syncState" | "publishedVersion">): Promise<WorkflowRecord>;
export function softDeleteWorkflow(orgId: string, upstreamWorkflowId: string): Promise<void>;
```

## 5. 节点白名单（首版，**fail-closed 许可集**）

**语义**：`isNodeAllowed(type)` 当且仅当 `type` 命中许可集时返回 true；未命中的（含上游未来新增的未知类型）**一律滤除**。
理由：首版范围是「只要工作流部分」（设计 §1.3），必须 fail-closed —— 上游新增一个节点类型不该自动出现在我们的画布上；需要放行时改 `WORKFLOW_V2_NODE_WHITELIST` 即可，代价是显式的一次配置变更。

**默认许可集**：`1,2,3,5,8,11,13,15,18,20,30,31,45,58`
即 `Start,End,LLM,Code,If,Variable,Output,Text,Question,SetVariable,Input,Comment,Http,JsonStringify`。

**刻意排除**（各自都带外部依赖或越出首版范围）：
- `4` = **Api（插件节点）** —— 插件依赖插件运行时与鉴权体系，首版不做；
- `6,12,27,42,43,44,46` 数据集 / 数据库家族；
- `9` 子工作流、`21`/`28`/`19`/`29` 循环与批处理、`7`/`10`/`26` 长期记忆与其他状态节点、`14`/`16`/`17`/`23` 图像家族、`33–36` 触发器。

> ⚠️ **对 P0-2 的更正**：设计 §9.1.1 第 6 条把 `Api='4'` 记作「HTTP 节点」是**错的**。权威枚举 `frontend/packages/workflow/base/src/types/node-type.ts` 里 `Api='4'` 是插件/API 节点，`Http='45'` 才是 HTTP request 节点；2C 的实盘探测也确认 `4` 的模板名是 `Plugin`。按原名录入会把**插件模板与插件搜索组整体放行**。本表为准。

对照表（权威来源 `frontend/packages/workflow/base/src/types/node-type.ts`）：
`Start='1'`、`End='2'`、`LLM='3'`、`Api='4'`（**插件，排除**）、`Code='5'`、`Dataset='6'`、`If='8'`、`SubWorkflow='9'`、`Variable='11'`、`Database='12'`、`Output='13'`、`Text='15'`（文本处理）、`Question='18'`、`SetVariable='20'`、`Input='30'`、`Comment='31'`、`Http='45'`（HTTP request）、`JsonStringify='58'`、`JsonParser='59'`。

⚠️ **接口只认数字字符串**：`node_type` 返回 `{"node_types":["1","2"]}`，`node_template_list` 项形如 `{"type":57,"node_type":"57"}`。
`WORKFLOW_V2_NODE_WHITELIST` 环境变量**一律以逗号分隔的数字字符串**书写（默认值即上面那串）。
`4` 等被排除项不得出现在默认值里；`foo`/`text-process` 这类名称形式会被解析器忽略（保留原默认值），不再作为合法输入。

**过滤范围**：`filterNodePayload(payload, endpoint)` 覆盖 `node_type`（`data.node_types` / `sub_workflow_node_types` / `nodes_properties[].type` / `sub_workflow_nodes_properties[].type`）、`node_template_list`（`template_list[].node_type`，缺失时回退 `type`；`cate_list[].node_type_list`；`plugin_*_list[].node_type`）、`node_panel_search`（按组键映射家族后整组清空，组对象保留、`has_more` 撤为 false）。
形状不认识或端点未知时**原样返回**（返回原引用、零改写），宁可多露也不误伤。

## 6. 透传规则（`/workflow-canvas/bff/*`）

- 鉴权：`X-Fenix-Workflow-Ticket` 请求头；`verifyTicket` 失败 → 401 `{code: 401, msg: "ticket_invalid"}`（上游形状）。
- 归属：`claims.wf` 必须与显式 `workflow_id`/路径参数一致，且 `findWorkflowByUpstreamId(claims.org, wf)` 命中；否则 404。
- 身份字段白名单（客户端同名一律 strip）：`space_id`、`project_id`、`bot_id`、`owner_id`、`login_user_create`、`creator`、`operator`。POST 仅注入权威 `space_id` / `project_id`（App 上下文），GET 仅补 `space_id`；`bot_id` 是与 `project_id` 互斥的 Agent 上下文，只剥离、不注入。
- 响应：**原样回传** 上游 `{data, code, msg}`（含 status）；不包装。
- **限流（4B）**：超限是**真实 HTTP 429 + `Retry-After`（秒）**，不得用 401 或 200 表达——画布只在 401 时换票，429 落进它的普通失败分支正是要的语义；做成 401 会让它去换一张同样被限的票，做成 200 会被当成业务错误。维度：透传面按票据 `sub`（`WORKFLOW_V2_BFF_RATE_LIMIT_PER_MINUTE`，默认 1200）；免票的 `session/exchange` 与无有效票据的 `refresh`/`revoke` 按来源地址（`WORKFLOW_V2_SESSION_RATE_LIMIT_PER_MINUTE`，默认 60）——那里没有 `sub` 可用，而反代之后按来源限流会误伤共享同一入口 IP 的其它用户。桶住在进程内，多副本下实际阈值 ≈ 配置值 × 副本数（全局阈值归部署层）。
- 允许的透传路径前缀（三条，均需 ticket 鉴权与归属校验）：
  1. `/api/workflow_api/`
  2. `/api/common/upload/`（画布图片/附件上传；P0-2 实测见设计 §9.1.1 第 5 条）
  3. `/api/playground_api/get_imagex_url`（图片 URL 换取）
- **按需放行的只读元数据端点（三条，2026-09-30 增补；精确匹配，不得扩成前缀）**：画布首屏会调、
  且不落在上面三条前缀里，实测直连上游回 200、经本面被 fail-closed 挡成 404：
  1. `POST /api/bot/get_type_list`（节点/类型清单，`data.model_list`）
  2. `POST /api/memory/variable/get_meta`（工作流变量元数据）
  3. `POST /api/passport/account/info/v2/`（账号信息）
  口径：**方法 + 完整路径全等匹配**（`classifyUpstreamPath` 的 `metadata` 分类，仅 POST），
  `space_id`/`project_id` 注入、`bot_id` 剥离、panic 脱敏、直链改写、限流、归属复核一律照旧。**不得**按
  `/api/passport/`、`/api/memory/`、`/api/bot/` 前缀放行——那是三个完整上游命名空间，远超首屏所需。
  移除条件：上游把它们并进 `/api/workflow_api/`，或画布不再需要。
- 其余一律 404。
- **上游 panic 响应必须脱敏后再回传**：上游在参数缺失时返回 `HTTP 200 + code 777777775`，`msg` 里带 Go 调用栈、绝对路径与内部函数名。BFF 命中该码时把 `msg` 替换为固定文案（如 `"upstream rejected the request"`）并只保留 `code`，原始堆栈只进服务端日志（且日志同样不得外泄给客户端）。
- **时间戳不做单位换算**：`workflow_list` 的 `create_time`/`update_time` 与 `/v1/workflow/get_run_history` 的 `create_time` 是**秒**，`list_spans` 的 `start_at`/`end_at` 是**毫秒**（IDL 明示）。透传原样，仅 workflow-v2 自建查询窗口时按端点区分，并用测试固化（设计 §9.1.1 第 4 条）。
- **图片/附件直链需改写**：`sign_image_url` 与 `get_imagex_url` 返回的是存储服务（MinIO）预签名**内网直链**，host 不是上游自身，浏览器经 `/workflow-canvas/*` 无法到达。首版策略见 §6.1。

## 6.1 图片与附件直链（首版策略）

上游返回的 URL 指向存储服务（`127.0.0.1:9000` 之类的 MinIO 内网地址），浏览器不可达。首版采取**最小必要**的两步，不做通用 URL 重写框架：

1. `WORKFLOW_CANVAS_UPSTREAM_URL` 之外新增存储域的反代前缀 `/workflow-canvas/storage/*` → 上游存储地址，仅允许 GET/HEAD，响应剥离 `Set-Cookie`。
2. 透传响应在写回浏览器前，把响应体中**已知字段**（`sign_image_url`/`get_imagex_url` 的 URL 值、`url`/`icon_uri` 等）的存储 origin 替换为 `/workflow-canvas/storage`。替换只针对固定已知 origin 前缀，不做正则泛化，避免误伤。

⚠️ 该替换属于「无法只靠透传解决」的例外交付；实现时必须在代码注释里写明原因与移除条件（上游若能配置对外存储域即可删除）。

## 6.2 调试运行轮询预算（`get_process`，3A 落地口径）

画布的整个调试运行靠对 `GET /api/workflow_api/get_process?execute_id=…` 的**客户端轮询**驱动
（上游侧 `workflow-run-service.ts` 的 `loop()`，`LOOP_GAP_TIME = 300ms`，无上限递归）。请求全部经本 BFF，
因此预算必须落在服务端：

- **形态是「合并」不是「限流」**：画布把调试运行期间的任何非成功响应当作运行失败（`systemError` 并终止轮询），
  `429` 会让用户的调试凭空失败。回放同一次成功响应不改变任何调用的语义，是唯一安全的省请求手段。
- 窗口 `GET_PROCESS_CACHE_TTL_MS = 300ms`，**只在写入时计时、读命中不续期**（滑动窗口会让持续轮询永不刷新，
  用户再也看不到状态变化）；只写成功响应（2xx 且 `code === 0`），失败不落缓存。
- 键是 `组织 + \u0000 + execute_id`；同键在飞行期间共享同一个 Promise。条目上限 256，超标即按插入序淘汰。
- 预算是**在全部安全门之后**接入的（白名单 → 票据 → 显式身份 → 本地注册表 → 租户绑定），命中缓存不会绕过任何一道门。

已知残留（不在本期解决，登记以免被当成缺陷重复排查）：

- 窗口取「≤ 轮询间隔」是刻意的：它**不指望命中同一轮询者的相邻两次请求**（间隔 ≈ 300ms + 上游往返，必然超过窗口）。
  收益来自同一 `execute_id` 上的**多轮询者相位错开**与并发合并；若将来画布收敛成单轮询者，需要把窗口提到略大于
  间隔才有效，代价是状态滞后突破一个周期——那是新取舍，不要顺手改。
- 进程内缓存：多副本部署时各副本各自持有，省下的比例按副本数稀释（正确性不受影响）。
- 只覆盖 `get_process`。`list_spans` / `get_node_execute_history` / `list_publish_workflow` 等高频读未覆盖，
  其中 `get_node_execute_history` 调用量随节点数放大，是下一个候选（其键需要扩展 `node_id`）。

## 7. 票据协议（与上游侧前端改造对齐）

- 一次性 code：`POST /web/workflow-v2/iframe-code`（控制台会话鉴权）→ `{ code, expiresIn }`；60s 单次消费，绑定 user+org+workflow。
- 兑换：`POST /workflow-canvas/bff/session/exchange { code }` → `{ ticket, expiresAt, claims }`；`{data, code, msg}` 形状。
- 刷新：`POST /workflow-canvas/bff/session/refresh`（header 票据）→ 新票据（≤ 原过期时间与 15 分钟较小者）。
- 撤销：`POST /workflow-canvas/bff/session/revoke`（宿主调用，header 票据）。
- 画布→宿主 postMessage：`{ v: 1, id, type, ts, payload }`；type ∈ `ready|bind|bound|refresh-request|token|navigate-out|error|resize|theme|locale|ping|pong`。宿主→画布：`bind|token|theme|locale|signout`。父→子固定 `targetOrigin` 为控制台自身 origin；子→父校验 `event.origin`。

**`bind` / `token` 的 payload 字段**（1F 已实现，双方对齐）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `apiBase` | string | API 基址，生产为 `/workflow-canvas/bff`；也接受同名的 iframe URL 参数。拒绝协议相对地址（`//host`） |
| `code` | string | `bind` 专用：一次性兑换码（60s，单次消费） |
| `ticket` | string | `token` 专用：换来的票据 |

**票据头与刷新触发口径**（两边必须一致，否则静默失效）：

- 请求头名固定 `X-Fenix-Workflow-Ticket`。
- 画布侧**只在 `error.response.status === 401` 时**触发 `refresh-request`。因此 BFF 的票据失败**必须是真实 HTTP 401**（§6 已如此规定）；若改成 `HTTP 200 + {code:401}` 会走业务错误分支，永不换票。
- 画布侧换票等待上限 10s（`host-bridge.ts`）；宿主换票慢时应由宿主侧缩短链路，而非放宽画布超时。
- `bind` 可能被宿主按 500ms 重试下发同一 `code`，画布侧必须**幂等**：已持有票据时直接回报 `bound {ok:true}`，不重复兑换。

**宿主页采用的握手路径（1I 落地口径，`bind` 与 `token` 二选一）**：

宿主页走 **`token`** 路径，不走 `bind`：宿主先 `POST /web/workflow-v2/iframe-code`（控制台会话）取 code，紧接着自己调 `POST /workflow-canvas/bff/session/exchange { code }`（兑换端点免票）换票，再以 `token { apiBase, ticket, expiresAt }` 下发画布。

理由是票据的**持有方决定续期与撤销能力**：`bound` 的载荷只有 `{ ok, expiresAt }`（1F 实测），票据若留在画布侧，宿主既无法在 `refresh-request` 时调 `session/refresh`，也无法在卸载/切组织时调 `session/revoke`（两者都要 `X-Fenix-Workflow-Ticket`）。走 `token` 后票据同时在宿主内存里，两条链路都在宿主侧闭环。

`bind` 仍是画布侧支持的兼容路径（宿主若坚持用它，续期只能重新签发 code 再 `bind`，撤销则完全不可达），因此画布侧对两者的处理都必须保留。

**iframe URL 参数**（宿主页拼、画布侧读，见设计 §5.2）：`workflow_id`、`space_id`、`apiBase`、`lng`、`theme`。宿主页直接拼上游认识的名字，不自造 `wf`/`view`/`locale`。

**宿主页的入参来源（1I 补充，2026-09-29）**：

- `workflow_id` 取宿主路由 `/agent/workflow/$id/edit` 的 `$id`，该参数就是 **上游 workflow ID**（= `iframe-code` 的 `workflowId` = 票据 `claims.wf` = 透传请求里的显式 `workflow_id`；服务端没有「本地 id → 上游 id」的查询端点，列表页链接必须直接带上游 id）。
- `space_id` 取 `GET /web/workflow-v2/platform-account` 的 `spaceId`（平台个人空间，设计 §4.3/§4.5）；`GET /web/workflow-v2/org-app` 只提供绑定就绪度（`appId` / `status`，其 `appId` 是 `project_id` 而非空间）。取不到空间 ID 时宿主页**不拼 URL**、停在「上游未就绪」降级态。该字段的缺口已于 2026-09-29（任务 3E）闭合：`platform-account.ts` 改为读平台账号台账 `workflow_v2_platform_account`（`findPlatformAccount()`），**未引导账号**（台账无行）如实回 `null`、画布页据此走 `space-missing`；**读库失败**返回 500 而不降级为 `null`，画布页走 `probe-failed`，两种状态因此可区分（静默回 `null` 会让「DB 不可用」与「尚未引导」表现成同一个死局）。
- `lng` / `theme` 只经 URL 参数下发，宿主页**不发** `theme` / `locale` 消息：控制台全局强制亮色、无即时切换能力，首屏一次性的取值放在 URL 里即可。

## 8. 验证命令（每个任务的完成门槛）

- 后端任务：`bun test packages/resources/workflow-v2/src/__tests__/<file>.test.ts`（新增测试），必要时 `bunx tsc --noEmit -p packages/resources/workflow-v2/tsconfig.json`。
- 骨架/迁移：`bun run generate:module-registry`、`bun run generate:web-contributions`、`bun run db:generate`、`bun run db:migrate`。
- 前端任务：`bun run build:web`。
- 全局门禁（收尾批次）：`bun run precheck`。
