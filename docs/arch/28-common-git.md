# 公共 Git 模块架构（common-git）

> 状态：实现基线（2026-10-12；接入层与首个消费者工单均已交付，事件消费与附件见 §7）
> 范围：`@fenix/git` 的定位与边界、接口面与作用域语义、错误模型、四张账本表、安全约束、可选装配与运行参数。
> 定位：本文是 `packages/common/git` 的**实现基线**，只描述已落地的事实。事件分发与附件在本文范围之外，未实现部分逐条列在 §7；工单模块自身的架构见 [工单模块架构](./29-tickets.md)。
> 约定：代码演进偏离本文档时，先更新文档再改代码。部署与运维步骤（Forgejo 编排、连接配置样例、排障）见 [运维说明](../operations/common-git.md)，目录契约见 [Docker 编排体系](../operations/docker-topology.md)。

## 0. 硬边界

1. **事实源在 Forgejo**：仓库、Issue、评论、标签与附件由托管平台持有；AOS 侧只存绑定、订阅、事件与投递账本（四张表，§4）。工单正文、状态与评论全文不落 AOS 表。
2. **origin 固定**：请求 URL 只由连接配置的 `baseUrl` 与包内路径拼成，调用方永远不能提供 URL；只跟**同源**重定向（≤2 跳），跨源即 `UNAVAILABLE`——否则本层会变成可被诱导去读内网的代理，`Authorization` 也会随上游 `Location` 被带到别的域。
3. **写请求不自动重放**：`POST` / `PATCH` / `PUT` 一律不重试；远端是否落库未知时统一走 `WRITE_UNCERTAIN` 与恢复核对（§3）。读请求在本层自动重试，上限 2 次、只针对可重放的失败。
4. **凭据引用是安全边界**：`{env:NAME}` 的 `NAME` 必须已由宿主注入，未声明的引用当场拒绝；「已声明但值为空」同样拒绝——空 token 出站只会在远端变成 401，把「忘配密钥」伪装成外部故障。
5. **两枚凭据不混用**：初始化凭据（`provisionToken`，能建仓库与 Webhook）只供装配期与初始化动作；日常读写走绑定记录的 `credentialRef`，且**比对值**拒绝引用到初始化凭据——引用名字合法不代表指向的就是受限凭据。
6. **日志与错误不含凭据与正文**：允许的关联字段只有 `operationId`、`connectionId`、`repositoryRef`、耗时与状态码。
7. **一个仓库只归属一个 AOS 组织**：跨组织共享仓库不在本版合同内，冲突时拒绝而不是接管。
8. **默认不装配**：`deploy/assembly/ce.json` 不含 `git`；未启用时进程不读连接配置文件、不构造适配器、零出站请求。

## 1. 定位与边界

`@fenix/git` 是 **Forgejo 之上的公共托管平台接入层**：把「一个受控组织在一个受控仓库上能做什么」收敛为一份作用域客户端，供多个上层消费者复用。代码与数据落在 `packages/common/`（本仓 `common` 类别的首个成员），包名 `@fenix/git`，manifest `id = "git"`、`kind = "resource"`、`dependsOn: []`、`capabilities: ["common.git"]`。

**为什么需要独立类别**：这份能力被宿主装配、被多个上层业务消费者共用（工单是第一个，见下），而它自己不依赖任何资源包。把它放进某个资源包会迫使其他消费者反向依赖那个包的领域实现，直接闭合出环；放进 `platform/*` 又不对——它不是平台契约，也不提供授权/身份语义。因此新增 `common` 类别并**只允许指向平台契约与独立工具包**：`scripts/lib/architecture-boundary-rules.ts` 中 `common` 的禁则为 `platform-impl` / `agent-runtime` / `machine` / `sandbox` / `resource` / `apps-server` / `apps-web`，任意一条指向这些上层的边都会立刻闭合出环。

**与工单的单向依赖**：工单模块（`@fenix/resource-tickets`，`packages/resources/tickets`）是第一个消费者，已接入建工单、查列表与详情、组织项目初始化；它的 `dependsOn` 含 `git`，经 `GitService.createScopedClient` 取得受控作用域。git 不依赖工单，也不理解工单与通知语义；装配校验在产生副作用前拒绝「声明了 tickets 却没有 git」的组合，反向不存在。工单侧的能力范围与未实现清单见 [工单模块架构](./29-tickets.md)。

