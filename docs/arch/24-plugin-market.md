# 插件市场模块架构（plugin-market）

> 状态：实现基线（2026-09-23；2026-09-24 管理动作迁入管理台，见 §7 / §8）
> 范围：受控资源「市场条目」的领域模型、数据模型、写路径状态分派、并发与事务、授权模型、外部 npm 私有源的读取边界、`/web/config/plugin-market/*` 与 `/api/system/plugin-market/*` 两条面的契约、前端页面契约，以及模块在主服务里的装配与登记。
> 定位：本文档是插件市场模块的**实现基线**。模块由 `/Users/konghayao/code/ai/open-mcp-market` 的 `packages/mcp-market` 移植而来，领域规则与安全边界以源项目为权威来源，差异逐条登记在 §10 与本包 `README.md`。授权机制的通用语义见 `docs/design/ce-ee-refactoring/ce-access-control-design.md`，目录页共享构件集见 `docs/developer/guide/frontend-development.md`。
> 约定：代码演进偏离本文档时，先更新文档再改代码。本文不定义插件安装、绑定到 Agent 配置或对外 `/api` 契约——那三项明确不在本期范围。

## 0. 硬边界

1. **市场只读 packument 元数据，永不下载、解压或扫描 tarball**。`tarballUrl` 只作为溯源文本存在：市场存储它、界面渲染它，但没有任何一条代码路径把它变成请求。制品完整性由私有源持有。
2. **快照契约是安全边界，不是数据形状**。`src/server/npm-registry/types.ts` 是「registry 的不可信 JSON」与「市场可信存储」之间唯一的过桥形式；原始 packument 与任何未列入该文件的字段**永远不进市场存储**。新增字段必须先回答：它是否会被外部源控制，是否可能成为任意文本的载体。
3. **发布即冻结**。发布写入的快照在版本行上不可变：`restore` 只改 `published_at` / `unpublished_at`，`first_published_at` 永久不变；恢复复用市场内的快照，**不访问私有源**。
4. **读路径永不访问私有源**。列表与详情只读本地快照；只有 `publish/preview` 与「确认发布但库内没有该版本」两条写路径出网。
5. **市场是平台全局目录**：任意已认证主体可读，只有平台运维者（系统 API Key）可写。写路径的唯一入口是管理面（`/api/system/plugin-market/*`），判据在路由守卫；归属组织由服务端解析注入，**绝不接受浏览器传入**。
6. **读口径恒为公开面**（`scope = "public"`）：整包下架的条目在浏览面上不存在——详情返回与服务端一致的 404，列表则不返回该包。全量口径（含下架条目与下架水印）只出现在管理面。
7. **私有源 token 不进日志、不进响应、不进错误消息**。快照校验失败时只报字段路径（`metadata.<path>`），不回显取值。
8. **`noop` 严格无副作用**：已可见版本重复发布，写清单为空、逻辑时钟不动、`published_at` 不变。
9. **`published_at` 是逻辑时钟**（`nextMonotonicInstant`）：候选时刻不严格大于该包已记录的最大时刻就推进到 `max + 1ms`。恢复同样算一次新发布，因此恢复后的版本能重新成为 latest。

## 1. 领域模型

**一个插件 = 一个 NPM package**，稳定身份 `(source_id, package_name)`——`source_id` 是部署级来源标识（默认 `npm`），保留它是为了让未来的第二来源与 npm 包不会撞身份。**一个插件版本 = 一个 exact version**（严格 SemVer；范围、tag、部分版本一律拒绝）。**元数据快照来自 `package.json#mcpp`**，可声明 0..n 个成员：

| 成员 | 关键形状 | 约束 |
|---|---|---|
| agent | `id` / `name` / `description` | `id` 在同一包内唯一 |
| skill | `uri` / `name` / `description` | `uri` 必须匹配 `^skill://…/SKILL\.md$`——它是**引用**而非内容，市场既不抓取也不缓存技能正文，因此不接受 `http(s)://`（那会把市场变成任意 URL 的转发器） |
| MCP server | `id` / `transport` / `runtime` | 自由声明文本，**不含连接凭据** |

规范化器额外校验 `mcpp.schemaVersion === 1`（缺失合法）。成员数组是**展示与筛选**的依据：目录的「专家团队」= 含 agent 成员的包，「连接器」= 含 MCP server 成员的包。

