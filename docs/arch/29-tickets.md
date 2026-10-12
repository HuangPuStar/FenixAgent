# 工单模块架构（tickets）

> 状态：实现基线（2026-10-12；评论、指派、标签、关闭重开与事件同步未实现，逐条列在 §10）
> 范围：`@fenix/resource-tickets` 的定位与依赖方向、五张表与所有权、协议面、授权落点、项目开通、身份头、幂等与 202 语义、可选装配与已知偏离。
> 定位：本文是 `packages/resources/tickets` 的实现基线，只描述已落地的事实；仓库与 Issue 的事实源在 Forgejo，本模块只持有 AOS 侧的索引、归属与操作账本。
> 约定：代码演进偏离本文档时，先更新文档再改代码。运维步骤（启用、开通、关闭与排障）见 [工单运维说明](../operations/tickets.md)，公共 Git 的契约与安全边界见 [公共 Git 模块架构](./28-common-git.md)。

## 0. 硬边界

1. **事实源在 Forgejo**：仓库、Issue、评论、标签与附件由托管平台持有，工单正文与评论全文不落 AOS 表。AOS 侧只有五张表（§3）：项目、操作账本、消息归属、查询索引与通知。
2. **显式 `projectId`**：全部工单资源 URL 都带项目 ID，默认项目只决定首页上下文与创建落点。历史链接不随默认项目切换而漂移。
3. **跨组织与不存在同形 404**：读取一律经受控查询，谓词只匹配 actor 的当前组织；不存在、跨组织、成员关系已被移除三种情况给同一个 404，不给资源 ID 留探测面。
4. **默认关闭即零副作用**：默认 profile `ce.json` 不含 tickets，进程不装配模块、不注册路由、不建定时器、不出站请求。前端也没有入口，手工输入地址显示「未启用」且不发请求（§8）。
5. **敏感边界**：错误与日志不得出现 token、凭据或正文全文；账本里的待发送正文在成功或明确失败后立即改写为摘要。

## 1. 定位与依赖方向

包 `packages/resources/tickets`（`@fenix/resource-tickets`），manifest `id: "tickets"`、`kind: "resource"`、`dependsOn: ["git"]`、`capabilities: ["resource.tickets"]`。

`dependsOn` 是**必需**装配边：profile 声明了 tickets 却没有 git 时，装配在产生任何副作用前失败。反向不存在——git 不依赖 tickets、不理解工单与通知语义，反写会构成装配环。

依赖全部由注入方提供：授权经 `AccessControlModule`（`accessControl` / `scopeStore` / `authorizedQuery`）、仓库与 Issue 经 `GitService`（管理动作走 `git.admin`、日常读写走 `createScopedClient`）、展示名投影经 `IdentityDirectory`。包内不读 `process.env`，本版不声明任何 `envDefinitions`。

分层与文件地图（`route → Facade → Domain Service → Repository`）：

| 层 | 文件 | 职责 |
|---|---|---|
| 协议适配 | `src/server/routes/web/*` | 七条路由只做参数校验、取主体与状态码/信封映射，不解释组织、角色或项目状态 |
| 应用 Facade | `src/server/facades/*` | 授权判定（404/403 的唯一落点）、协议视图组装、项目开通编排 |
| 领域服务 | `src/server/services/*` | 幂等裁决、身份头读写、作者核验、内容指纹、失败分类；不接收 `ActorContext` |
| 仓储 | `src/server/repositories/*` | 受控查询与写原语、事务内咨询锁；不做领域裁决 |
| 资源注册 | `src/server/access/ticket-project-resource.ts` | `ticket_project` 的动作声明与存储绑定 |
| 存储 | `db/schema.ts` | 五张表的唯一定义处（经 `@fenix/resource-tickets/db` 出口） |
| 浏览器面 | `web/**` | API 建模、页面、hook、i18n；不得 import 服务端出口 |

## 2. 接口面

统一走宿主的 `/web` 聚合实例（包内路径不写 `/web` 前缀）：成功 `{ success: true, data }`，失败 `{ success: false, error: { code, message } }`。

