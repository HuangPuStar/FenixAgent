# 工单模块架构（tickets）

> 状态：实现基线（2026-10-12）。**服务端已注册全部 19 条路由**：创建/列表/详情、工单修改（标题/描述/负责人/状态）、标签挂载、评论列表/创建/编辑、项目标签读取/新建/修改、可指派成员分页、附件上传/列表/下载、操作查询与单次恢复核对都已落地；在途互斥（409 `TICKET_OPERATION_PENDING`）与版本冲突（409 `VERSION_CONFLICT`）已由写路径真实产生。剩余缺口集中在**周期扫描、事件同步与站内通知**，以及评论倒序分页在上游不发 `Link` 头时的退化（§10 逐条列出）。
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
| 协议适配 | `src/server/routes/web/*` | 十六条路由只做参数校验、取主体与状态码/信封映射，不解释组织、角色或项目状态 |
| 应用 Facade | `src/server/facades/*` | 授权判定（404/403 的唯一落点）、协议视图组装、项目开通编排；授权的 403 收窄与管理员判定共用 `ticket-action-guard.ts` |
| 领域服务 | `src/server/services/*` | 幂等裁决、身份头读写、作者核验、内容指纹、失败分类、恢复核对；不接收 `ActorContext`。`ticket-permission.ts` 是动作权限矩阵的唯一实现处（纯函数，四个入口共用） |
| 仓储 | `src/server/repositories/*` | 受控查询与写原语、事务内咨询锁；不做领域裁决 |
| 资源注册 | `src/server/access/ticket-project-resource.ts` | `ticket_project` 的动作声明与存储绑定 |
| 存储 | `db/schema.ts` | 五张表的唯一定义处（经 `@fenix/resource-tickets/db` 出口） |
| 浏览器面 | `web/**` | API 建模、页面、hook、i18n；不得 import 服务端出口。评论、标签、成员与写路径按接口合同建模并已与服务端对齐（`web/api/*` 逐条对应 §2 的路由） |

## 2. 接口面

统一走宿主的 `/web` 聚合实例（包内路径不写 `/web` 前缀）：成功 `{ success: true, data }`，失败 `{ success: false, error: { code, message } }`。

| # | 方法 / 路径 | 请求 | 成功 | 失败 |
| --- | --- | --- | --- | --- |
| 1 | `GET /ticket-projects` | 无参数 | 200 `{ projects, defaultProjectId, state }` | 400/401 |
| 2 | `POST /ticket-projects/default` | 头 `Idempotency-Key`；body `{ connectionId, mode, repository }` | 200 `{ project, operation }` 或 202 `{ operationId, status: "uncertain" }` | 400/403/404/409/503 |
| 3 | `PATCH /ticket-projects/default` | body `{ defaultProjectId?, status? }`（至少一项） | 200 项目总览 | 400/403/404/409 |
| 4 | `GET /ticket-projects/:projectId/members` | query `q / page / pageSize` | 200 `{ items: [{ userId, name }], total }` | 400/404/503 |
| 5 | `GET /tickets/:projectId` | query `q / state / assigneeId / labelId / cursor / limit` | 200 `{ items, nextCursor }` | 400/404/503 |
| 6 | `POST /tickets/:projectId` | 头 `Idempotency-Key`；body `{ title, body }` | 201 `{ ticket, operationId }` 或 202 | 400/403/404/409/503 |
| 7 | `GET /tickets/:projectId/:number` | 路径 `number` 为正整数串 | 200 `{ ticket }`（含 `pendingOperationId`） | 400/404/503 |
| 8 | `PATCH /tickets/:projectId/:number` | 头 `Idempotency-Key`；body `{ expectedVersion, title?, body?, assigneeId?, state? }`（至少一项） | 200 `{ ticket, operationId }` 或 202 | 400/403/404/409/503 |
| 9 | `PUT /tickets/:projectId/:number/labels` | 头 `Idempotency-Key`；body `{ expectedVersion, labelIds }` | 200 `{ ticket, operationId }` 或 202 | 400/403/404/409/503 |
| 10 | `GET /tickets/:projectId/:number/comments` | query `cursor / limit` | 200 `{ items, nextCursor }`（时间倒序，首屏最新一页） | 400/404/503 |
| 11 | `POST /tickets/:projectId/:number/comments` | 头 `Idempotency-Key`；body `{ body }` | 201 `{ comment, operationId }` 或 202 | 400/403/404/409/503 |
| 12 | `PATCH /tickets/:projectId/:number/comments/:commentId` | 头 `Idempotency-Key`；body `{ body, expectedVersion }` | 200 `{ comment, operationId }` 或 202 | 400/403/404/409/503 |
| 13 | `GET /ticket-projects/:projectId/labels` | 无参数 | 200 `{ items }`（不翻页） | 400/404/503 |
| 14 | `POST /ticket-projects/:projectId/labels` | 头 `Idempotency-Key`；body `{ name, color?, description? }` | 201 `{ label, operationId }` 或 202 | 400/403/404/409/503 |
| 15 | `PATCH /ticket-projects/:projectId/labels/:labelId` | 头 `Idempotency-Key`；body `{ name?, color?, description? }`（至少一项） | 200 `{ label, operationId }` 或 202 | 400/403/404/409/503 |
| 16 | `GET /ticket-operations/:operationId` | 路径 `operationId` 为 uuid | 200 `{ operation }`（返回前对未定状态触发一次核对） | 400/404/503 |
| 17 | `GET /tickets/:projectId/:number/attachments` | 无参数 | 200 `{ items }`（附件视图，不含任何下载地址） | 400/401/404/503 |
| 18 | `POST /tickets/:projectId/:number/attachments` | 头 `Idempotency-Key`；multipart 单文件（字段 `file`） | 201 `{ attachment, operationId }` 或 202 | 400/401/403/404/409/503 |
| 19 | `GET /tickets/:projectId/:number/attachments/:attachmentId` | 路径 `attachmentId` 为正整数串 | 200 字节流（`Content-Disposition: attachment` + `nosniff` + `private, no-store`） | 400/401/404/503 |