## 2. 数据模型与不变量的承载

三张表归本包 `db/schema.ts`（唯一 owner，经 `./db` 出口公开）：

| 表 | 职责 |
|---|---|
| `plugin_market_package` | 聚合根：身份（`source_id` + `package_name`）、latest 指针（`latest_publication_id`）、授权归属列（`organization_id` / `owner_user_id` / `visibility`） |
| `plugin_market_publication` | 不可变快照：`exact_version`、`metadata_json`（落库字节原文）、`metadata_digest`、`published_at` / `first_published_at` / `unpublished_at`。**唯一业务写模块是 catalog 领域** |
| `plugin_market_admin_operation` | 审计流水：只追加不修改 |

不变量分两层承载，分界线是「Drizzle 能不能表达」：

- **存储层强保证**：复合外键（`(latest_publication_id, id)` → 版本表，保证 latest 只能指向**本包**版本）、唯一索引（同包同版本只能发布一次，也是 publish 幂等的兜底）、`CHECK (published_at >= first_published_at)`。
- **应用层 + 只读审计**：「latest 必须指向可见版本」「被 latest 指向的版本不得隐藏」由写入路径的顺序保证（**先移指针再置水印**），并由 `domain/invariants.ts` 的 `findInvariantViolations(state)` 独立检查。源项目用 PL/pgSQL 触发器表达这两条；本仓库迁移链全部由 Drizzle 生成、禁止手写 SQL 绕过，因此降为「应用层 + 可测断言」——**这是本模块唯一一处不变量从存储层降到应用层**，代价是绕过仓储直接改库不会被数据库拦住。

审计检查刻意只报违规、不改数据，且**一条缺陷只报一条消息**（规则 3 只在规则 1、2 通过后运行）：这三条被破坏时不会报任何错，只表现为「首页显示的版本不是最新版」「下架后包还在列表里」这类温和症状，没人会把它和一次发布操作联系起来。

`user` 是唯一的跨包外键目标（身份表归 `@fenix/identity/db`）；`organization_id` 刻意不加外键，与其它四张受控资源主表一致——组织删除的级联由身份模块负责。

## 3. 写路径：状态分派与逻辑时钟

发布请求按**库内该精确版本的状态**三分支（`facade.publish`）：

| 库内状态 | 动作 | 出网 | 效果 |
|---|---|---|---|
| 已可见 | `noop` | ✗ | 零写入、零副作用 |
| 已下架 | `restore` | ✗ | 复用冻结快照，`unpublished_at` 清空、`published_at` 前移到新的单调时刻、`first_published_at` 不变 |
| 不存在 | `publish` | ✓ | 重读私有源，与请求携带的 `previewDigest` 比对后落库 |

「不存在」分支的摘要比对不可省略：预览与确认之间私有源上的内容可能已变。不一致时抛 `PREVIEW_CHANGED`（409），**响应体带重新读到的快照与新摘要**，前端在原位重新确认——把这条冲突做成「请重新预览」的纯文案会丢掉刚读到的内容，用户只能盲重试。

下架（`unpublish`）指定的精确版本：若它是当前 latest，**先移指针再置水印**（指针回退到次新的可见版本）；版本不在市场里返回 404 `PUBLICATION_NOT_FOUND`。最后一个可见版本被下架后 `latest_publication_id` 为 NULL，整个包对非写权主体消失。

排序口径统一为 `published_at DESC, id DESC`。平局由 `id` 破，比较用字符串字面序而非 `localeCompare`：存储层的 `ORDER BY id DESC` 走字节序，两侧必须是同一种序，否则内存里选出的 latest 与 SQL 里的一条会不一致。读侧的展示投影复用同一个 `orderPublications`，避免「列表首位」与「latest 指针」在平局时指向不同版本。

## 4. 并发与事务

写路径的事务时序固定为三步，由 `services/plugin-catalog-service.ts` 与仓储共同保证：