| # | 方法 / 路径 | 请求 | 成功 | 失败 |
| --- | --- | --- | --- | --- |
| 1 | `GET /ticket-projects` | 无参数 | 200 `{ projects, defaultProjectId, state }` | 401 |
| 2 | `POST /ticket-projects/default` | 头 `Idempotency-Key`；body `{ connectionId, mode, repository }` | 200 `{ project, operation }` 或 202 `{ operationId, status: "uncertain" }` | 400/403/404/409/503 |
| 3 | `PATCH /ticket-projects/default` | body `{ defaultProjectId?, status? }`（至少一项） | 200 项目总览 | 400/403/404/409 |
| 4 | `GET /tickets/:projectId` | query `q / state / assigneeId / labelId / cursor / limit` | 200 `{ items, nextCursor }` | 400/404/503 |
| 5 | `POST /tickets/:projectId` | 头 `Idempotency-Key`；body `{ title, body }` | 201 `{ ticket, operationId }` 或 202 | 400/403/404/409/503 |
| 6 | `GET /tickets/:projectId/:number` | 路径 `number` 为正整数串 | 200 `{ ticket }` | 400/404/503 |
| 7 | `GET /ticket-operations/:operationId` | 路径 `operationId` 为 uuid | 200 `{ operation }` | 400/404 |

要点：

- **错误映射只有一处**（`routes/web/web-error.ts`）：`404` = 不存在或不可见，`403` = 角色不足或上游明确拒绝，`409` = 幂等冲突 / 仓库归属冲突 / 版本冲突，`503` = 暂停、上游不可用或绑定不可写。未命中映射表的异常原样上抛，交宿主兜底 500，不伪装成协议错误。
- **幂等键**只用在两条写路径上：缺失与格式非法分别返回 `IDEMPOTENCY_KEY_REQUIRED` / `IDEMPOTENCY_KEY_INVALID`（400）；`PATCH` 是事务内本地变更，不受它保护。
- **列表只读索引**：按工单号倒序，游标是本页末条工单号，`limit` 默认 30、上限 100；`q` 只匹配标题，`labelId` 按集合包含匹配。索引未同步到最新时行级 `syncStatus` 为 `stale`，页面据此提示而不拦截。
- **详情回源**：正文从 Forgejo 读取并剥离身份头，作者归属经归属账本核验；上游不可用报 503，绝不返回空正文或伪装 404。
- **操作查询只认本人**：仅操作的发起者可查，其余（含管理员）与不存在同形返回 404。

## 3. 五张表与所有权

五张表定义在 `packages/resources/tickets/db/schema.ts`（唯一 owner，经 `@fenix/resource-tickets/db` 出口），迁移为 `drizzle/0034_tickets-tables.sql`；`drizzle.config.ts` 必须同时声明本文件与其余 owner schema。

| 表 | 职责 | 关键约束 |
|---|---|---|
| `ticket_projects` | 一个组织在一个仓库绑定上的工单空间 | `repository_ref` 唯一；每组织仅一条 active 默认（部分唯一索引，`where is_default AND status = 'active'`）；`status` 为 `active` / `paused` |
| `ticket_operations` | 幂等与 202 的唯一真相：声明、领取、终态 | `UNIQUE(organization_id, actor_id, idempotency_key)`；`(status, updated_at)` 调度索引 |
| `ticket_messages` | 远端对象 ↔ AOS 作者：身份头可信性的判定依据 | `UNIQUE(project_id, object_kind, provider_object_id)`；`message_id` 唯一 |
| `ticket_index` | 列表数据源；详情不回填它 | `UNIQUE(project_id, issue_number)`；`(project_id, state, issue_number)` 索引 |
| `ticket_notifications` | 站内通知（表已建，写入与读取未实现） | `UNIQUE(recipient_id, event_key)` |

口径：

- **跨包外键只有一处**：`ticket_projects.repository_ref → git_repository_bindings.id`（`onDelete: "restrict"`），在 `db/**` 组装期导入 `@fenix/git/db`，不进 `dependsOn`。
- **不建身份外键**：`author_id` / `assignee_id` / `recipient_id` / `last_editor_id` 都是 `text`——作者归属是审计证据，负责人是离职后仍要展示的业务字段，数据库级 `set null` / `cascade` 都会丢事实。
- **外部数字 ID 一律字符串**：`issue_number` 与 `provider_object_id` 用 `varchar`，与 `@fenix/git` 的领域类型一致（Forgejo 的 int64 超过 2^53 后 JS number 不再精确）。
- **迁移纪律**：改 schema 后 `bun run db:generate --name <module>-<change>` → 审查 `drizzle/*.sql` 与 `drizzle/meta/*` → `bun run db:migrate`。禁止手写 SQL——部分唯一索引必须写在 schema 里，否则不进 snapshot。

## 4. 授权与租户边界

资源注册在 manifest 的 `accessControlBindings`：`resourceType: "ticket_project"`、`ownershipMode: "organization"`、`actions: ["read", "create", "update"]`（无 `delete`，项目只暂停不删除）、`memberDefaultActions: ["read"]`、`publicDefaultActions: []`。存储只声明归属列 `organizationId`、不声明平台受众 `visibility`，范围因此恒为 private、永不跨组织可见。