上表是本版**全部**已注册路由（十九条，分六组注册函数：项目 1–4、工单 5–9、评论 10–12、标签 13–15、操作账本 16、附件 17–19）。写响应统一为 `{ ticket|comment|label|operation, operationId }`（202 只带 `operationId` 与 `status: "uncertain"`）；`GET` 类不写账本。

要点：

- **错误映射只有一处**（`routes/web/web-error.ts`），按错误自带的状态码判定：`404` = 不存在或不可见，`403` = 角色不足或上游明确拒绝，`409` = 幂等冲突（`IDEMPOTENCY_CONFLICT`）/ 仓库归属冲突 / 版本冲突（`VERSION_CONFLICT`）/ 在途未确认变更（`TICKET_OPERATION_PENDING`），`503` = 暂停、上游不可用、绑定不可写或核对时上游不可用。`GitError` 的 `WRITE_UNCERTAIN` 刻意不映射——它是「结果未定」，由 Facade 转成 202 分支。未命中映射表的异常原样上抛，交宿主兜底 500，不伪装成协议错误。
- **幂等键覆盖全部外部写路径**（`PATCH /ticket-projects/default` 除外：它是事务内本地变更，不触远端）：缺失与格式非法分别返回 `IDEMPOTENCY_KEY_REQUIRED` / `IDEMPOTENCY_KEY_INVALID`（400）；同键不同内容 409；同键同内容重放返回首次结果，不重发远端写入。
- **列表只读索引**：按工单号倒序，游标是本页末条工单号，`limit` 默认 30、上限 100；`q` 只匹配标题，`labelId` 按集合包含匹配。索引由创建与修改路径同步刷新（`assigneeId` / `labelIds` 会被写入），事件同步未实现因此仓库侧的直改仍不同步；索引未同步到最新时行级 `syncStatus` 为 `stale`，页面据此提示而不拦截。
- **详情回源**：正文从 Forgejo 读取并剥离身份头，作者归属经归属账本核验；上游不可用报 503，绝不返回空正文或伪装 404。返回的 `pendingOperationId` 是该工单上未终结的 `issue.update` / `issue.labels` 操作 ID（与写路径的在途互斥同谓词），非空即表示该工单的写入口应被禁用（§7）。
- **评论同样回源**：列表按时间倒序返回（首屏即最新一页，页内最新在前），作者归属核验口径与工单一致；评论视图带 `version`（评论内容指纹），编辑 `PATCH` 以它为 `expectedVersion`。倒序分页的机制与退化见 §9.4。
- **操作查询只认本人**：仅操作的发起者可查，其余（含管理员）与不存在同形返回 404；账本行仍在 `dispatching` / `uncertain` 时，返回前会执行一次回源核对（§7），核对失败报 503 而不是停留在「进行中」。
- **附件挂在工单上，内容只经本服务流转**：上传是 multipart **单文件**（一次请求 = 一次远端写 = 一个幂等键，多文件由前端拆请求），文件名由服务端归一（取基名、去控制字符、≤200 字符）；上游的大小上限与扩展名白名单拒绝（413/422）是**确定拒绝**，映射 400 并落 `failed` 账本，不升级为未定。响应视图只到 `attachmentId` 为止——上游内容地址带服务账号凭据，绝不发给浏览器；下载由本服务代理，归属校验只有一处（附件编号在该工单的元数据端点下读取，不属于即上游 404）。图片预览按扩展名判定（列表响应没有 MIME，为预览多发一次元数据请求不值当），缩略图的 `<img src>` 直接指向本服务下载端点（同源请求，复用会话鉴权，不必再造 fetch→blob 生命周期）；判定说错的两种情形都由 `onError` 与文件行兜住——不渲染缩略图，下载按钮照旧。

## 3. 五张表与所有权

五张表定义在 `packages/resources/tickets/db/schema.ts`（唯一 owner，经 `@fenix/resource-tickets/db` 出口），迁移 `drizzle/0033_common-git-tickets-tables.sql`（与公共 Git 四张表同批一次交付，含五张表、索引、约束与在途互斥的部分索引）；`drizzle.config.ts` 必须同时声明本文件与其余 owner schema。