1. **取事务级咨询锁**：`SELECT pg_advisory_xact_lock(hashtextextended('fenix:plugin-market:<sourceId>:<packageName>', 0))`。锁键带模块前缀限定命名空间，避免与其它模块的锁键碰撞（碰撞只会让互不相干的写互相等待，不影响正确性）；64 位哈希的碰撞概率可忽略。
2. **在锁内读聚合**：一次读完聚合根 + 它的全部版本行。规则只需要包内数据，分批查询只会把「读两次之间状态变了」的风险引入决策。
3. **在锁内按序执行写清单**：领域决策在纯函数里产出 `CatalogWrite[]`，仓储按数组顺序执行——顺序本身是语义（先移指针再置水印）。

`pg_advisory_xact_lock` 而不是会话级锁：事务结束即释放，连接归还池时不会留下未释放的锁。事务边界在 service、语句在 repository，因此仓储经 `src/server/db.ts` 的 `getPluginMarketDatabase()` 在**每个方法内**取句柄（模块加载早于宿主基础设施初始化），并能声明它需要的事务句柄类型。

**领域规则是纯函数**（`domain/catalog.ts` 的 `CatalogDecision` + `CatalogWrite[]`），这是移植期最重要的结构决定：测试进程不连 Postgres，把规则写进 SQL 等于让幂等、latest 回退、逻辑时钟、三条不变量失去可执行断言。写成纯函数后，「`noop` 零副作用」是一条可断言的性质（清单为空）。生产侧的事务时序由 `plugin-catalog-store.test.ts` 用「记录调用序 + 预制行」的替身 DB 单独钉住（含**锁必须早于任何读**）。

## 5. 授权模型：平台全局目录

仓库的授权实现没有「无归属组织」的资源模式，因此市场用**既有语义**表达全局目录，不改造平台核心：

- 全部条目的 `organization_id` 固定为**系统托管租户**（身份表 `slug = 'admin'`），由 Facade 在创建期经 `IdentityDirectory.resolveSystemTenant()` 解析后随 INSERT 写入。**不接受浏览器传入**——否则实际平台管理员的 active organization 会泄漏成归属组织，同一份全局目录会被切散到多个组织下。
- `visibility = 'public'`（本表默认即 public，见下）+ `publicDefaultActions: ["read"]` 打开**任意已认证主体**的读权限，这条分支不依赖任何 actor 条件。
- `memberDefaultActions: ["read"]`：普通成员只读，不因「同组织」而获得写权。
- 写路径**不接受 actor**：它只从管理面进入，而管理面的调用方不是某个用户，是平台运维者——判据是路由守卫上的系统 API Key（`systemApiKeyAuth`），与 observer 的 `/api/system/logs`、sandbox 的 `/api/system/sandbox-pools` 同一类（「凭据本身就是判据」，见 `src/server/routes/api/system-plugin-market.ts` 的文件头）。归属组织与审计主体仍由 Facade 解析（`resolveWriterScope`）：归属是部署期事实，operator 取系统托管租户的 `userId`，因此写路径不产生「匿名写入」。**不在 Facade 里做第二遍角色判定**——两处各判一次正是「按钮按旧规则显示、写入按新规则拒绝」这类漂移的来源。

`visibility` 默认 `'public'` 是**本表的语义要求而不是宽松默认**：授权模块对组织资源的默认值是 `private`，照抄会让整个目录静默消失。写入 `visibility` 的位置在 `repositories/plugin-package.ts` 的 create-package 分支，那里有同款注释。

浏览面的读口径恒为公开面（`scope = "public"`），授权谓词由 `AccessControlModule` 产出后经 `listConstraint` 原样下推；管理面的列表与详情走 `scope = "all"`（含整包下架的条目）。**逐行 `access` 与页面级能力位（旧版 `canPublish`）都已撤除**：浏览面没有任何写入口，附上动作集合只会让前端渲染一个与真实判据无关的按钮；管理面能进来就能写，同样不需要逐行能力位。授权本身不受影响：`listConstraint` 已经把谓词编译进 SQL。

**读口径与可见性谓词**：包级条件（`latest_publication_id IS NOT NULL`）作为 `businessWhere` 下推给 `AuthorizedResourceQuery`，**不在应用层过滤**：应用层过滤会让 `total` 与 `items` 不一致。版本级**双重可见性**叠加（包级指针 + 版本级 `unpublished_at IS NOT NULL`）只作用于公开面。

## 6. 私有源读取边界