三处判定，全部经 `AccessControlModule`，包内不写第二套谓词：

1. **读取**（项目与工单的读写前置）：`listConstraint(actor, "read")` + 平台编译的受控查询；不存在、跨组织、成员关系已移除都是同一个 404。
2. **管理动作**：开通走 `resolveInitialScope`、切换默认与暂停走 `authorizeAction`；组织 `owner` / `admin` 拿到全部动作，`member` 只有 `read`，拒绝转成对外 403。跨组织目标在解析阶段就是 404，两种状态码互不合并。
3. **操作账本**：`findForActor` 只按操作的 actor 与当前组织匹配，其余一律 404。

「能读项目 ⟺ 能读写该项目下的工单」由上面第一条固定：工单本体不是受控资源行，项目可见性就是工单可见性。暂停只停写——项目 `paused` 时创建工单报 503 `TICKETS_PAUSED` 且不产生任何上游调用，列表与详情照常可用。

## 5. 项目开通（`POST /web/ticket-projects/default`）

两种模式：`create` 在当前凭据账号下建私有仓库并开启 Issues；`bind` 绑定既有仓库，先按 `owner/name` 回源解析坐标（请求体自报的外部数字 ID 一律不采信）。

**owner 口径**：请求里的 `owner` 不是授权依据，只是向 Git 服务声明的目标账号。`create` 会回读创建响应的 owner，与请求声明不一致时当场失败（400 `GIT_OWNER_MISMATCH`）且不落库；`bind` 以「当前凭据能访问该仓库」为前置，查询不通过即拒绝。

编排顺序不可调换：

1. **先声明幂等再出站**：远端调用之前先在账本落 `pending` 行，否则崩溃会留下「远端建了仓库、本端一无所知」的孤儿。
2. **外部调用在事务与锁之外**：建仓库可能耗时十几秒，不占着连接池里的连接去等它（理由见 §9）。
3. **成功终态与项目写入同一事务**：项目行、默认切换、`succeeded` 三件事要么全成要么全不成。

其余口径：

- **预留仓库名是确定函数**：`aos-tickets-<组织归一化后缀>`（组织 ID 全是符号时退化为 sha256 前缀），恢复核对要据此推断「本该建哪个仓库」。
- **失败收敛三分**：上游确定拒绝 → 写 `failed` 并抛出同一个对外错误（同键重放还原该错误、不再触远端）；`WRITE_UNCERTAIN` → 写 `uncertain` 并返回 202；其余异常（编程错误、本地 DB 故障）不改状态、保持 `dispatching` 上抛。
- **绑定授权一次给全**：`allowedConsumers.tickets` 声明 `repositories.read`、`issues.read/write`、`comments.read/write`、`labels.read/write`；名字是持久化契约，改名不是报错而是静默收回授权。
- **日常凭据与初始化凭据分离**：绑定固定引用受限服务账号 `{env:AOS_GIT_SERVICE_TOKEN}`，建仓库用的初始化凭据绝不进绑定记录。
- **冲突不接管**：同名仓库已存在但归属未确认、或绑定已归别的组织时报 409 `REPOSITORY_ALREADY_BOUND`，唯一出路是显式 `bind`。

## 6. 身份头与作者核验

写入时生成 `aos` YAML 块并置于正文顶部：`schema: 1`、`organization_id`、`message_id`、`author.id/name`（snake_case 线格式）。`message_id` 形如 `msg_<uuid>`，在幂等声明时生成并落库，进程崩溃后的同键重试沿用同一个。

解析一律 **fail closed**，只认第一个顶层身份头：

- 头部块超过 8 KiB 直接判 `too_large`，在喂解析器之前按字节判定。
- YAML 走注入的 js-yaml@5 + `JSON_SCHEMA`：标量收敛到 JSON 类型、自定义标签与重复键报错、禁别名、嵌套深度上限 6。
- 未闭合的 `---` 块判 `missing` 且不调用解析器，正文照常展示。
- 任何一步失败都返回 `header = null`，绝不向调用方抛异常（`reason` 是唯一信号）。

**核验口径**：身份头、`ticket_messages` 归属记录、正文摘要（`sha256`，规范化正文）与组织四处同时吻合才算 AOS 作者；作者 ID 与显示名取归属记录，不取头部自填值。对不上号即按 `external` 处理，展示名取托管平台账号名——那是真实执行写入的账号，伪造不了。