| 表 | 职责 | 关键约束 |
|---|---|---|
| `ticket_projects` | 一个组织在一个仓库绑定上的工单空间 | `repository_ref` 唯一；每组织仅一条 active 默认（部分唯一索引，`where is_default AND status = 'active'`）；`status` 为 `active` / `paused` |
| `ticket_operations` | 幂等与 202 的唯一真相：声明、领取、核对记录、终态 | `UNIQUE(organization_id, actor_id, idempotency_key)`；`(status, updated_at)` 调度索引；`ticket_operations_inflight_idx` 为**部分索引**（`project_id, target_id, kind`，`where status NOT IN ('succeeded','failed')`），谓词与在途互斥的阻塞集合逐字一致，终态行不进索引 |
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

**动作级权限矩阵**（方案 §7）的唯一实现处是 `src/server/services/ticket-permission.ts`（纯函数，不做 IO）：正文改写（标题/描述）= 创建者或管理员；指派、关闭与重开 = 创建者、**当前负责人**或管理员；评论编辑 = 原作者或管理员；标签挂载与正文改写同规则（创建者或管理员）。管理员身份由 Facade 经 `AccessControlModule` 判定后传入，对象的作者 ID 只来自 `ticket_messages` 的归属核验结论——请求体与身份头里自填的 `user_id` 进不了判定，「来源不可信只有管理员能动」因此在类型层面成立（`authorId === null` 不等于任何 actor）。四个入口（工单 PATCH、标签挂载 PUT、评论 PATCH、评论列表的编辑入口提示）都已落地并共用这组函数；**项目标签 CRUD 是另一条规则**：它不比对资源归属，而是要求组织的 `owner` / `admin`（`ticket-label-facade.ts`），因为标签属于仓库级目录、不属于某个人。

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

**核验口径**：身份头、`ticket_messages` 归属记录、正文摘要（`sha256`，规范化正文）与组织四处同时吻合才算 AOS 作者；作者 ID 与显示名取归属记录，不取头部自填值。对不上号即按 `external` 处理，展示名取托管平台账号名——那是真实执行写入的账号，伪造不了。核验函数（`ticket-author.ts`）按「多条路径共用」抽出：调用方按「项目 + 对象类型 + 对象 ID」取归属行后传入；工单详情与评论列表/创建/编辑四条路径共用它，评论作者核验因此与工单同源（`ticket_messages.object_kind = "comment"` 已有读写方）。对象类型传错时对象 ID 与 `message_id` 会同时对不上，结论保守地落在 `external`。

业务上限集中在 `src/server/services/ticket-limits.ts`（协议层与写入路径共用一份）：标题 200 字符、正文（含身份头的最终 UTF-8 串）64 KiB、列表默认 30 / 上限 100、幂等键 8–128 位 URL 安全字符。T03 新增的一组常量都有消费方：评论列表默认 30（上限沿用 100）、项目标签名 1–50 与描述 ≤ 200、工单标签上限 20（协议层 `labelIds` 校验）、恢复核对的有界扫描上限 5 页 × 100 条、扫描窗口回拨 1 分钟、15 分钟的人工介入窗口（超过仍未找到匹配即转 `needs_review`，而不是继续全量回放）。T05 落地后附件常量已全部有消费方（10 MiB 在路由与领域服务各判一次，5 个是单次提交的组合规则）；仍无消费方的是负责人 1。

## 7. 幂等、版本与 202

八种写路径（`issue.create` / `project.provision` / `issue.update` / `issue.labels` / `comment.create` / `comment.update` / `label.create` / `label.update`）共用 `ticket_operations` 状态机；`begin` 的裁决顺序即优先级：

1. 同键不同 `requestHash` → 409 `IDEMPOTENCY_CONFLICT`（既有操作不能被覆盖）。
2. `succeeded` → 重放既有结果，不再触碰远端。
3. `failed` → 还原同一个对外错误（不重试）。
4. `dispatching` / `uncertain` / `needs_review` → 202（本端已有在途或未定的写入，绝不重发）。
5. `pending` → 条件更新领取；并发下只有一个执行者，领取失败同样 202。

`begin` 另有三个**可选**入参，T03 的写路径已全部使用：`targetId`（目标对象坐标，**领取时**写入账本——在途互斥要靠它在领取前认出「同一对象」，不能等成功后再补；工单域与评论创建传工单号，评论修改传评论 ID）、`lockKey`（互斥范围，缺省是组织级项目锁；编辑与评论路径传工单级锁键 `ticketsIssueLockKey`）、`guardKinds`（在途互斥组）。

**在途互斥**（「未确认变更阻止后续修改」）：同一对象上已有未确认的变更时，新的修改被拒绝，不给第二个写入者开出并行写路径。判定与「声明 + 领取」在**同一事务、同一把 advisory lock** 内完成，否则两个不同幂等键的并发请求会各自读到「无在途变更」并各自领取。阻塞集合是 `status NOT IN ('succeeded','failed')`——`needs_review` 也算在途（对象状态有歧义时继续写入正是要避免的行为），终态行永不参与。互斥组按对象域划分：工单域为 `issue.update` / `issue.labels`（`ISSUE_CHANGE_KINDS`），评论域为 `comment.update`（`COMMENT_CHANGE_KINDS`）；`issue.create` 与 `comment.create` **不在**组内（创建没有「同一对象的既有变更」，拉进来会让两次独立创建互相阻塞）。命中时抛 `TicketChangeInFlightError`，对外 409 `TICKET_OPERATION_PENDING`（前端据此走「先核对」而不是普通冲突）。查询走 §3 的部分索引。该 409 由三条写路径真实产生（工单 PATCH、标签挂载 PUT、评论 PATCH）；同键重试在裁决阶段就拿到 `replayed` / `in_flight`，不会被自己挡住。