跨包依赖只有 `@fenix/platform-sdk`（`getDatabase()` 与 `ModuleFactoryContext`）与 `@fenix/logger`；包内不读 `process.env`、不 import `apps/**`、不 import 其他资源包的 `src/**`，跨包只走公开 `exports`。

## 2. 接口面

两个出口，职责不同：`@fenix/git`（根出口）只导出契约**类型与错误**，零运行时依赖——消费者编译期需要它们，不该因此把 Drizzle 或适配器拖进自己的模块图；`@fenix/git/server` 面向宿主，导出模块工厂、配置解析与错误码。**适配器（`ForgejoClient`）、仓储与绑定服务工厂刻意不出口**：外露就会有人绕过绑定记录直接构造带初始化凭据的客户端，作用域随之失效。

`GitService` 的两半分属两类调用方，凭据与能力都不同：

| 接口 | 调用方 | 凭据 | 能做什么 |
|---|---|---|---|
| `createScopedClient({ consumerId, organizationId, bindingId })` | 普通消费者（工单等业务） | 绑定 `credentialRef` 指向的受限服务账号 | 仓库读、Issue 读/写、评论读/写、标签读/写 |
| `GitAdminService`（`createPrivateRepository` / `getRepository` / `ensureIssuesEnabled` / `bindExistingRepository` / `getBinding`） | 初始化脚本与宿主管理接口 | 连接的 `provisionToken` | 建私有仓库、开 Issues、注册与读取绑定 |

管理能力**不在**作用域客户端上：把 `createPrivateRepository` 交给普通工单写入路径，等于每次写工单都持有能建仓库的凭据。管理服务自身不做调用方授权（那是宿主管理接口的职责），只判定包内能判定的事——凭据引用是否合法且已声明、上游仓库是否真的存在、同一仓库是否已归属别的组织。

**作用域与每次操作复查**：`consumerId`、`organizationId` 与 `repositoryRef` 在创建期由服务端解析并绑定（来自认证上下文、绑定记录与静态消费者注册，**不从请求正文取**），客户端不提供任何修改作用域的方法。创建期判定包含：绑定存在（否则 `NOT_FOUND`）、组织归属匹配（否则 `FORBIDDEN`，消息不说明绑定属于哪个组织，避免把其他租户标识透给未授权调用方）、连接存在（`NOT_FOUND`）、凭据引用可解析且不是初始化凭据（`FORBIDDEN`）、该 consumer 的授权集合非空（`FORBIDDEN`）。此后**每次调用**都复查本进程持有的绑定快照：绑定 `status = active`，且操作名在 `allowedConsumers[consumerId]` 内。

复查用内存快照、不重查库，这是刻意的：绑定只在创建作用域客户端时读一次，包内再加一层缓存只会制造两份互相不一致的授权视图；**跨进程的撤销**（另一副本改的绑定）不在本层生效范围，由事件同步（§7 未实现）与后续验证覆盖。拒绝一律 `FORBIDDEN`——「你无权做这件事」与「这个对象不存在」对调用方是不同的结论。

操作名（`repositories.read`、`issues.read` / `issues.write`、`comments.read` / `comments.write`、`labels.read` / `labels.write`）是**持久化契约**：它们写在 `git_repository_bindings.allowed_consumers` 里，改名不会报错，只会让存量授权静默失效。只能追加新名字。`ensureIssuesEnabled` 按 `issues.write` 判定。

分页统一为 `{ items, nextCursor }`，`nextCursor` 为 null 表示末页；适配器把 `cursor` 定义为「下一页页码的十进制字符串」，`limit` 默认 30、最大 100。所有外部数字 ID（仓库、Issue、评论、标签）在协议与领域层一律以**字符串**承载：Forgejo 侧是 int64，退化成 number 后序列化与比较会静默出错。

## 3. 错误模型

对外的失败面只有七个码（`src/contracts/errors.ts`），上层按码决策，不解读 Forgejo 的响应文本：