业务上限集中在 `src/server/services/ticket-limits.ts`（协议层与写入路径共用一份）：标题 200 字符、正文（含身份头的最终 UTF-8 串）64 KiB、列表默认 30 / 上限 100、幂等键 8–128 位 URL 安全字符。标签 20、负责人 1、附件 10 MiB × 5 是已裁定的上限，留给未实现路径使用。

## 7. 幂等、版本与 202

两条写路径（`issue.create` 与 `project.provision`）共用 `ticket_operations` 状态机；`begin` 的裁决顺序即优先级：

1. 同键不同 `requestHash` → 409 `IDEMPOTENCY_CONFLICT`（既有操作不能被覆盖）。
2. `succeeded` → 重放既有结果，不再触碰远端。
3. `failed` → 还原同一个对外错误（不重试）。
4. `dispatching` / `uncertain` / `needs_review` → 202（本端已有在途或未定的写入，绝不重发）。
5. `pending` → 条件更新领取；并发下只有一个执行者，领取失败同样 202。

**内容版本**是 `computeContentVersion` 的 sha256 指纹（前缀 `fenix.tickets.v1`，覆盖标题、剥离身份头后的正文、原生状态与按名排序的标签），不依赖秒级时间戳。本版只计算并随 201 与详情返回 `version`；编辑/评论路径的 `expectedVersion` 与 409 `VERSION_CONFLICT` 判定尚未实现。

**202 语义**：`{ operationId, status: "uncertain" }` 表示「上游写入结果未定」或「已有在途写入」，**不**是失败、**不**自动重放。产生条件有三：适配器抛 `WRITE_UNCERTAIN`（超时、连接中断、2xx 但响应体不可解析）；同一幂等键的并发或崩溃残留使操作停在 `dispatching`；上游已成功但本地终态事务失败（重试时表现为前者）。前端据此显示持久「提交结果确认中」提示与手动刷新入口，不轮询。

## 8. 装配与前端

| 配置 | `resources` 增量 | `web` 增量 | 行为 |
|---|---|---|---|
| `deploy/assembly/ce.json`（默认） | 无 | 无 | 公共 Git 与工单都关闭，零出站请求 |
| `deploy/assembly/ce-git.json` | `git` | 无 | 只有公共 Git，工单路由全部 404 |
| `deploy/assembly/ce-tickets.json` | `git`、`tickets` | `tickets` | 工单可用；`web` 元素是 manifest 的 `web.id`，不是包名 |

- **两层开关不自动映射**：assembly profile 决定模块是否加载，`FENIX_FEATURE_GIT` 只决定 Forgejo 容器是否启动。关掉工单不等于可以停 Forgejo（其他消费者可能仍在用）。
- **bundle 是上界、运行期只能收窄**：工单页面要先用 `bun run generate:web-contributions --profile deploy/assembly/ce-tickets.json` 生成贡献、再 `bun run build:web` 构建；部署期换 profile 不会重新打包浏览器产物。运行期 `/web/system/modules` 的 `data.web` 不含 `tickets` 时，入口隐藏、`/agent/tickets/*` 被拦截。
- **前端落点**：列表 `/agent/tickets`、详情 `/agent/tickets/$projectId/$number`；筛选与分页是会话内状态，不落 URL，详情链接用显式 `projectId` 保证默认项目切换后依然稳定。导航项 id `tickets` 归 Shell 的 `config` 组，组内序号 110（组内 10–100 已被既有项占满，重复 `order` 会让 Shell 装配期直接抛错）。
- **关闭路径行为**：默认产物下，两个宿主薄路由在懒加载子树之前按 `useAssemblyCapabilities()` 判 `"tickets"`，未启用时不挂载页面、不发请求，展示与根守卫相同的「未启用」界面。服务端未装配时对应路由不存在（404），前端入口隐藏与后端 404 由同一份 `/web/system/modules` 对齐——「入口可见但服务端 404」或「服务端可用但入口被隐藏」都算缺陷。

## 9. 已知偏离