**核对记录与恢复扫描**：远端每完成一步，写路径用 `checkpoint` 追加一条 `{ step, at, expected }`（单语句 jsonb 追加，`expected` 放可机器核对的预期，如 `contentVersion` / `issueNumber` / `commentId` / `labelNames`）；该原语已被工单修改、标签挂载与评论两条写路径使用。`findUnsettled` 按 `updated_at` 升序、带 `updatedBefore` 上界地读出 `dispatching` / `uncertain` 行，供**周期**核对使用（上界让「刚领取、可能马上自己完成」的行留到下一轮）——它目前只有仓储实现与测试，**没有生产调用方**：定时扫描归后续批次（§10.1）。

**`getOperation` 的核对钩子**：Facade 接受一个可选的 `TicketOperationRecoveryPort`，在 `dispatching` / `uncertain` 的账本行上执行一次回源核对（只读、绝不重放写入），核对结果直接作为响应，前端不必另开接口。装配已注入它（组合根 `module.ts` 构造 `createTicketRecoveryService`），核对按 `kind` 分派到工单/评论/标签三类口径（`project.provision` 没有核对口径，超窗口后同样转 `needs_review`）。三种结论：`applied` → 补齐本地终态、`not_applied` → 写 `failed` 并还原成 `WRITE_NOT_APPLIED`、`ambiguous` 或超 15 分钟窗口 → `needs_review`。核对读远端在事务外、落终态在事务内先 `SELECT ... FOR UPDATE` 复查状态，并发的两次核对最多一个生效。**触发仍是被动的**：只有发起人查询该操作时才会核对，没被查询的未定行不会自动收尾（§10.1）。

**内容版本**有两个前缀独立的指纹，都是 sha256、都不依赖秒级时间戳，都排除身份头：

- 工单版本 `computeContentVersion`（前缀 `fenix.tickets.v1`）覆盖标题、剥离身份头后的正文、原生状态与按名排序的标签；本版随 201 与详情返回 `version`，并作为工单 PATCH 与标签挂载 PUT 的 `expectedVersion` 参与两次比较。
- 评论版本 `computeCommentVersion`（前缀 `fenix.tickets.comment.v1`）只覆盖剥离身份头后的正文。前缀刻意不同：评论没有标题/状态/标签，共用前缀会让「把评论正文当成工单版本」这类串味在比较中通过。

`expectedVersion` 与 409 `VERSION_CONFLICT` 的判定点已落地：工单 PATCH、标签挂载 PUT 与评论 PATCH 各做**两次比较**（准入前一次、领取后一次），两次都以**回源结果**为准。准入前不一致直接 409 且不产生账本行；领取后不一致写 `failed` 行再抛同一个错误（§4.2 只拿索引比较会造成管理端直改后的持续性伪冲突）。归属账本侧用正文改写原语 `ticket_messages.updateRevision`（换 `body_hash`、`revision + 1`、记 `last_editor_id`，`author_id` 与作者快照不变——编辑不转移作者），工单描述改写与评论编辑共用它。

**202 语义**：`{ operationId, status: "uncertain" }` 表示「上游写入结果未定」或「本端已有在途/未定的写入」，**不**是失败、**不**自动重放。产生条件有三：适配器抛 `WRITE_UNCERTAIN`（超时、连接中断、2xx 但响应体不可解析）；同一幂等键的并发或崩溃残留使操作停在 `dispatching`；**远端已成功但本地终态事务失败**——建工单路径现在也返回 202（此前抛错经宿主兜底成 500），账本保持 `dispatching`、`step` 停在 `dispatching`，由恢复核对按 `message_id` 回源补齐，绝不二次创建。前端据此显示持久「提交结果确认中」提示与手动刷新入口，不轮询。

**错误类与还原表**：`errors.ts` 除 `VersionConflictError`（409 `VERSION_CONFLICT`）外新增四个类，并全部进入同键重放的还原表：`TicketChangeInFlightError`（409 `TICKET_OPERATION_PENDING`）、`TicketWriteNotAppliedError`（409 `WRITE_NOT_APPLIED`，表示核对确认远端没落库、可换键重提）、`AssigneeNotMemberError`（400 `ASSIGNEE_NOT_MEMBER`）、`UnknownLabelError`（400 `LABEL_UNKNOWN`）。还原表另收一个同义码 `TICKET_CHANGE_IN_FLIGHT`——只为读得懂人工改库或早期版本写下的行，本版不产出它（同一条规则只出一个码，前端不必认两个）。五个类现在**都有产生点**：在途互斥命中、编辑/评论的两次版本比较、恢复核对的 `not_applied` 结论、指派前的组织成员核验、标签挂载的标签映射核验。