`src/server/npm-registry/` 四个文件分层：`types.ts`（白名单快照契约，见 §0.2）、`normalize.ts`（不可信 JSON → 快照）、`client.ts`（HTTP 细节）、`service.ts`（凭配置构造客户端，供 Facade 调用）。

规范化器保留源项目的全部边界：22 项 `LIMITS`、6 条 secret 正则（命中即拒，防止凭据被当作元数据搬进市场）、**迭代式**深度探测（`maxJsonDepth: 12`，不用递归以免深嵌套打爆调用栈）、`name` / `version` 与请求全等、SRI 形状校验（`optionalIntegrity` 只校验形状——真 SRI 会被「≥64 连续 base64」的启发式误杀）、未知字段丢弃。包名与版本另有输入侧形状校验（npm 包名正则 + 严格 SemVer），不合法直接 `INVALID_INPUT`。

客户端只发读请求、只取 packument；超时经 `PLUGIN_MARKET_REGISTRY_TIMEOUT_MS` 控制，响应体上限经 `PLUGIN_MARKET_REGISTRY_MAX_BYTES` 控制（超出即 `METADATA_TOO_LARGE`），429 与网络故障分别映射为 `REGISTRY_RATE_LIMITED` 与 `REGISTRY_UNAVAILABLE`。`PLUGIN_MARKET_REGISTRY_TOKEN` 标 `secret: true`：不进日志、不进响应、不进错误消息。

**未配置私有源是能力整体不启用**（`PLUGIN_MARKET_REGISTRY_URL` 为 null → 发布与预览路径以 `REGISTRY_NOT_CONFIGURED` 失败，503），浏览既有快照不受影响。这与仓内既有口径一致（先例 `RCS_MODEL_GATEWAY_CREDENTIAL_ENCRYPTION_KEY`），也是五个 `PLUGIN_MARKET_*` 键全部 optional 的原因——`assembly-env.test.ts` 用空输入跑真实清单，任何 required 声明都会让整条 CE 装配线在启动期失败。

## 7. HTTP 契约