| 码 | 语义 | 可重试 |
|---|---|---|
| `NOT_FOUND` / `FORBIDDEN` / `CONFLICT` | 上游给出的**确定**拒绝，成败已定（含本地授权拒绝与跨组织冲突） | 否 |
| `RATE_LIMITED` / `UNAVAILABLE` | 确定失败且可重试（429；其余 5xx 与网络故障） | 读：是；写：否 |
| `WRITE_UNCERTAIN` | 写请求超时、连接中断、或收到成功状态但返回体无法解析——远端**是否落库未知** | 只能走恢复核对 |
| `INVALID_RESPONSE` | 上游返回成功状态但响应体不符合适配器合同（缺字段、类型不符、响应体超过 1 MiB） | 读：否；写：按 `WRITE_UNCERTAIN` 处理 |

**读重试与写不重放的边界**：读请求由 HTTP 层自动重试（首次之外的 2 次，只针对 `UNAVAILABLE` / `RATE_LIMITED`，退避按尝试次数线性放大）——GET 可安全重放，把重试留给每个调用方只会写漏。写请求**一次都不重放**：`postJson` / `patchJson` / `putJson` 把 `UNAVAILABLE` 与 `INVALID_RESPONSE` 提升为 `WRITE_UNCERTAIN`（`toWriteUncertain`），调用方必须按 `operationId` / 消息标识回源核对，**绝不能当作失败直接重发**——重放会造出第二份对象。上游明确返回的 4xx/5xx 是确定结果，**保持原码**：把确定失败也标成 uncertain 会让恢复流程去核对一个从未发生的写入，把运维噪音当成保护。

## 4. 数据模型：四张账本

四张表定义在 `packages/common/git/db/schema.ts`（唯一 owner，经 `@fenix/git/db` 出口），迁移 `drizzle/0033_common-git-tables.sql`。表间外键都是包内引用，无跨包导入。

| 表 | 职责 | 关键约束 |
|---|---|---|
| `git_repository_bindings` | 仓库绑定：一个 Forgejo 仓库与一个 AOS 组织的归属契约；`credential_ref` 与 `allowed_consumers` 是授权载体，`status`（`active` / `paused`）用于「托管平台管理端直接维护前暂停写入并重新同步」 | `UNIQUE(connection_id, provider_repository_id)`、`organization_id` 索引 |
| `git_event_subscriptions` | 消费者订阅：某个绑定上的事件类型开关；工单停用时只暂停自己的订阅，其他消费者独立工作 | `UNIQUE(binding_id, consumer_id)` |
| `git_events` | 已接收的 Webhook 事件（去重账本）：同 `delivery_id` 重送返回成功但不再生成投递记录 | `UNIQUE(binding_id, delivery_id)`、`received_at` 索引 |
| `git_event_deliveries` | 投递账本：每个事件 × 每个订阅各一行，记 `status` / `attempts` / 租约与 `last_error` | `UNIQUE(event_id, subscription_id)`、`(status, next_attempt_at)` 调度索引 |

**口径**：Forgejo 是事实源，这四张表只记 AOS 侧「谁绑定了什么、谁订阅了什么、收到过什么、投递到哪一步」；查询索引与站内通知属工单模块（`@fenix/resource-tickets`，两张表已建好，通知的写入路径未实现），不在本包建表。**保留与重试的数值是既定合同，调度属未实现部分（§7）**：事件载荷在全部消费者确认后保留 7 天、去重标识保留 30 天；未确认投递最长保留 30 天，超过后把订阅标记为 `needs_resync`，先全量校对再恢复处理，不静默丢弃；投递用短事务 + `SKIP LOCKED` 领取、租约默认 60 秒 / 15 秒续约、失败按 5 秒至 5 分钟退避、最多 10 次后进入 `failed` 待重试。表定义在本批一次成型，但本版没有任何代码执行上述清理与调度（§7）。

## 5. 安全约束

传输层的约束集中在 `src/forgejo/http.ts`——本包**唯一**发出外部请求的地方：