**操作类型与步骤的取值域**：`kind` 扩到八个值（`issue.create` / `project.provision` / `issue.update` / `issue.labels` / `comment.create` / `comment.update` / `label.create` / `label.update`），协议 schema、领域类型与视图收敛共用 `TICKET_OPERATION_KINDS` 一份列表；`step` 追加 `issue_updated` / `labels_updated` / `comment_created` / `comment_updated` / `upstream_applied` / `ownership_written` / `needs_review` / `not_applied`（八个新取值都已被写路径或恢复核对写入）。`ticket_operations.kind` 是 `varchar`，漏改视图枚举的症状是 500 或前端按未知状态渲染，因此这里刻意让未登记的取值直接抛错而不是静默降级。

## 8. 装配与前端

| 配置 | `resources` 增量 | `web` 增量 | 行为 |
|---|---|---|---|
| `deploy/assembly/ce.json`（默认） | 无 | 无 | 公共 Git 与工单都关闭，零出站请求 |
| `deploy/assembly/ce-git.json` | `git` | 无 | 只有公共 Git，工单路由全部 404 |
| `deploy/assembly/ce-tickets.json` | `git`、`tickets` | `tickets` | 工单可用；`web` 元素是 manifest 的 `web.id`，不是包名 |

- **两层开关不自动映射**：assembly profile 决定模块是否加载，`FENIX_FEATURE_GIT` 只决定 Forgejo 容器是否启动。关掉工单不等于可以停 Forgejo（其他消费者可能仍在用）。
- **bundle 是上界、运行期只能收窄**：工单页面要先用 `bun run generate:web-contributions --profile deploy/assembly/ce-tickets.json` 生成贡献、再 `bun run build:web` 构建；部署期换 profile 不会重新打包浏览器产物。运行期 `/web/system/modules` 的 `data.web` 不含 `tickets` 时，入口隐藏、`/agent/tickets/*` 被拦截。
- **前端落点**：列表 `/agent/tickets`、详情 `/agent/tickets/$projectId/$number`；筛选与分页是会话内状态，不落 URL，详情链接用显式 `projectId` 保证默认项目切换后依然稳定。列表页的筛选只有关键词与状态两项（负责人/标签筛选见 §10.4）；详情页已交付评论区（倒序分页、新建与内联编辑）、负责人指派、标签多选与全量提交、关闭/重开确认、冲突与「待确认」呈现、附件区（列表 + 上传队列 + 图片缩略图与点击放大）与输入框旁的添加入口（也可直接粘贴图片，仅新建评论时生效；粘贴的图片换成带时间戳的唯一文件名——恢复核对按「文件名 + 字节数」认领结果，重名会让它转人工），写状态机由 `useTicketDetail` 唯一持有——同一工单只允许一笔未确认的写，多个入口共享同一个禁用口径，待确认 id 有两个来源（本地 202 与详情快照的 `pendingOperationId`，后者跨刷新可见）。导航项 id `tickets` 归 Shell 的 `config` 组，组内序号 110（组内 10–100 已被既有项占满，重复 `order` 会让 Shell 装配期直接抛错）。
- **新建弹窗的附件两段式提交**：附件上传以工单号为坐标，创建成功前没有落点，因此新建工单弹窗的粘贴与「添加附件」入口（描述框，与详情页评论框同构、共用预检与拒绝文案）只把文件暂存在本地（`useTicketStagedAttachments`）；201 拿到工单号后弹窗进入上传阶段（`ticket-create-upload-stage`，表单折叠、弹窗不可关闭），把暂存文件按单批上限分批移交共享的 `useTicketAttachments` 队列，全部任务终结（成功 / 受理 / 失败被移除，「前往工单」即放弃剩余）后才关闭并进入工单；202 时工单号未知、暂存文件无落点，明确提示未上传而不是静默丢弃。
- **关闭路径行为**：默认产物下，两个宿主薄路由在懒加载子树之前按 `useAssemblyCapabilities()` 判 `"tickets"`，未启用时不挂载页面、不发请求，展示与根守卫相同的「未启用」界面。服务端未装配时对应路由不存在（404），前端入口隐藏与后端 404 由同一份 `/web/system/modules` 对齐——「入口可见但服务端 404」或「服务端可用但入口被隐藏」都算缺陷。

## 9. 已知偏离