两条面、两条凭据族。**浏览面**两条读路由挂在宿主 `web-config` 槽（包内相对路径 `/config/plugin-market/*`），响应统一 `{ success, data }` / `{ success: false, error: { code, message } }`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/config/plugin-market/packages` | 公开口径全量列表（前端过滤），无逐行能力位 |
| GET | `/config/plugin-market/packages/:slug` | 详情：展示快照 + 版本历史（只含可见版本）；整包下架与不存在同响应 404 |

**管理面**六条挂在宿主 `api` 槽（`/api/system/plugin-market/*`，前缀是对外合同的一部分），受宿主系统 API Key 保护（`systemApiKeyAuth`，守卫由宿主注入），信封随平台口径：成功 `{ success: true, data }`、失败 `{ error }`（`ApiSystemErrorResponseSchema`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/system/plugin-market/packages` | 全量列表（含整包下架的条目，带 `hidden`） |
| GET | `/api/system/plugin-market/packages/:slug` | 详情：含已下架版本与 `unpublishedAt` 水印 |
| POST | `/api/system/plugin-market/publish/preview` | 读私有源并规范化，**不写库**，返回快照与 `metadataDigest` |
| POST | `/api/system/plugin-market/publish` | 按 §3 分派；`previewDigest` 缺失即拒绝 |
| POST | `/api/system/plugin-market/unpublish` | 下架精确版本 |
| POST | `/api/system/plugin-market/restore` | 恢复已下架版本（不出网） |

两条面的读路由都**永不访问私有源**：只有 `preview` 与「确认发布但库内没有该版本」会出网。两条面进**同一个 Facade**，不存在第二套业务实现；Facade 的方法按凭据族分组（浏览器收 `ActorContext`，管理面不收），混用是编译期错误而不是运行期约定。

错误码是**封闭清单**（`src/server/errors.ts`，11 个），只收本模块真的会抛的码：新增码必须同时有产出点与消费点，否则它就是死枚举。码 → 状态的映射用 `Record<PluginMarketErrorCode, number>`，新增码忘给状态会在 typecheck 期失败。

`PREVIEW_CHANGED` 是唯一一条 409，且响应体携带 `data.preview`（新快照 + 新摘要）——这不是「请求非法」而是「需要用户在新快照上重新确认」。平台信封里没有这个字段，因此管理面在 409 的 `response` 声明里单独给 schema（`systemPreviewChangedSchema`），否则 Elysia 会按 schema 把新快照清掉，前端拿到的冲突提示永远是空的。

路由导出的是**工厂而非实例**：`sessionAuth` / `systemApiKeyAuth` 宏与 `store.actor` 由宿主守卫写入，Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的子实例回填，因此两道守卫都必须由宿主注入（`PluginMarketRouteDependencies`）。包内不复制认证策略，用例注入替身。`requestId` 来自宿主 `derive`（`deriveRequestId`），随命令进审计流水；非宿主挂载取不到时为 `null`，不臆造标识。

## 8. 前端契约

**两条面，两个宿主路由**：控制台是**只读浏览**（`/agent/mcp?tab=npm`，会话凭据），管理台是**管理面板**（`/admin/plugin-market`，系统 master key）。用户看得到市场，管理在管理台——这条分界让浏览面不必知道「当前主体能不能写」，也就不需要写权探测、冲突处理与写后双刷新。

### 8.1 浏览面（控制台 tab）

- 单页 master-detail（与 mcp / skill / 知识库同形），**不新增详情路由**：市场是单页目录，页内切换选中项，刷新与浏览器历史都不需要第二层路由参与。
- **挂载点是「插件市场」页的第二个 tab，不是独立导航项**。npm 市场与 MCP 市场同处宿主路由 `/agent/mcp`，tab 状态放 URL（`?tab=npm`；缺省即 MCP），侧栏因此只有一项「插件市场」。tab 状态与 tab 栏归宿主路由壳，壳只做 `lazy()` 装配、**不取数**；两个市场各自保留完整的 `AppPage` + `AppHeader`（内容区是 flex 容器，不构成嵌套滚动）。
- 结构：`AppPage` → `AppHeader`（标题）→ `ScopeFilterBar`（关键词 + 全部/专家团队/连接器）→ `AgentMasterDetailWorkspace`（左目录 / 右详情）。范围没有「已下架」这一档：公开口径里不存在这类条目（那一档只在管理面）。
- **列表与详情分两次请求**，详情的定位符取自 `resolveSelectedPackage` 的解析结果——与左侧高亮用同一个纯函数，避免「高亮 A、右侧是 B」。
- 六态：loading / empty / empty-search / error / retry / 无权限（**不给重试**，403 是永久拒绝、401 需重新登录，重试不会改变授权结果）。
- **没有任何写入口**：`web/pages/agent-panel/**` 的值导入图不可达管理面的 API、写逻辑与管理页，由 `plugin-market-browser-surface.test.ts` 走一遍浏览面子图来钉。

### 8.2 管理面（管理台页）

- 宿主路由 `/admin/plugin-market`（懒加载 `AdminPluginMarketPage`），侧栏项取包字典的 `admin.nav`。页面外壳沿管理台的既有形态：`AdminKeyGate` 门（master key 存 sessionStorage、不落日志），面板内任意请求返回 401 / 403（`request()` 归一为 `UNAUTHORIZED`）即清 key 并带提示回门。
- **口径是全量的**（含整包下架的条目），筛选比浏览面多一档「已下架」（`filterAdminPackages` 在浏览面口径上做加法，判据只有一处定义）。
- 展示件与浏览面共用（`web/components/plugin-market-detail`）：同一个条目对谁都是市场里冻结的同一份快照。版本历史在此**注入写动作列**（下架 / 恢复），浏览面不传这个槽。
- 写动作**不做 `unwrap`**：`preview` / `publish` / `unpublish` / `restore` 显式判断 `success`，因为 409 `PREVIEW_CHANGED` 必须把新快照交回弹窗；`readPreviewChangedPayload` 逐字段校验后再渲染，畸形响应不会被画到界面上。凭据失效在写路径上表现为**信封里的码**（`isAccessDeniedCode`），`instanceof ApiError` 那一层对信封恒为 false。
- 发布弹窗是两步：填包名与精确版本 → 预览（展示即将公开的字段与成员数）→ 确认。冲突时原地换成新快照并提示重新确认，不关闭弹窗、不清空输入。表单与流程态靠容器每次打开自增的 `key` 重置（不写 `reset()`）。
- 下架与恢复走二次确认（`ConfirmDialog`），定位符在**点击那一刻**捕获，与用户点的那一行严格一致。
- 写成功后**列表与详情一起刷新**（写入会改变顺序与展示快照），并把选中项切到刚写入的条目。`noop` 的文案与 `publish` 不同——否则用户会以为私有源上的新内容已经进了市场。
- **不广播 `dispatchConfigChange`**：市场条目不是 Agent 的运行时配置，改它不影响任何 agent 进程的启动参数（对比 skill / mcp 的写入会改变 agent 可用能力清单）。
- 所有渲染字段都来自市场内冻结的快照，页面不读私有源；`tarballUrl` 只作溯源文本渲染。

## 9. 装配与登记

- `fenix.module.ts`：`dependsOn: []`（`src/**` 只值导入 `@fenix/platform-sdk` 与包内自引用）、`accessControlBindings`（`plugin_package_resource.ts` 的 storage 绑定）、`envDefinitions` 五键、`contributions` 两条路由（浏览面挂 `web-config` 槽、管理面挂 `api` 槽）；**不声明 `web`**——该字段要求 `web.id` 与一个导航项 id 同名，而本市场不是侧栏项，两条页面（控制台 tab 与管理台页）都由宿主路由壳直接 import 本包 `./web` 出口（与 `channel` / `prod-view` 同形：有宿主路由、无导航项）。管理台那条路由自带宿主侧栏项，但导航项归宿主布局声明（`apps/web/src/routes/admin.tsx`），不走模块 `web` 贡献。
- `src/module.ts` 的 `createPluginMarketModule(context)` 是 registry 的 `create` 目标：从 `context.modules` 取 access-control 端口、从 `@fenix/platform-sdk/server` 取身份目录，转交 `src/server/module.ts` 的真实构造，并 `install` 进进程级槽位（路由与测试都经 `getPluginMarketModule()` 读同一份结果）。
- 装配结果**只暴露 Facade**，不暴露 Domain Service：市场没有系统初始化写入路径，任何写入口都必须经过授权编排。
- 宿主登记：根 `package.json` 与 `apps/web/package.json` 各一条 workspace 依赖、`drizzle.config.ts` 的 schema 数组、`deploy/assembly/ce.json` 的 `resources` 数组（**`web` 数组里没有本包**——见上一段）、`apps/web/src/i18n/index.ts` 的 NS 与语言资源、`apps/web/src/routes/agent/_panel/mcp.tsx` 里 npm tab 的 `lazy()` 取页（控制台）、`apps/web/src/routes/admin/plugin-market.tsx` 与 `apps/web/src/routes/admin.tsx` 的导航项（管理台，见 §8.2）。
- 生成物（跑脚本，不手改）：`apps/generated/module-registry.ts`、`apps/generated/web-contributions.ts`。

## 10. 已知取舍与升级条件

| 取舍 | 现状 | 升级条件 |
|---|---|---|
| 全局目录不是一等 `platform` ownershipMode | 用「系统托管租户 + public 可见性」表达，代价是授权模块只知道「系统租户的这个资源」 | 出现第二个独立全局目录，或需要把市场从组织叙事里摘出去时，给 `@fenix/access-control` 加 `platform` 模式 |
| 两条 latest 不变量在应用层 | Drizzle 无触发器的一等表达，禁止手写 SQL 绕过 | 出现绕过仓储的写路径，或需要数据库层防御时 |
| 列表全量返回 + 前端过滤 | 与仓内其它五个目录页一致；源项目的 `clampLimit` / `clampOffset` 未移植 | 市场规模增长到前端过滤不可用时，先评估 `pg_trgm` 扩展是否值得 |
| 不搬 `http-source` 第二来源 | `source_id` 已为此保留身份维度，新增来源不需要改聚合根 | 需要 MCP over HTTP 发现时，作为独立切片追加（快照契约需同步扩字段） |
| 不搬静态页生成 | SPA 架构下「下架版本绝不被读路径返回」由可见性谓词保证 | 需要匿名公网只读站时，属独立部署议题（渲染面、限流、CSP） |
| 市场没有对外 `/api` 面 | 发布与下架是平台管理动作，只经管理台（`/api/system/plugin-market/*`，系统 API Key）发生 | 需要程序化发布时，先定义对外契约与鉴权口径（管理面是**平台内**面孔，不能直接当对外契约） |