- `baseUrl` 由构造参数固定，且配置解析只接受**纯 origin**（http/https、无路径/查询/片段、不得内嵌用户名或口令）；越界值在启动期直接失败而不是静默夹取。
- 只跟同源重定向（≤2 跳）。不自动跟随重定向是刻意的：`fetch` 的 follow 会把 `Authorization` 交给重定向目标，且无法限制跳数。
- 响应体硬上限 1 MiB，超限即断开——敌意或失控的上游不能用超大响应吃满进程内存。
- 单次请求超时默认 15 s（可配 1 s–120 s），在途请求有并发闸（默认 16，可配 1–64）；`AbortSignal.timeout` 只覆盖已发出的请求。**非法值与越界值一律在启动期拒绝，不是夹取**（连接 id 形状、`baseUrl` 必须是纯 origin、超时与并发区间）：静默夹取会让「配了 1000 ms 却按 120000 ms 跑」这类偏差没人察觉。
- 错误消息只带本地方法名与路径（以及字段路径、变量名），绝不回显上游文本；错误消息里连 `baseUrl` 都不出现——它可能被误写成内嵌凭据的 URL。

配置文件里只允许出现**密钥引用**（`{env:NAME}`），凭据值只经宿主注入的 `secrets` 表进入内存；引用的 `NAME` 必须在 Git manifest 已声明的 secret 键内（`AOS_GIT_PROVISION_TOKEN`、`AOS_GIT_SERVICE_TOKEN`），否则拒绝，而不是留给 Forgejo 401。密钥值只驻留进程内存，不进日志、错误消息与任何响应。

## 6. 可选装配与运行参数

### 6.1 装配组合

| 配置 | `resources` 增量 | 行为 |
|---|---|---|
| `deploy/assembly/ce.json`（默认） | 无 | 公共 Git 关闭；进程不读连接配置、零出站请求 |
| `deploy/assembly/ce-git.json` | `git` | 仅启用公共 Git，供后续消费者使用 |

profile 位置由部署面给出：不带 `RCS_ASSEMBLY_PROFILE_PATH` 时是应用根下的 `deploy/assembly/ce.json`，换文件用该键传绝对路径（相对路径启动期即被拒绝）。**`FENIX_FEATURE_GIT` 与 assembly 是两层开关、互不自动映射**：前者只决定 `docker/git/` 的 Forgejo 容器是否启动，后者决定模块是否加载；关掉工单不等于可以停 Forgejo（其他消费者仍在用），启动了 Forgejo 也不等于 AOS 有 Git 能力。两者通过能力名对齐，理由与通用规则见 [ADR：装配 profile 派生的前后端模块启用标识](../adr/2026-10-08-assembly-capability-gate.md) 与 [Docker 编排体系](../operations/docker-topology.md) §13。

`create` 只在 git 进入 profile 时被调用，因此「启用即必须有连接」由组合根判定：配置文件路径为空或没有任何连接时，在产生副作用前抛错并指向 `AOS_GIT_CONFIG_FILE`；宿主投影在**未配置时不读文件**（默认装配根本不含 `AOS_*` 键），但**配置了路径却读不出来**（非绝对路径、文件缺失、JSON 非法）时启动期直接失败，不降级成「没有连接」。适配器构造只建信号量与配置，**不发出站请求**——首次调用才连 Forgejo。

### 6.2 单例与释放

`createGitModule()` 惰性且幂等：进程内第一次调用构造，之后返回同一实例；失败**不缓存**失败的 promise（一次拼错路径不应让进程在内存里永久记住这个错误）。构造前先向宿主 `registerCleanup` 登记释放动作，宿主关闭序与启动失败清理都经 `assembly.dispose()` 触发；`dispose()` 只清空单例（本版无定时器与长连接），后台消费循环（§7 未实现）接入时同样挂在这里。

**宿主接线的缺口在接入层交付时一并补上**：`apps/server/src/bootstrap/host-startup.ts` 此前丢弃 `bootstrapServerAssembly()` 的返回值，导致模块登记的 cleanup 永不执行；现在句柄落在 `hostAssembly`，在正常关闭序（晚于 runtime drain、早于 cache 与 DB——模块 cleanup 可能仍要读写这两者）与启动失败路径各调用一次，`dispose()` 自身幂等，两边都命中也只真正清理一次。

### 6.3 环境变量与健康检查

四个键的唯一声明处是 `packages/common/git/fenix.module.ts` 的 `envDefinitions`（宿主 `env.ts` 不得重复声明，`assertNoHostKeyOverride()` 在启动期拒绝冲突），全部 `restartRequired`：