1. **advisory lock 不跨外部调用**（对设计方案「独立受限连接持锁、覆盖约 15 秒外部调用」的偏离）。理由：`DATABASE_URL` 只由宿主持有，包内无法自建第二条受限连接；而在共享业务连接池上按外部调用的时长占住一条连接，正是方案同一句禁止的行为。等价保护由三件事共同给出：`withTicketLock` 只覆盖事务内「读改写」这一段；`ticket_operations` 的 `pending → dispatching` 条件更新保证同一幂等键只有一个执行者；远端对象内嵌 `message_id`，恢复核对据此回源。锁键只由 `src/server/repositories/advisory-lock.ts` 构造（组织级 `fenix:tickets:project:<orgId>` 与工单级 `ticketsIssueLockKey` 都已使用），并用 `pg_advisory_xact_lock` 让锁随事务释放，不给连接池留未释放的锁。
2. **关闭路径的守卫落点**：根守卫 `AssemblyRouteGate` 只按**构建期贡献条目**判定归属，默认 bundle 里没有 tickets 贡献，薄路由的归属判定返回 `undefined`，根守卫会放行。为满足「关闭时手工输入地址显示未启用且不发请求」，宿主在两个薄路由文件内各加了一层本地能力判定，未启用时不挂载懒加载子树（连 chunk 都不会去取）。这是临时落点：把「产物内存在薄路由但贡献缺席」的情形统一纳入路由边界是后续工作，完成前任何新增的同类薄路由都必须自带这层守卫。
3. **评论编辑入口只认作者**：设计上组织管理员可以编辑他人评论，但会话投影只有 `isOwner`（`@fenix/web-runtime/contexts/org-session` 刻意不外泄角色枚举），非 owner 的管理员在界面上拿不到编辑入口。服务端仍按规则放行管理员，所以这是**可见性缺口、不是越权**。解除条件：会话投影补 `isAdmin`，或详情视图返回 `viewerPermissions`；两者出现任一后把管理员并进 `web/lib/ticket-permissions.ts` 的判定。该判定另有两条边界：来源不可信的作者 `id` 恒为 `null`，天然判否；会话未就绪（`userId === null`）同样判否——宁可少显示一个入口。
4. **评论倒序分页的机制与退化**（已落地）：「首屏最新 30 条」不允许「全量读入再截断」。机制在 `ticket-comment-page.ts`：首屏先用一页请求探出适配器从 `Link` 头透出的末页页码（`GitPage.lastCursor`，见 [公共 Git 模块架构](./28-common-git.md) §2），再直接取末页——两次请求、只读两页，绝不整串扫描；`nextCursor` 是更早一页的页码，逐页递减到第 1 页；页内顺序反转成「最新在前」，前端据此把整串渲染成时间正序。**退化点**：上游不返回 `Link` 头（`lastCursor` 为 null）时只能读第一页，并如实表达「没有更早的页」——此时若仓库实际有多页评论，首屏会显示**最旧的一页**而不是最新 30 条，违反「首屏最新 30 条」的验收门槛；是否处于该退化只能由上游是否透出 `Link` 头判定，实现里不得编造末页页码。（`since` 与单条评论读取 `comments.get` 已在目标实例上探活通过；**但该实例的评论端点忽略 `page` / `limit` 且不返回 `Link` 头**，所以退化不是例外而是常态：第 1 页就是全量，反转后仍是最新在前，「更早一页」不存在——界面因此不会出现「加载更早的评论」，代价是每次读取都传输整串（结论与实测数据见 §10.11）。首屏那两次请求里的探页请求可以用上游返回的 `X-Total-Count` 省掉，本版未做，属可选优化。）
5. **同类失败在两条路径上的响应仍不一致**：`issue.create` 在「远端已成功、本地终态写入失败」时返回 202（§7），`project.provision` 的同类失败仍上抛、经宿主兜底成 500（账本同样保持 `dispatching`，不会自动重发）。恢复核对没有开通场景的口径（`project.provision` 属 unmatched），因此该行超过 15 分钟窗口后会被转成 `needs_review` 而不会自动补齐。解除条件：把开通路径的同形失败也收敛成 202 并同步其用例；在此之前运维不要把它当作「可重试的失败」重发。
6. **uncertain 的 `intent` 原文没有 7 天清理**：设计方案要求未决操作保留的正文原文有保留上限。本模块对「成功或明确失败」的行立即改写为摘要，但 `dispatching` / `uncertain` / `needs_review` 行会一直保留正文原文与 `message_id`（恢复核对依赖它）。**7 天清理任务在本版没有代码**（需要生命周期定时器，后续批次才有），因此这些行既不清理也不归档。影响：未决行会长期保存原文；处置前不要手工删除，否则恢复核对失去依据（见 [工单运维说明](../operations/tickets.md) §7）。

## 10. 未实现清单

以下能力属于工单范围但**本版没有代码**，不要按已存在处理：