1. **advisory lock 不跨外部调用**（对设计方案「独立受限连接持锁、覆盖约 15 秒外部调用」的偏离）。理由：`DATABASE_URL` 只由宿主持有，包内无法自建第二条受限连接；而在共享业务连接池上按外部调用的时长占住一条连接，正是方案同一句禁止的行为。等价保护由三件事共同给出：`withTicketLock` 只覆盖事务内「读改写」这一段；`ticket_operations` 的 `pending → dispatching` 条件更新保证同一幂等键只有一个执行者；远端对象内嵌 `message_id`，后续恢复流程可据此回源核对。锁键只由 `src/server/repositories/advisory-lock.ts` 构造（组织级 `fenix:tickets:project:<orgId>` 已使用，工单级键为编辑/评论路径预留），并用 `pg_advisory_xact_lock` 让锁随事务释放，不给连接池留未释放的锁。
2. **关闭路径的守卫落点**：根守卫 `AssemblyRouteGate` 只按**构建期贡献条目**判定归属，默认 bundle 里没有 tickets 贡献，薄路由的归属判定返回 `undefined`，根守卫会放行。为满足「关闭时手工输入地址显示未启用且不发请求」，宿主在两个薄路由文件内各加了一层本地能力判定，未启用时不挂载懒加载子树（连 chunk 都不会去取）。这是临时落点：把「产物内存在薄路由但贡献缺席」的情形统一纳入路由边界是后续工作，完成前任何新增的同类薄路由都必须自带这层守卫。

## 10. 未实现清单

以下能力属于工单范围但**本版没有代码**，不要按已存在处理：

1. **评论、指派、标签管理与关闭重开**：没有编辑/评论路由；`ticket_messages.object_kind` 已预留 `comment`、`ticket_index` 已预留 `assignee_id` / `label_ids`、`expectedVersion` 与 `VERSION_CONFLICT` 已落地错误类，但缺版本冲突判定、评论的作者核验复用与标签同步。
2. **事件同步**：没有 Webhook 接收、事件去重、事件分发与投递消费，也没有按 `message_id` / 预留仓库名回源核对的自动恢复流程（`findByMessageId` 已预留）。列表目前只反映创建路径写入的索引行，`sync_status` 因此长驻 `ready`，`stale` 尚无写入方。
3. **附件与站内通知**：附件接口（上传、列表、下载）不存在；`ticket_notifications` 表已建，但没有写入与读取路径。
4. **控制台的管理面**：没有开通、切换默认、暂停的页面入口；本版的开通只能用管理员接口完成。
5. **初始化脚本**：`scripts/git-bootstrap.ts` 与 `bun run git:bootstrap` 不存在（公共 Git 侧同样未交付）；仓库绑定与项目只能经 `POST /web/ticket-projects/default` 由服务端创建。
6. **检索能力**：`q` 只匹配标题，评论全文检索与跨项目检索未实现。

## 11. 验证

- `packages/resources/tickets/src/__tests__/repositories.test.ts`：存储侧契约——授权条件如何到达 SQL、账本写了哪些列、部分唯一索引与外键声明。
- `packages/resources/tickets/src/__tests__/identity-header.test.ts`：身份头往返、线格式、大小与安全闸（别名、深度、未闭合块）。
- `packages/resources/tickets/src/__tests__/tickets-create.test.ts`：创建路径的幂等重放、202 分支、错误映射与降级。
- `packages/resources/tickets/src/__tests__/facades.test.ts`：授权 404/403、项目开通与默认切换、暂停语义。
- `apps/server/src/__tests__/tickets-assembly.test.ts`：装配面——三份 profile 的差集、缺 `git` 时在副作用前失败、默认 profile 零出站、`git` 先于 `tickets` 构造。
- `apps/web/src/__tests__/web-contributions.test.ts`：宿主侧贡献与 `tickets` 字典注册（漏登记的症状是文案整片回退成 key 回显）。
- `packages/resources/tickets/web/__tests__/`：浏览器面守卫（`tickets-browser-surface`：值导入图里不出现 `node:*`、`@server/*`、宿主别名，跨包说明符都能经对方 `exports` 解析，外部依赖白名单逐条登记）、字典自持（`tickets-i18n`）、写入结果判别与幂等键持有者（`ticket-write-outcome`）、列表与详情页的状态分支（`agent-tickets-page-states` / `agent-ticket-detail-states`：错误与重试、空态、未开通、行级 `stale` 降级）。

**未覆盖**：创建弹窗内的三条页面级断言（202 持久提示条与不跳转、201 跳转参数、空正文不发请求）。原因是 Radix 覆盖层在 `bun test packages/` 的同进程里不挂载（同批先加载过 `packages/ui-components` 的同类测试后，`@radix-ui/react-portal` 的挂载 effect 不执行，且不报错）；仓库既有做法是对 `config/FormDialog` 与 `ui/dialog` 开模块替身，本批未采用以免跨文件替身污染同进程的其它包测试。这三条行为目前由代码审查 + API 层断言（路径、`Idempotency-Key` 头、201/202 响应形状、`ticketFormSchema` 拒绝空正文）间接覆盖。