| 键 | 默认值 | 密钥 | 语义 |
|---|---|---|---|
| `AOS_GIT_CONFIG_FILE` | 空串 | 否 | 连接配置 JSON 的绝对路径；空串表示未配置，启用 git 时启动失败 |
| `AOS_GIT_PROVISION_TOKEN` | 空串 | 是 | 初始化凭据（建仓库、Webhook、绑定既有仓库） |
| `AOS_GIT_SERVICE_TOKEN` | 空串 | 是 | 日常读写凭据（受限服务账号，绑定经 `{env:AOS_GIT_SERVICE_TOKEN}` 引用它） |
| `AOS_GIT_FORGEJO_URL` | `http://127.0.0.1:3210` | 否 | **部署面**探活地址，不是模块运行时地址（运行时地址取连接配置的 `baseUrl`） |

`AOS_GIT_FORGEJO_URL` 单独存在是因为探针解析不了配置文件，只能锚定 env 键；容器内部署应设 `http://forgejo:3000`，默认值对齐宿主回环端口。**健康检查分离**：manifest 的 `dependencyServices` 声明 Forgejo（`orchestration: "separate"`、`composeFile` 指向 `docker/git/docker-compose.yml`、探针 `GET /api/healthz`），并声明 `required: false`——Forgejo 不可达只降级 Git 能力，不阻断主服务存活与启动。`AOS_GIT_*` 是模块声明键，密钥只进主服务 env，不进 `docker/deploy.env`。

## 7. 本版未实现

以下能力在方案范围内但**本版没有代码**，不要按已存在处理：

1. **事件消费与 Webhook 接收**：没有接收入口、验签、事件分发与投递消费循环，也没有 §4 的清理任务与租约调度；订阅与投递两类表的形状已定型，但没有任何进程写它们。
2. **附件**：`repositories` / `issues` / `comments` / `labels` 之外没有附件接口（上传、列表、下载），领域类型中也不含附件形状。
3. **`scripts/git-bootstrap.ts` 与 `bun run git:bootstrap`**：仓库内不存在该脚本与对应 npm script；仓库创建与绑定登记目前只能经宿主进程内的 `GitAdminService`，启用工单后由 `POST /web/ticket-projects/default` 驱动，没有工单时只能先在 Forgejo 侧手工建仓库与令牌（见运维说明）。
4. **宿主管理接口**：`GitAdminService` 没有对外路由，manifest 也未声明任何 route contribution 或 web contribution；本模块自身不暴露 `/web/*` 或 `/api/*` 面，Git 能力目前只经工单的路由间接使用（§1）。
5. **工单只用了最窄的一段消费面**：`@fenix/resource-tickets` 已交付（五张表、七条路由、页面与 `ce-tickets.json`），实际用到的 git 能力只有仓库创建/绑定与 Issue 读写；评论、指派、标签、关闭重开、事件同步、附件与通知都还没有代码，逐条见 [工单模块架构](./29-tickets.md) §10。
6. **preflight 探活执行器**：宿主装配支持 `preflight` 选项，但生产启动路径没有传入具体实现，因此 `dependencyServices` 的声明目前不产生任何探活动作（`AOS_GIT_FORGEJO_URL` 也因此只作为部署面约定存在）。

## 8. 验证

- `packages/common/git/src/__tests__/config.test.ts`：连接解析（合法形状、缺 `connections`、非法 `baseUrl`、空引用与未声明的密钥引用、默认值、越界值拒绝）。
- `packages/common/git/src/__tests__/forgejo-client.test.ts`、`forgejo-mapper.test.ts`：URL 拼接与 token 头、分页游标、错误码映射、写方法提升为 `WRITE_UNCERTAIN`、同源重定向限制、DTO → 领域类型的严格校验。
- `packages/common/git/src/__tests__/scoped-client.test.ts`：未授权 consumer、操作不在授权集合、绑定 `paused` 一律 `FORBIDDEN`。
- `apps/server/src/__tests__/git-tickets-assembly.test.ts`：`ce.json` 不含 git、`ce-git.json` 只多一个模块、未配置时 create 阶段失败且错误消息不回显凭据、`dispose()` 可重复调用。用例不读进程环境、不触网，「装配成功」本身就是「没有出站请求」的证据。
- 工单侧（含 `tickets-assembly.test.ts`）只在其包内以桩件替换 `GitService`，不覆盖真实 Forgejo 交互；用例清单见 [工单模块架构](./29-tickets.md) §11。