1. **恢复核对的周期扫描**：单次核对与 `getOperation` 的核对钩子已落地（§7），但**没有定时扫描**——`findUnsettled` 只有仓储实现与测试，没有生产调用方，因此没有被查询的 `dispatching` / `uncertain` 行不会自动收尾，`needs_review` 也只会在这条被动路径上产生。缺的能力是「按 `(status, updated_at)` 调度、批量调用 `reconcile` 的生命周期任务」（`RECOVERY_*` 窗口常量已按它收口）。见 [工单运维说明](../operations/tickets.md) §6。
2. **事件同步**：没有 Webhook 接收、事件去重、事件分发与投递消费；列表只反映创建与修改路径写入的索引行，因此列表行的 `sync_status` 长驻 `ready`（`stale` 没有写入方，只有详情在索引行缺失时才兜底给出 `stale`）。缺的能力是「接收 Forgejo 事件 → 更新 `ticket_index` / 归属 → 触发通知」的消费链路。
3. **站内通知**：`ticket_notifications` 表已建，但没有写入与读取路径；缺的能力是通知的产生与已读流程。（附件三类路由已实现，见 §2。）
4. **列表的负责人/标签筛选**：接口参数（`assigneeId` / `labelId`）与索引查询已支持，列表页只有关键词与状态两个控件（`ticket-filter-bar.tsx`）。缺的能力是前端两个筛选控件与查询接线，后端无需改动。
5. **控制台的管理面**：没有开通、切换默认项目与暂停的页面入口，这些动作只能用管理员接口完成（见 [工单运维说明](../operations/tickets.md) §3）。
6. **检索能力**：`q` 只匹配标题；评论全文检索与跨项目检索未实现。
7. **`intent` 原文的生命周期清理**：未决账本行会一直保留正文原文，见 §9.6。
8. **初始化脚本**：`scripts/git-bootstrap.ts` 与 `bun run git:bootstrap` 不存在（公共 Git 侧同样未交付）；仓库绑定与项目只能经 `POST /web/ticket-projects/default` 由服务端创建。
9. **评论编辑的管理员 UI 入口**：服务端按规则放行管理员，但会话投影缺角色信息，界面上非 owner 的管理员拿不到编辑入口，见 §9.3。
10. **项目标签删除**：`DELETE` 路由不存在，标签只能新建与修改（方案 §5 的刻意收口，不是欠账）。
11. **目标 Forgejo 实例的能力探活（已在 Forgejo 15.0.9 上完成，实测结论）**：三项按公开 API 文档实现的能力都接真实实例验证过，结论如下，其余不再按「未验证」处理。
    - `since`（工单与评论列表的增量过滤）：**有效**，时间窗按期望收窄。实测同一仓库：全部 35 条评论里 `since=02:05:00Z` 返回 35 条、`since=02:06:00Z` 返回 0 条（评论实际创建于 02:05:18–02:05:31）；工单列表 `since=02:06:00Z` 由 2 条收窄到 1 条。恢复核对依赖它做时间窗，不需要退化成全量扫描。
    - 分页 `Link` 头里的 `rel="last"`：**该实例的评论端点（`/issues/{n}/comments`）不返回 `Link` 头，且忽略 `page` / `limit`**——`?limit=5`、`?page=2&limit=30` 与不带参数一样返回全量 35 条，只带 `X-Total-Count: 35`。于是 §9.4 的退化在本实例上是**常态而非例外**：`lastCursor` 恒为 null，评论读取恒为「一次读回整串、没有更早的页」，界面不会出现「加载更早的评论」。输出仍然正确（第 1 页即全量，反转后最新在前），代价是长讨论串的工单每次读取都传输整串——「按上游能力自行切页」应作为后续工作（`X-Total-Count` 已可用）。工单（`/issues`）端点的分页正常：`limit` 生效且返回 `Link` 头，因此 `issues.list` 的有界扫描不受影响。
    - `GET /repos/{o}/{r}/issues/comments/{id}`：**可用**，返回 200 且响应含 `issue_url`（适配器据此取工单号），评论编辑与挂载前核验不需要降级路径。
    - 未验证项：评论端点的 `before` 参数（本模块未使用）；上游日后若修好评论分页并透出 `Link` 头，`ticket-comment-page.ts` 的探页逻辑会自然启用，无需改代码。

## 11. 验证

- `packages/resources/tickets/src/__tests__/repositories.test.ts`：存储侧契约——授权条件如何到达 SQL、账本写了哪些列（含领取时写入目标坐标）、部分唯一索引与外键声明。
- `packages/resources/tickets/src/__tests__/identity-header.test.ts`：身份头往返、线格式、大小与安全闸（别名、深度、未闭合块）。
- `packages/resources/tickets/src/__tests__/content-version.test.ts`：版本指纹口径——身份头必须被排除、标题/正文/状态/标签与评论正文各自何时改变指纹。
- `packages/resources/tickets/src/__tests__/ticket-author.test.ts`：归属核验的拒绝面（缺归属行、对象 ID / 组织 / 摘要不符一律 `external`）。
- `packages/resources/tickets/src/__tests__/ticket-permission.test.ts`：动作权限矩阵（正文改写、指派与状态、评论编辑三组规则与「作者不可伪造」）。
- `packages/resources/tickets/src/__tests__/ticket-action-guard.test.ts`：授权拒绝的收窄边界——只有授权拒绝转 403，其余错误原样上抛。
- `packages/resources/tickets/src/__tests__/tickets-create.test.ts`：创建路径的幂等重放、202 分支（含本地终态写入失败）、错误映射与降级；操作账本的在途互斥（对象坐标、互斥组、终态与同键重试的豁免、`needs_review` 阻塞）。
- `packages/resources/tickets/src/__tests__/facades.test.ts`：授权 404/403、项目开通与默认切换、暂停语义、作者正确性、`getOperation` 的恢复核对触发条件。
- `packages/resources/tickets/src/__tests__/ticket-update.test.ts`：工单修改——标题/描述/指派/状态各自的远端与索引落点（含取消指派、关闭与重开）、两次版本比较（同版本两路只有一路写入）、幂等重放与 `IDEMPOTENCY_CONFLICT`、`WRITE_UNCERTAIN` 与「远端已写、本地失败」的 202、指派非成员、跨组织 404、`pendingOperationId` 暴露。
- `packages/resources/tickets/src/__tests__/ticket-comments.test.ts`：评论——首屏取末页与游标递减、末页页码缺失时按单页退化、作者核验两路、创建/编辑的幂等与 202、原作者与管理员放行、他人 403、评论不属于该工单 404、路由层 202/503。
- `packages/resources/tickets/src/__tests__/ticket-labels.test.ts`：标签——挂载（ID→名称映射、清空、未知标签 400、上限、权限与跨组织）与项目标签 CRUD（管理员动作、同名冲突、颜色归一）。
- `packages/resources/tickets/src/__tests__/ticket-attachments.test.ts`：附件——上传的 multipart 形状与账本落点（`attachment_uploaded`）、上游 413/422 是确定拒绝（落 `failed` 与 400，不升级未定）、超限与空内容在发请求前本地拒绝、同名同内容的幂等重放与换内容 409、列表/下载的上游失败 503、跨组织 404、项目暂停 503 且零上游调用、恢复核对的三条匹配结论、下载响应头（`Content-Disposition` 两个值 + `nosniff`）与路由层参数校验。
- `packages/resources/tickets/src/__tests__/ticket-members.test.ts`：成员分页（`page`/`pageSize`/`q` 透传与总数回显）、跨组织 404 且身份目录零调用、投影只含 `userId` 与 `name`。
- `packages/resources/tickets/src/__tests__/ticket-recovery.test.ts`：单次核对的三条结论与边界（唯一命中补齐、同一 `message_id` 多命中、窗口内外、上游读失败 503 不改状态、评论坐标替换、并发核对只落一次终态、非本人 404、`getOperation` 的触发条件）。
- `apps/server/src/__tests__/tickets-assembly.test.ts`：装配面——三份 profile 的差集、缺 `git` 时在副作用前失败、默认 profile 零出站、`git` 先于 `tickets` 构造。
- `apps/web/src/__tests__/web-contributions.test.ts`：宿主侧贡献与 `tickets` 字典注册（漏登记的症状是文案整片回退成 key 回显）。
- `packages/resources/tickets/web/__tests__/`：浏览器面守卫（`tickets-browser-surface`：值导入图里不出现 `node:*`、`@server/*`、宿主别名，跨包说明符都能经对方 `exports` 解析，外部依赖白名单逐条登记）、字典自持（`tickets-i18n`）、失败码分类（`ticket-errors`：版本冲突 / 幂等冲突 / 在途互斥 / 404 各归哪一类）、写入结果判别与幂等键持有者（`ticket-write-outcome`）、列表与详情页的状态分支（`agent-tickets-page-states` / `agent-ticket-detail-states`：错误与重试、空态、未开通、行级 `stale` 降级）、评论与写动作的 hook 级数据流（`ticket-comments` / `agent-ticket-write-actions`：分页方向、草稿保留、冲突刷新、202 短路、标签全量提交）、附件的预检与队列（`ticket-attachments`：逐文件拒绝原因、并发上限 2、幂等键跨重试复用、202 转待确认、下载经本服务端点）、新建弹窗的附件编排（`ticket-create-attachments`：粘贴换名与纯文本放行、暂存预检与逐项移除、创建后按工单坐标分批移交、成功/失败重试/202 三条终结路径）。

需要注意：评论、工单修改、标签与恢复核对的用例是**路由级 + Facade 级**（`installTicketRoutes` 装真实路由，Git 与身份目录用替身），覆盖的是协议形状、状态码与账本落点；**不覆盖**真实 Forgejo 交互与浏览器到服务端的端到端链路，后者不在本包测试范围内（两份装配用例只验证装配差集与零出站）。

**存储侧的验证边界（务必连同这条一起维护）**：`repositories.test.ts` 断言的是**生成的语句**（列名、谓词、`FOR UPDATE`、参数类型标注），工单其余用例走记录型仓储替身、**不执行任何 SQL**。这个边界漏过一次真实缺陷：`checkpoint` 的 `jsonb_build_object('step', $1, …)` 缺 `::text`，在真实 Postgres 上必然 42P18，259 条替身用例全绿也发现不了。因此新增仓储原语时必须同步在 `repositories.test.ts` 补语句断言，并单独在临时库上跑一次真实执行；替身只负责复刻形状，不构成 SQL 可执行的证据。

**未覆盖（同进程测试环境的硬约束）**：所有挂在 Radix 覆盖层里的页面级断言——创建弹窗（202 持久提示条与不跳转、201 跳转参数、空正文不发请求）与详情页的字段编辑弹窗、标签多选、关闭确认。原因是覆盖层在 `bun test packages/` 的同进程里不挂载（先加载过 `packages/ui-components` 的同类测试后，`@radix-ui/react-portal` 的挂载 effect 不执行，且不报错）；仓库既有做法是对 `config/FormDialog` 与 `ui/dialog` 开模块替身，这里不采用，以免跨文件替身污染同进程的其它包测试。这些动作改由 hook 级与纯逻辑级用例覆盖（写状态机与幂等键换代、冲突与待确认分支、权限判定、错误码分类），页面层只断言不需要覆盖层的分支（加载 / 空态 / 错误与重试 / 未开通 / 行级 `stale`）。
